import { DeviceState, InputState, TrackState, inputRoles, instruments } from "common";
import { LiveStore } from "../store";
import { BandAnalysis, BarRecord, InputBar, analyzeBand } from "./analyze";
import { AudioNotes } from "./audio";
import { ClipAnchor, InputClip, anchorClip, clipNotesInBar } from "./clips";
import { beatsPerBar, estimateSongTime, msPerBeat } from "./clock";
import { loadConfig } from "./config";
import { InputInfo, Recorder, parseOsc } from "./listen";
import { clamp, noteName } from "./music";
import { LiveOps } from "./ops";
import { Player, PlayerSettings, Timing } from "./player";
import { createProvider } from "./providers";

const TICK_MS = 15;
const HISTORY_BARS = 32;
const ANALYSIS_BARS = 16;
const STATUS_REFRESH_MS = 1000;

interface InputMeta {
  deviceId: number;
  trackId: number;
  trackName: string;
  kind: "midi" | "audio";
  role: InputState["role"];
  on: boolean;
  /** Level in dB below which an audio input hears no note. */
  threshold: number;
}

const param = (device: DeviceState, name: string, fallback: number) => {
  const value = device.session?.params[name]?.value;
  return value === undefined || !Number.isFinite(value) ? fallback : Math.round(value);
};

const playerSettings = (track: TrackState, device: DeviceState): PlayerSettings => {
  const energy = clamp(param(device, "SP Energy", 0), 0, 10);
  return {
    deviceId: device.id,
    trackId: track.id,
    trackName: track.name,
    color: parseInt(track.color.slice(1), 16) || 0,
    instrument: instruments[clamp(param(device, "SP Instrument", 1), 0, instruments.length - 1)],
    active: device.isActive && param(device, "SP Active", 1) >= 1,
    lookahead: clamp(param(device, "SP Lookahead", 1), 1, 4),
    length: [1, 2, 4][clamp(param(device, "SP Length", 0), 0, 2)],
    join: clamp(param(device, "SP Join", 1), 0, 4),
    energy: energy === 0 ? "auto" : energy,
  };
};

/**
 * Runs the Session Players: listens to the Session Input devices over OSC,
 * keeps count of bars while Live plays, analyzes what the band played, and
 * drives one Player per Session Player device found in the set.
 */
export class SessionEngine {
  private config = loadConfig();
  private provider = createProvider(this.config);
  private recorder = new Recorder();
  private players = new Map<number, Player>();
  private inputs = new Map<number, InputMeta>();
  /** Note detection for each audio input, from its pitch readings. */
  private audio = new Map<number, AudioNotes>();
  /** The clip playing on each input's track (by track id), tied to the bars counted here. */
  private clips = new Map<number, { clip: InputClip; anchor: ClipAnchor }>();
  private history: BarRecord[] = [];
  private analysis?: BandAnalysis;
  /** Bar counted from when playback started (1-based); 0 while stopped. */
  private bar = 0;
  private songBar = 0;
  private barStartBeat = 0;
  private wasPlaying = false;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private lastPublish = 0;

  constructor(private store: LiveStore, private ops: () => LiveOps | undefined) {}

  start = async () => {
    this.store.subscribe((change) => {
      if (change === "tracks") this.reconcile();
      if (change === "clips") this.anchorClips();
    });
    this.reconcile();
    try {
      await Bun.udpSocket({
        hostname: "127.0.0.1",
        port: this.config.oscPort,
        socket: { data: (_socket, data) => this.onPacket(data) },
      });
    } catch (error) {
      console.error(`[session] Couldn't listen for Session Input on UDP ${this.config.oscPort}:`, error);
    }
    setInterval(this.tick, TICK_MS);
    console.info(`[session] Decisions by ${this.provider.name}; listening for Session Input on UDP ${this.config.oscPort}.`);
  };

  private onPacket = (data: Uint8Array) => {
    const message = parseOsc(data);
    if (!message) return;
    if (message.type === "hello") {
      const wasConnected = this.recorder.isConnected(message.deviceId);
      this.recorder.hello(message.deviceId);
      if (!wasConnected) this.publish();
      return;
    }
    this.recorder.hello(message.deviceId);
    if (message.type === "note") {
      this.recorder.push({ ...message, receivedAt: performance.now() });
      return;
    }
    const notes = this.audioNotes(message.deviceId);
    if (message.type === "onset") notes.onset(message.beat);
    else notes.frame(message.hz, message.amplitude, message.beat, this.inputs.get(message.deviceId)?.threshold ?? -40);
  };

  private audioNotes = (deviceId: number) => {
    let notes = this.audio.get(deviceId);
    if (!notes) {
      notes = new AudioNotes((event) => this.recorder.push({ deviceId, ...event, receivedAt: performance.now() }));
      this.audio.set(deviceId, notes);
    }
    return notes;
  };

  /** Matches players and inputs to the Session devices currently in the set. */
  private reconcile = () => {
    const seenPlayers = new Set<number>();
    this.inputs.clear();
    for (const track of this.store.state.tracks) {
      const playerDevice = track.devices.find((device) => device.session?.kind === "player");
      if (playerDevice) {
        seenPlayers.add(playerDevice.id);
        const settings = playerSettings(track, playerDevice);
        const player = this.players.get(playerDevice.id);
        if (player) player.update(settings);
        else this.addPlayer(settings);
        // An input on the player's own track would hear the player itself.
        continue;
      }
      for (const device of track.devices) {
        if (device.session?.kind !== "input") continue;
        this.inputs.set(device.id, {
          deviceId: device.id,
          trackId: track.id,
          trackName: track.name,
          kind: device.type === "audio_effect" ? "audio" : "midi",
          role: inputRoles[clamp(param(device, "SPI Role", 0), 0, inputRoles.length - 1)],
          on: device.isActive && param(device, "SPI On", 1) >= 1,
          threshold: device.session.params["SPI Threshold"]?.value ?? -40,
        });
      }
    }
    for (const id of [...this.players.keys()]) if (!seenPlayers.has(id)) this.players.delete(id);
    this.publish();
  };

  private addPlayer = (settings: PlayerSettings) => {
    const player = new Player(settings, {
      config: this.config,
      provider: this.provider,
      ops: this.ops,
      analyze: this.analyzeNow,
      transport: () => this.store.state.transport,
      timing: this.timing,
      onChange: this.publish,
    });
    if (this.wasPlaying) player.start();
    this.players.set(settings.deviceId, player);
  };

  /**
   * Ties each newly read clip to the bars counted here, right away: song time
   * can jump back when the arrangement loops, but bars keep counting.
   */
  private anchorClips = () => {
    const { inputClips } = this.store;
    for (const trackId of [...this.clips.keys()]) if (!inputClips.has(trackId)) this.clips.delete(trackId);
    if (!this.wasPlaying) return;
    inputClips.forEach((clip, trackId) => {
      if (this.clips.get(trackId)?.clip === clip) return;
      this.clips.set(trackId, { clip, anchor: anchorClip(clip, this.bar, this.barStartBeat) });
    });
  };

  /** What the clips on the inputs' tracks will play in a bar, for the inputs that are on. */
  private upcoming = (index: number): InputBar[] => {
    const bpb = beatsPerBar(this.store.state.transport);
    return [...this.inputs.values()].flatMap((input) => {
      const playing = this.clips.get(input.trackId);
      if (!input.on || input.kind !== "midi" || !playing) return [];
      const notes = clipNotesInBar(playing.clip, playing.anchor, index, bpb);
      return [{ deviceId: input.deviceId, trackName: input.trackName, role: input.role, notes }];
    });
  };

  private inputInfos = (): InputInfo[] => {
    return [...this.inputs.values()].filter((input) => input.on).map(({ deviceId, trackName, role }) => ({ deviceId, trackName, role }));
  };

  private timing = (): Timing => {
    const { transport } = this.store.state;
    const bpb = beatsPerBar(transport);
    const now = estimateSongTime(transport, this.store.songTimeAt);
    return {
      playing: this.wasPlaying,
      bar: this.bar,
      beatInBar: clamp(now - this.barStartBeat, 0, bpb),
      beatsPerBar: bpb,
      msPerBeat: msPerBeat(transport),
    };
  };

  /** Analysis of the recent bars plus what's been heard of the current one. */
  private analyzeNow = () => {
    const { transport } = this.store.state;
    const bpb = beatsPerBar(transport);
    const now = estimateSongTime(transport, this.store.songTimeAt);
    const partial = this.recorder.peekBar(this.bar, this.barStartBeat, bpb, this.inputInfos(), now);
    return analyzeBand([...this.history.slice(-ANALYSIS_BARS), partial], this.upcoming);
  };

  private tick = () => {
    const { transport, status } = this.store.state;
    const playing = transport.isPlaying && status === "connected";
    if (!playing) {
      if (this.wasPlaying) this.onStop();
    } else {
      const bpb = beatsPerBar(transport);
      const songBar = Math.floor(estimateSongTime(transport, this.store.songTimeAt) / bpb + 1e-9);
      if (!this.wasPlaying) this.onStart(songBar, bpb);
      else if (songBar !== this.songBar) this.onBar(songBar, bpb);
    }
    const beat = estimateSongTime(transport, this.store.songTimeAt);
    this.audio.forEach((notes) => notes.idle(beat));
    this.players.forEach((player) => player.tick());
    if (performance.now() - this.lastPublish > STATUS_REFRESH_MS && (this.inputs.size || this.players.size)) this.publish();
  };

  private onStart = (songBar: number, bpb: number) => {
    this.wasPlaying = true;
    this.bar = 1;
    this.songBar = songBar;
    this.barStartBeat = songBar * bpb;
    this.history = [];
    this.analysis = undefined;
    this.recorder.reset();
    this.clips.clear();
    this.anchorClips();
    this.players.forEach((player) => player.start());
    this.publish();
  };

  private onBar = (songBar: number, bpb: number) => {
    const staleMs = 3 * bpb * msPerBeat(this.store.state.transport);
    const record = this.recorder.closeBar(this.bar, this.barStartBeat, bpb, this.inputInfos(), staleMs);
    this.history = [...this.history, record].slice(-HISTORY_BARS);
    this.analysis = analyzeBand(this.history.slice(-ANALYSIS_BARS), this.upcoming);
    this.bar++;
    this.songBar = songBar;
    this.barStartBeat = songBar * bpb;
    this.publish();
  };

  private onStop = () => {
    this.wasPlaying = false;
    this.bar = 0;
    this.clips.clear();
    this.players.forEach((player) => player.stop());
    this.publish();
  };

  /** Sends session state to the web app, at most once per event-loop turn. */
  private publish = () => {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.lastPublish = performance.now();
      const analysis = this.analysis;
      const lastRecord = this.history[this.history.length - 1];
      const complete = analysis?.bars.filter((bar) => !bar.partial) ?? [];
      this.store.setSession({
        bar: this.bar,
        key: analysis?.key?.name,
        chords: complete.slice(-8).map((bar) => analysis?.chordAt(bar.index).chord?.symbol ?? "–"),
        predictedChord: this.bar && analysis ? analysis.chordAt(this.bar + 1).chord?.symbol : undefined,
        players: [...this.players.values()].map((player) => player.state()),
        inputs: [...this.inputs.values()].map((input) => {
          const notes = lastRecord?.inputs.find((bar) => bar.deviceId === input.deviceId)?.notes ?? [];
          return {
            ...input,
            connected: this.recorder.isConnected(input.deviceId),
            lastNotes: [...new Set(notes.filter((note) => !note.held).map((note) => noteName(note.pitch)))],
          };
        }),
      });
    }, 0);
  };
}

import fs from "fs/promises";
import {
  DeviceState,
  Instrument,
  InputState,
  MAX_DIRECTION_LENGTH,
  SpeechState,
  TimelineBar,
  TrackState,
  inputRoles,
  instruments,
} from "common";
import { LiveStore } from "../store";
import { BandAnalysis, BarRecord, InputBar, analyzeBand } from "./analyze";
import { AudioNotes } from "./audio";
import { ClipAnchor, InputClip, anchorClip, clipNotesInBar } from "./clips";
import { beatsPerBar, estimateSongTime, msPerBeat } from "./clock";
import { loadConfig } from "./config";
import { profileInstrument } from "./instrument";
import { InputInfo, Recorder, parseOsc } from "./listen";
import { clamp, compactNote, liveNoteName } from "./music";
import { LiveOps } from "./ops";
import { Player, PlayerSettings, Timing } from "./player";
import { createProvider } from "./providers";
import { Transcriber, voiceFile } from "./voice";

const TICK_MS = 15;
const HISTORY_BARS = 32;
const ANALYSIS_BARS = 16;
const STATUS_REFRESH_MS = 1000;
/** Loading a rack changes a track's devices several times in a row; read the instrument once it settles. */
const INSTRUMENT_SETTLE_MS = 400;
/** Phrases kept for the players and the web page. */
const SPEECH_KEPT = 8;
/** Bars of what the inputs played sent to the web page's timeline. */
const TIMELINE_BARS = 16;
/** While notes arrive, the web page is updated this often at most. */
const NOTE_PUBLISH_MS = 200;

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

interface VoiceMeta {
  deviceId: number;
  trackId: number;
  trackName: string;
  on: boolean;
}

const isListener = (device: DeviceState) => device.session?.kind === "input" || device.session?.kind === "voice";

const param = (device: DeviceState, name: string, fallback: number) => {
  const value = device.session?.params[name]?.value;
  return value === undefined || !Number.isFinite(value) ? fallback : Math.round(value);
};

/** "SP Instrument" is Drums, Bass, Keys, Guitar or Auto (added last, so older devices keep their setting). */
const instrumentSetting = (device: DeviceState): Instrument | "auto" => {
  const setting = device.session?.params["SP Instrument"];
  if (!setting) return "auto";
  const index = Math.round(setting.value);
  if (setting.label === "Auto" || index >= instruments.length) return "auto";
  return instruments[clamp(index, 0, instruments.length - 1)];
};

const playerSettings = (track: TrackState, device: DeviceState): PlayerSettings => {
  const energy = clamp(param(device, "SP Energy", 0), 0, 10);
  return {
    deviceId: device.id,
    trackId: track.id,
    trackName: track.name,
    color: parseInt(track.color.slice(1), 16) || 0,
    instrument: instrumentSetting(device),
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
  /** Session Voice devices, which record what's said or sung on their track. */
  private voices = new Map<number, VoiceMeta>();
  /** Recent phrases from the voices, newest first. */
  private speech: SpeechState[] = [];
  private transcriber: Transcriber;
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
  private notePublishTimer?: ReturnType<typeof setTimeout>;
  private lastPublish = 0;
  /** The devices after each player's device, to notice when its instrument changes. */
  private instrumentKeys = new Map<number, string>();
  private instrumentTimer?: ReturnType<typeof setTimeout>;
  private staleInstruments = new Set<number>();
  /** The musician's style direction, from the web page. */
  private direction = "";

  constructor(private store: LiveStore, private ops: () => LiveOps | undefined) {
    this.transcriber = new Transcriber(this.config.voice, () => this.publish());
  }

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

  /**
   * Turns what the players hear of a track on or off from the web page: the
   * On switch of each Session Input and Session Voice on it, so Live stays the
   * source of truth.
   */
  setListening = (trackId: number, on: boolean) => {
    const ops = this.ops();
    const track = this.store.state.tracks.find((t) => t.id === trackId);
    if (!ops || !track) return;
    for (const device of track.devices.filter(isListener)) {
      const param = device.session!.kind === "voice" ? "SPV On" : "SPI On";
      ops.setSessionParam(device.id, param, on ? 1 : 0).catch((error) => {
        console.error(`[session] Couldn't turn ${device.name} on ${track.name} ${on ? "on" : "off"}:`, error);
      });
    }
  };

  /** Everything about a player's decision for a bar, for the dashboard. */
  decisionDetail = (deviceId: number, bar: number) => this.players.get(deviceId)?.detail(bar);

  /** Sets the style direction; it's used from the next decision on. */
  setDirection = (text: string) => {
    this.direction = text.trim().slice(0, MAX_DIRECTION_LENGTH);
    console.info(this.direction ? `[session] Direction: "${this.direction}"` : "[session] Direction cleared");
    this.publish();
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
    if (message.type === "voice") {
      void this.onVoice(message.deviceId, message.take);
      return;
    }
    if (this.wasPlaying) this.publishSoon();
    if (message.type === "note") {
      this.recorder.push({ ...message, receivedAt: performance.now() });
      return;
    }
    const notes = this.audioNotes(message.deviceId);
    if (message.type === "onset") notes.onset(message.beat);
    else notes.frame(message.hz, message.amplitude, message.beat, this.inputs.get(message.deviceId)?.threshold ?? -40);
  };

  /** A Session Voice device recorded a phrase: transcribe it and pass it on to the players. */
  private onVoice = async (deviceId: number, take: number) => {
    const file = voiceFile(deviceId, take);
    const voice = this.voices.get(deviceId);
    if (!voice?.on) {
      await fs.rm(file, { force: true });
      return;
    }
    const bar = this.bar;
    const heardAt = Date.now();
    try {
      const text = await this.transcriber.transcribe(file);
      if (!text) return;
      console.info(`[voice] ${voice.trackName}${bar ? ` (bar ${bar})` : ""}: "${text}"`);
      this.speech = [{ text, trackName: voice.trackName, bar, at: heardAt }, ...this.speech].slice(0, SPEECH_KEPT);
      this.publish();
    } catch (error) {
      console.error(`[voice] Couldn't transcribe ${voice.trackName}:`, error);
    }
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
    this.voices.clear();
    for (const track of this.store.state.tracks) {
      const playerDevice = track.devices.find((device) => device.session?.kind === "player");
      if (playerDevice) {
        seenPlayers.add(playerDevice.id);
        const settings = playerSettings(track, playerDevice);
        const player = this.players.get(playerDevice.id);
        if (player) player.update(settings);
        else this.addPlayer(settings);
        const after = track.devices.slice(track.devices.indexOf(playerDevice) + 1);
        const key = after.map((device) => `${device.id}:${device.name}:${device.isActive}`).join(",");
        if (this.instrumentKeys.get(playerDevice.id) !== key) {
          this.instrumentKeys.set(playerDevice.id, key);
          this.readInstrumentsSoon([playerDevice.id]);
        }
        // An input on the player's own track would hear the player itself.
        continue;
      }
      for (const device of track.devices) {
        if (device.session?.kind === "voice") {
          this.voices.set(device.id, {
            deviceId: device.id,
            trackId: track.id,
            trackName: track.name,
            on: device.isActive && param(device, "SPV On", 1) >= 1,
          });
        }
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
    for (const id of [...this.players.keys()]) {
      if (seenPlayers.has(id)) continue;
      this.players.delete(id);
      this.instrumentKeys.delete(id);
    }
    if (this.voices.size) void this.transcriber.ensureStarted();
    this.publish();
  };

  /** Reads the instrument after each of these players' devices, once the devices settle. */
  private readInstrumentsSoon = (deviceIds: number[]) => {
    deviceIds.forEach((id) => this.staleInstruments.add(id));
    clearTimeout(this.instrumentTimer);
    this.instrumentTimer = setTimeout(this.readInstruments, INSTRUMENT_SETTLE_MS);
  };

  private readInstruments = async () => {
    const ops = this.ops();
    // Not connected yet: try again shortly.
    if (!ops) return this.readInstrumentsSoon([]);
    const ids = [...this.staleInstruments];
    this.staleInstruments.clear();
    for (const id of ids) {
      const player = this.players.get(id);
      if (!player) continue;
      try {
        const raw = await ops.instrument(player.settings.trackId, id);
        const profile = raw && profileInstrument(raw);
        player.setInstrument(profile);
        console.info(`[session] ${player.settings.trackName}: ${profile ? profile.summary : "no instrument after the Session Player"}`);
      } catch (error) {
        console.error(`[session] Couldn't read ${player.settings.trackName}'s instrument:`, error);
        this.staleInstruments.add(id);
      }
    }
  };

  private addPlayer = (settings: PlayerSettings) => {
    const player = new Player(settings, {
      config: this.config,
      provider: this.provider,
      ops: this.ops,
      analyze: this.analyzeNow,
      transport: () => this.store.state.transport,
      timing: this.timing,
      direction: () => this.direction,
      speech: () => this.speech,
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

  /** The bar in progress, as heard so far. */
  private currentBar = () => {
    const { transport } = this.store.state;
    const now = estimateSongTime(transport, this.store.songTimeAt);
    return this.recorder.peekBar(this.bar, this.barStartBeat, beatsPerBar(transport), this.inputInfos(), now);
  };

  /** Analysis of the recent bars plus what's been heard of the current one. */
  private analyzeNow = () => analyzeBand([...this.history.slice(-ANALYSIS_BARS), this.currentBar()], this.upcoming);

  /**
   * What the inputs played in the last bars, with the bar in progress, for the
   * dashboard. Stopped, it's the last take's bars, until Play starts a new one.
   */
  private timeline = (): TimelineBar[] => {
    const partial = this.bar ? this.currentBar() : undefined;
    const complete = this.history.slice(-(partial ? TIMELINE_BARS - 1 : TIMELINE_BARS));
    const records = partial ? [...complete, partial] : complete;
    if (!records.length) return [];
    const analysis = partial ? analyzeBand([...this.history.slice(-ANALYSIS_BARS), partial], this.upcoming) : analyzeBand(this.history.slice(-ANALYSIS_BARS));
    return records.map((record) => ({
      bar: record.index,
      beatsPerBar: record === partial ? beatsPerBar(this.store.state.transport) : record.beatsPerBar,
      ...(record === partial && { partial: true }),
      chord: analysis.chordAt(record.index).chord?.symbol,
      heard: Object.fromEntries(
        record.inputs.map((input) => [
          input.deviceId,
          input.notes.map((note) => compactNote(note.pitch, note.start, note.duration, note.velocity, note.held)),
        ])
      ),
    }));
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
    if (performance.now() - this.lastPublish > STATUS_REFRESH_MS && (this.inputs.size || this.players.size || this.voices.size)) this.publish();
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
    // Bars count from Play: anything said so far came before this take.
    this.speech = this.speech.map((said) => ({ ...said, bar: 0 }));
    this.anchorClips();
    this.players.forEach((player) => player.start());
    // A sample dropped on a pad or a new preset doesn't change the device list; read again on each Play.
    this.readInstrumentsSoon([...this.players.keys()]);
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

  /** Publishes soon, so the bar in progress fills in on the web page as notes arrive. */
  private publishSoon = () => {
    if (this.notePublishTimer) return;
    this.notePublishTimer = setTimeout(() => {
      this.notePublishTimer = undefined;
      this.publish();
    }, NOTE_PUBLISH_MS);
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
        direction: this.direction,
        key: analysis?.key?.name,
        chords: complete.slice(-8).map((bar) => analysis?.chordAt(bar.index).chord?.symbol ?? "–"),
        predictedChord: this.bar && analysis ? analysis.chordAt(this.bar + 1).chord?.symbol : undefined,
        players: [...this.players.values()].map((player) => player.state()),
        inputs: [...this.inputs.values()].map((input) => {
          const notes = lastRecord?.inputs.find((bar) => bar.deviceId === input.deviceId)?.notes ?? [];
          return {
            ...input,
            connected: this.recorder.isConnected(input.deviceId),
            lastNotes: [...new Set(notes.filter((note) => !note.held).map((note) => liveNoteName(note.pitch)))],
          };
        }),
        voices: [...this.voices.values()].map((voice) => ({ ...voice, connected: this.recorder.isConnected(voice.deviceId) })),
        speech: this.speech,
        transcriber: this.transcriber.state,
        timeline: this.timeline(),
      });
    }, 0);
  };
}

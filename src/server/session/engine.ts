import fs from "fs/promises";
import {
  DeviceState,
  Instrument,
  InputState,
  MAX_DIRECTION_LENGTH,
  PlanDetail,
  PlannedBar,
  SessionState,
  SpeechState,
  TimelineBar,
  isDeviceStash,
  TrackState,
  inputRoles,
  instruments,
} from "common";
import { LiveStore } from "../store";
import { BandAnalysis, BarRecord, InputBar, analyzeBand } from "./analyze";
import { AudioNotes, toDb } from "./audio";
import { AudioMode, ChromaNotes } from "./chroma";
import { ClipAnchor, InputClip, anchorClip, clipNotesInBar } from "./clips";
import { beatsPerBar, estimateSongTime, msPerBeat } from "./clock";
import { loadConfig } from "./config";
import { profileInstrument } from "./instrument";
import { InputInfo, OscMessage, Recorder, parseOsc } from "./listen";
import { clamp, compactNote, liveNoteName } from "./music";
import { LiveOps } from "./ops";
import { BandPlan, PlanRequest, describeBand, phraseStart, planFromAnswers } from "./plan";
import { Player, PlayerSettings, Timing } from "./player";
import { createProvider } from "./providers";
import { AuditionError, ReviewRequest, auditionPattern, reviewPatterns } from "./review";
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
  /** Chord detection for each audio input, from FluCoMa's chroma and onsets. */
  private chroma = new Map<number, ChromaNotes>();
  /** How each audio input is heard right now: single notes, chords or hits. */
  private audioModes = new Map<number, AudioMode>();
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
  private notice?: SessionState["notice"];
  /** Tracks an input is being added to, so a double click adds one. */
  private adding = new Set<number>();
  /** The band plan (see plan.ts), and what it said for each bar as that bar came. */
  private plan?: BandPlan;
  private plannedBars = new Map<number, PlannedBar>();
  private planDetails = new Map<number, PlanDetail>();
  /** A plan is being made; `planAgain` is where the next one starts, if asked for meanwhile. */
  private planning = false;
  private planAgain?: number;
  private planCalls = 0;
  private planProblem?: string;
  /** Bumped on Play and Stop, so a plan from an earlier take is dropped. */
  private planRun = 0;
  /** What the last plan was made with, to notice when to plan again before its time. */
  private plannedWith?: { speechAt: number; direction: string; parts: string; energy: number };
  /** The clip slot each player's last audition went into, to reuse it. */
  private auditionSlots = new Map<number, number>();

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
    const listeners = track.devices.filter(isListener);
    if (!listeners.length && on) return void this.addInput(track);
    for (const device of listeners) {
      const param = device.session!.kind === "voice" ? "SPV On" : "SPI On";
      ops.setSessionParam(device.id, param, on ? 1 : 0).catch((error) => {
        console.error(`[session] Couldn't turn ${device.name} on ${track.name} ${on ? "on" : "off"}:`, error);
      });
    }
  };

  /** Everything about a player's decision for a bar, for the dashboard. */
  decisionDetail = (deviceId: number, bar: number) => this.players.get(deviceId)?.detail(bar);

  /** Everything about the band plan made in a bar. */
  planDetail = (decidedAt: number) => this.planDetails.get(decidedAt);

  /** A player's patterns for its loaded instrument, rendered for the Patterns tab. */
  patternReview = (deviceId: number, request: ReviewRequest) => {
    const player = this.players.get(deviceId);
    return player && reviewPatterns(player.patternSource(), this.store.state.transport, request);
  };

  /** Writes one of a player's patterns into a clip slot on its track, for the musician to launch in Live. */
  auditionPattern = async (deviceId: number, patternId: string, request: ReviewRequest) => {
    const player = this.players.get(deviceId);
    if (!player) throw new AuditionError("No such Session Player", 404);
    const ops = this.ops();
    if (!ops) throw new AuditionError("Not connected to Live", 503);
    const { transport } = this.store.state;
    const previous = this.auditionSlots.get(deviceId);
    const { slotId, ...result } = await auditionPattern(player.patternSource(), ops, transport, request, patternId, this.config.slots, previous);
    this.auditionSlots.set(deviceId, slotId);
    console.info(`[session] ${result.trackName}: "${result.clipName}" written into slot ${result.slot + 1} to audition`);
    return result;
  };

  /**
   * Puts the right Session Input first on a track that has none, copied from
   * the Session Devices track: Session Input Audio on an audio track, Session
   * Input on a MIDI track.
   */
  private addInput = async (track: TrackState) => {
    const ops = this.ops();
    if (!ops || this.adding.has(track.id) || (track.type !== "audio" && track.type !== "midi")) return;
    const name = track.type === "audio" ? "Session Input Audio" : "Session Input";
    const wanted = (device: DeviceState) =>
      device.session?.kind === "input" && device.type === (track.type === "audio" ? "audio_effect" : "midi_effect");
    const stash = this.store.state.tracks.find((t) => isDeviceStash(t.name) && t.devices.some(wanted));
    if (!stash) {
      return this.tell(`To add ${name} from here, keep a copy on a track named "Session Devices" (see the README), or drop it first on ${track.name} in Live.`, "error");
    }
    this.adding.add(track.id);
    try {
      await ops.copyDevice(stash.id, stash.devices.findIndex(wanted), track.id);
      this.tell(`Added ${name} as ${track.name}'s first device: the players hear it now.`, "info");
    } catch (error) {
      this.tell(`Couldn't add ${name} to ${track.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this.adding.delete(track.id);
    }
  };

  private tell = (text: string, tone: "info" | "error") => {
    (tone === "error" ? console.error : console.info)(`[session] ${text}`);
    this.notice = { text, tone, at: Date.now() };
    this.publish();
  };

  /** Sets the style direction; it's used from the next decision on. */
  setDirection = (text: string) => {
    this.direction = text.trim().slice(0, MAX_DIRECTION_LENGTH);
    console.info(this.direction ? `[session] Direction: "${this.direction}"` : "[session] Direction cleared");
    this.planSoon();
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
    this.onAudio(message);
  };

  /**
   * An audio input's readings: fzero~'s pitch and level (every 10 ms) and its
   * onsets, and with FluCoMa its chroma and spectral onsets. They become notes
   * the way the input is heard right now (see modeFor).
   */
  private onAudio = (message: Extract<OscMessage, { type: "pitch" | "onset" | "chroma" | "attack" }>) => {
    const { deviceId, beat } = message;
    const threshold = this.inputs.get(deviceId)?.threshold ?? -40;
    const notes = this.audioNotes(deviceId);
    const chords = this.chromaNotes(deviceId);
    if (message.type === "chroma") chords.frame(message.chroma, beat);
    const mode = this.switchMode(deviceId, beat);
    const strike = () => (mode === "notes" ? notes.onset(beat) : mode === "chords" ? chords.strum(beat) : chords.hit(beat));
    if (message.type === "pitch") {
      notes.frame(message.hz, message.amplitude, beat, threshold);
      chords.level(toDb(message.amplitude), threshold, beat);
    }
    if (message.type === "attack") strike();
    // fzero~'s onsets follow the level; FluCoMa's spectral ones, when it's there, are better.
    if (message.type === "onset" && !chords.isActive()) strike();
  };

  /**
   * Bass and melody are single notes and drums are hits; chords need FluCoMa's
   * chroma. On Auto, an input plays chords when the chroma keeps showing 3 or
   * more pitch classes.
   */
  private modeFor = (deviceId: number): AudioMode => {
    const role = this.inputs.get(deviceId)?.role;
    const chords = this.chroma.get(deviceId);
    if (role === "drums") return "hits";
    if (role === "bass" || role === "melody" || !chords?.isActive()) return "notes";
    return role === "chords" || chords.isPolyphonic() ? "chords" : "notes";
  };

  /** Moves an input to its current mode, ending what the old mode was holding. */
  private switchMode = (deviceId: number, beat: number) => {
    const previous = this.audioModes.get(deviceId) ?? "notes";
    const mode = this.modeFor(deviceId);
    if (mode !== previous) {
      // Released while the old mode still lets its notes through.
      if (previous === "notes") this.audioNotes(deviceId).release(beat);
      else this.chromaNotes(deviceId).release(beat);
      this.audioModes.set(deviceId, mode);
    }
    return mode;
  };

  private chromaNotes = (deviceId: number) => {
    let notes = this.chroma.get(deviceId);
    if (!notes) {
      notes = new ChromaNotes((event) => {
        if ((this.audioModes.get(deviceId) ?? "notes") !== "notes") this.recorder.push({ deviceId, ...event, receivedAt: performance.now() });
      });
      this.chroma.set(deviceId, notes);
    }
    return notes;
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
      this.planSoon();
      this.publish();
    } catch (error) {
      console.error(`[voice] Couldn't transcribe ${voice.trackName}:`, error);
    }
  };

  private audioNotes = (deviceId: number) => {
    let notes = this.audio.get(deviceId);
    if (!notes) {
      notes = new AudioNotes((event) => {
        if ((this.audioModes.get(deviceId) ?? "notes") === "notes") this.recorder.push({ deviceId, ...event, receivedAt: performance.now() });
      });
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
      // The spare devices waiting on the Session Devices track hear nothing.
      if (isDeviceStash(track.name)) continue;
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
      this.auditionSlots.delete(id);
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
      plan: () => this.plan,
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
    this.chroma.forEach((notes) => notes.idle(beat));
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
    this.planRun++;
    this.plan = undefined;
    this.plannedWith = undefined;
    this.planning = false;
    this.planAgain = undefined;
    this.plannedBars.clear();
    this.players.forEach((player) => player.start());
    this.requestPlan(1);
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
    // Each phrase is planned again as the one before it reaches its last bar,
    // or straight away when the band changes sharply.
    if (this.bar % this.config.phraseLength === 0) this.requestPlan(this.bar + 1);
    else if (this.plannedWith && this.bandChanged(this.analysis)) this.requestPlan(this.bar + 1);
    this.publish();
  };

  private onStop = () => {
    this.wasPlaying = false;
    this.bar = 0;
    this.clips.clear();
    this.planRun++;
    this.planning = false;
    this.players.forEach((player) => player.stop());
    this.publish();
  };

  /** The parts playing over the last 2 bars, so one bar's rest doesn't count as stopping. */
  private bandParts = (analysis?: BandAnalysis) => {
    const recent = analysis?.bars.filter((bar) => !bar.partial).slice(-2) ?? [];
    return JSON.stringify([...new Set(recent.flatMap((bar) => bar.parts.map((part) => part.deviceId)))].sort((a, b) => a - b));
  };

  /** A sharp change in the band, worth planning again for before the phrase ends: a part starting or stopping, or energy moving by 3. */
  private bandChanged = (analysis?: BandAnalysis) =>
    !!this.plannedWith &&
    (this.bandParts(analysis) !== this.plannedWith.parts || Math.abs((analysis?.energy ?? 0) - this.plannedWith.energy) >= 3);

  /** Plans again from the next bar, after something was said or the Style changed. */
  private planSoon = () => {
    if (this.wasPlaying) this.requestPlan(this.bar + 1);
  };

  /** Plans the phrases from the one holding bar `from` on; one plan at a time, the latest request next. */
  private requestPlan = (from: number) => {
    if (!this.config.plan || !this.provider.plan || !this.players.size || !this.wasPlaying) return;
    if (this.planning) {
      this.planAgain = from;
      return;
    }
    void this.makePlan(from);
  };

  private makePlan = async (from: number) => {
    const { phraseLength } = this.config;
    const count = this.config.plan ? this.config.plan.phrases : 4;
    const first = phraseStart(from, phraseLength);
    const starts = Array.from({ length: count }, (_, i) => first + i * phraseLength);
    const { transport } = this.store.state;
    const analysis = this.analyzeNow();
    const barMs = beatsPerBar(transport) * msPerBeat(transport);
    const now = Date.now();
    const speech = this.speech
      .filter((said) => now - said.at <= Math.max(4 * barMs, 8000))
      .slice(0, 3)
      .reverse()
      .map((said) => {
        const ago = this.bar - said.bar;
        const when = !said.bar ? "just before playback started" : ago <= 0 ? "this bar" : ago === 1 ? "last bar" : `${ago} bars ago`;
        return { text: said.text, trackName: said.trackName, when };
      });
    const players = [...this.players.values()].map((player) => `${player.settings.trackName} plays ${player.role()}`);
    const state = describeBand(analysis, transport, { bar: this.bar, players, direction: this.direction, speech, current: this.plan, phraseLength });
    const request: PlanRequest = { state, starts, phraseLength, current: this.plan, direction: this.direction, speech };
    const run = this.planRun;
    const bar = this.bar;
    this.planning = true;
    this.plannedWith = { speechAt: this.speech[0]?.at ?? 0, direction: this.direction, parts: this.bandParts(analysis), energy: analysis.energy };
    const started = performance.now();
    try {
      // A plan may take most of a bar: the current one stands until it comes.
      const { answers, trace } = await this.provider.plan!(request, { timeoutMs: Math.max(2 * barMs, 3000) });
      if (run !== this.planRun) return;
      const plan = planFromAnswers(answers, request, bar, this.provider.name);
      this.plan = plan;
      this.planCalls++;
      this.planProblem = undefined;
      this.recordPlan(plan);
      this.planDetails.set(bar, { decidedAt: bar, phrases: plan.phrases, intensity: plan.intensity, sent: { state, questions: trace.questions }, received: trace.received, ms: Math.round(performance.now() - started) });
      for (const old of this.planDetails.keys()) if (old < bar - 64) this.planDetails.delete(old);
      console.info(`[session] Plan from bar ${first}: ${plan.phrases.map((p) => `${p.section}${p.ending === "none" ? "" : ` (${p.ending})`}`).join(", ")}; intensity ${plan.intensity}`);
    } catch (error) {
      if (run !== this.planRun) return;
      this.planProblem = `Couldn't plan: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[session] ${this.planProblem}`);
    } finally {
      if (run === this.planRun) {
        this.planning = false;
        const next = this.planAgain;
        this.planAgain = undefined;
        if (next !== undefined) this.requestPlan(next);
      }
      this.publish();
    }
  };

  /** Notes what the plan says for the bars still to come; bars already under way keep what they had. */
  private recordPlan = (plan: BandPlan) => {
    const { phraseLength } = this.config;
    for (const phrase of plan.phrases) {
      for (let i = 0; i < phraseLength; i++) {
        const bar = phrase.start + i;
        if (bar <= this.bar) continue;
        const last = i === phraseLength - 1;
        this.plannedBars.set(bar, { bar, section: phrase.section, start: phrase.start, ending: last ? phrase.ending : undefined, decidedAt: plan.decidedAt });
      }
    }
    for (const bar of this.plannedBars.keys()) if (bar < this.bar - 32) this.plannedBars.delete(bar);
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
        notice: this.notice,
        plan:
          this.plan || this.planProblem
            ? {
                decidedAt: this.plan?.decidedAt ?? 0,
                intensity: this.plan?.intensity ?? 0,
                provider: this.plan?.provider ?? this.provider.name,
                phrases: this.plan?.phrases ?? [],
                bars: [...this.plannedBars.values()].filter((b) => b.bar >= this.bar - 16).sort((a, b) => a.bar - b.bar),
                calls: this.planCalls,
                problem: this.planProblem,
              }
            : undefined,
      });
    }, 0);
  };
}

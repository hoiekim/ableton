export const SOCKET_PATH = "/socket";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export interface TransportState {
  isPlaying: boolean;
  /** Playing position of the Live Set, in beats (quarter notes). */
  songTime: number;
  tempo: number;
  signatureNumerator: number;
  signatureDenominator: number;
  recordMode: boolean;
  metronome: boolean;
  loop: boolean;
}

export type DeviceType = "instrument" | "audio_effect" | "midi_effect" | "undefined";

export interface ParamValue {
  value: number;
  /** The selected item's label, for enum parameters. */
  label?: string;
}

/**
 * The track the musician keeps spare Session devices on ("Session Devices"):
 * the web page's Listen switch copies one from it onto a track that has none.
 */
export const isDeviceStash = (trackName: string) => /^session devices\b/i.test(trackName.trim());

/** Present on Session Player and Session Input devices, recognized by their parameter names. */
export interface SessionDeviceInfo {
  kind: "player" | "input" | "voice";
  /** Parameter values keyed by long name, e.g. "SP Instrument". */
  params: Record<string, ParamValue>;
}

export interface DeviceState {
  id: number;
  name: string;
  className: string;
  classDisplayName: string;
  type: DeviceType;
  isActive: boolean;
  session?: SessionDeviceInfo;
}

export type TrackType = "audio" | "midi" | "group" | "return" | "master";

export interface TrackState {
  id: number;
  name: string;
  type: TrackType;
  /** CSS hex color, e.g. "#ff3a34". */
  color: string;
  mute: boolean;
  solo: boolean;
  arm: boolean;
  devices: DeviceState[];
}

export interface LiveState {
  status: ConnectionStatus;
  transport: TransportState;
  tracks: TrackState[];
}

export const initialTransport: TransportState = {
  isPlaying: false,
  songTime: 0,
  tempo: 120,
  signatureNumerator: 4,
  signatureDenominator: 4,
  recordMode: false,
  metronome: false,
  loop: false,
};

export const initialLiveState: LiveState = {
  status: "disconnected",
  transport: initialTransport,
  tracks: [],
};

export const instruments = ["drums", "bass", "keys", "guitar"] as const;

export type Instrument = (typeof instruments)[number];

export const inputRoles = ["auto", "bass", "chords", "melody", "drums"] as const;

export type InputRole = (typeof inputRoles)[number];

export type PlayerStatus = "off" | "waiting" | "listening" | "playing" | "error";

/** "waited": asked early because someone spoke, the player chose not to come in yet. */
export type DecisionOutcome = "fired" | "kept" | "missed" | "waited";

/**
 * A note, compactly: pitch, start and duration in beats (from the bar's or
 * clip's start), velocity, and 1 when it was already sounding as the bar began.
 */
export type CompactNote = [pitch: number, start: number, duration: number, velocity: number, held?: 1];

/** One of the options the decision model weighed, with its probability. */
export interface DecisionOdds {
  pattern: string;
  p: number;
}

export interface DecisionLog {
  /** Bar number (1-based, counted from when playback started) the decision is for. */
  bar: number;
  /** Bars the clip lasts (the device's clip length). */
  length: number;
  pattern: string;
  /** For a concrete bar: how it varies the pattern ("lock", "ghosts"...); absent for the plain pattern. */
  variant?: string;
  energy: number;
  fill: boolean;
  /** Chord per bar the clip was rendered against. */
  chords: string[];
  provider: string;
  confidence?: number;
  /** Set when the chosen provider failed or was unsure and local rules decided instead. */
  fallbackReason?: string;
  decisionMs: number;
  /** Time left before the bar started once the clip was in place; negative when it missed. */
  marginMs: number;
  outcome: DecisionOutcome;
  clipName?: string;
  /**
   * The text the decision model was given. Sent with the latest decision only;
   * the others' are in their detail (DecisionDetail.sent.state).
   */
  state?: string;
  /** The decision model's likeliest patterns, most likely first (Jev only). */
  odds?: DecisionOdds[];
  /** Its probability for playing a fill, and for coming in early when asked. */
  fillP?: number;
  joinP?: number;
  /** The notes written into the clip, or the looping clip's when it was kept. */
  notes?: CompactNote[];
  /** Set when no call was made: the decision model's answer for an earlier bar was reused, and why. */
  reused?: ReusedFrom;
}

export interface ReusedFrom {
  /** The bar whose answer was reused. */
  from: number;
  /** "mid-phrase, nothing changed" or "the band is silent". */
  reason: string;
}

/**
 * Everything about one decision, served on request (GET
 * /api/decisions/<deviceId>/<bar>) since it's too big to send every update.
 */
export interface DecisionDetail {
  deviceId: number;
  trackName: string;
  instrument: Instrument;
  log: DecisionLog;
  sent: {
    /** The band summed up as text. */
    state: string;
    /** The patterns on offer, described for the loaded instrument. */
    options: { id: string; description: string; fit: number }[];
    /** The questions as sent to the decision model (Jev); absent for local rules. */
    questions?: unknown;
  };
  /** The decision model's answer as it came back (Jev); absent for local rules. */
  received?: unknown;
  /** How the local rules scored each pattern, when they decided or stood in. */
  ranking?: { pattern: string; score: number }[];
}

export interface PlayerState {
  deviceId: number;
  trackId: number;
  trackName: string;
  /** What it plays: its setting, or what Auto made of the loaded instrument. */
  instrument: Instrument;
  instrumentSetting: Instrument | "auto";
  /** The instrument loaded after the device, as the server read it from Live. */
  sound?: { name: string; summary: string; kind: "drums" | "melodic" };
  active: boolean;
  lookahead: number;
  length: number;
  join: number;
  energy: number | "auto";
  status: PlayerStatus;
  message?: string;
  provider: string;
  recent: DecisionLog[];
  /** Bars being decided ("ready" once decided, waiting to be written). */
  pending: { bar: number; ready: boolean }[];
  /** `calls`: requests made to the decision model; `reused`: decisions that reused an earlier answer instead. */
  stats: { decisions: number; misses: number; p90Ms: number; calls: number; reused: number };
}

/** A pattern as the Patterns tab shows it: what the decision model reads about it, and what it plays. */
export interface PatternPreview {
  id: string;
  /** Exactly what the decision model reads, described for the loaded instrument. */
  description: string;
  /** Energy range (1–10) the local rules use it for. */
  energy: [number, number];
  /** How busy the rest of the band should be for it to fit. */
  suits: "sparse" | "busy" | "any";
  /** Melodic patterns: how the notes are played. */
  articulation?: "sustained" | "rhythmic" | "busy";
  /** How well it suits the loaded sound: positive suits, negative doesn't. */
  fit: number;
  /** The notes the player would write for it over the progression. */
  notes: CompactNote[];
}

/**
 * A Session Player's patterns for its current instrument, rendered at one
 * energy over a sample progression (GET /api/patterns/<deviceId>).
 */
export interface PatternReview {
  deviceId: number;
  trackName: string;
  instrument: Instrument;
  sound?: PlayerState["sound"];
  provider: string;
  /** One bar per chord. */
  chords: string[];
  beatsPerBar: number;
  energy: number;
  fill: boolean;
  /**
   * Drums: what plays on each note the patterns use, lowest first: the kit's
   * sound, the note as Live names it, and the pattern sounds sent there.
   */
  sounds?: { pitch: number; name: string; note: string; roles: string[] }[];
  patterns: PatternPreview[];
  /** What the decision model reads about keeping the last clip, when it's offered that too. */
  hold?: string;
}

/** A pattern written into a clip slot to try in Live (POST /api/patterns/<deviceId>/audition). */
export interface AuditionResult {
  trackName: string;
  /** 0-based, like Live's scene index. */
  slot: number;
  clipName: string;
}

export interface InputState {
  deviceId: number;
  trackId: number;
  trackName: string;
  kind: "midi" | "audio";
  role: InputRole;
  on: boolean;
  connected: boolean;
  /** Notes heard in the last complete bar, e.g. ["A2", "E3"]. */
  lastNotes: string[];
}

/** One bar of what the inputs played, for the dashboard. */
export interface TimelineBar {
  /** Counted from Play, like DecisionLog.bar. */
  bar: number;
  beatsPerBar: number;
  /** The bar in progress, heard up to now. */
  partial?: boolean;
  chord?: string;
  /** Notes heard, by input device id. */
  heard: Record<number, CompactNote[]>;
}

/** What the band plan says for one bar, as it stood when the bar came. */
export interface PlannedBar {
  bar: number;
  /** "groove", "build", "climax", "breakdown", "break", "half-time", "variation" or "outro". */
  section: string;
  /** The phrase's first bar. */
  start: number;
  /** In the phrase's last bar: "none", "fill", "big-fill" or "stop". */
  ending?: string;
  /** The bar the plan was made in. */
  decidedAt: number;
}

/** The band plan the decision model made (see plan.ts on the server). */
export interface PlanState {
  decidedAt: number;
  intensity: number;
  provider: string;
  phrases: { start: number; section: string; ending: string }[];
  /** Recent and coming bars. */
  bars: PlannedBar[];
  /** Plans asked for so far. */
  calls: number;
  /** Set when the last plan couldn't be made. */
  problem?: string;
}

/** Everything about one plan, served on request (GET /api/plans/<decidedAt>). */
export interface PlanDetail {
  decidedAt: number;
  phrases: { start: number; section: string; ending: string }[];
  intensity: number;
  sent: { state: string; questions: unknown };
  received?: unknown;
  ms: number;
}

/** A Session Voice device: it records what's said or sung on its track for the players. */
export interface VoiceState {
  deviceId: number;
  trackId: number;
  trackName: string;
  on: boolean;
  connected: boolean;
}

/** Something said or sung on a Session Voice track, as transcribed. */
export interface SpeechState {
  text: string;
  trackName: string;
  /** Bar it was heard in (counted from Play); 0 when heard while stopped or before this take. */
  bar: number;
  /** When it was heard, as a Unix time in milliseconds. */
  at: number;
}

/** The local speech-to-text server the Session Voice devices need. */
export interface TranscriberState {
  status: "off" | "starting" | "ready" | "unavailable" | "error";
  message?: string;
}

export interface SessionState {
  bar: number;
  /** The musician's style direction for the players; empty when none. */
  direction: string;
  key?: string;
  /** Detected chord per recent bar, oldest first. */
  chords: string[];
  predictedChord?: string;
  players: PlayerState[];
  inputs: InputState[];
  voices: VoiceState[];
  /** What was said or sung recently, newest first. */
  speech: SpeechState[];
  transcriber: TranscriberState;
  /** The last bars the inputs played, oldest first, ending with the bar in progress. */
  timeline: TimelineBar[];
  /** The band plan, when the decision model makes one. */
  plan?: PlanState;
  /** Something to tell the musician, e.g. that an input was added to a track (Unix ms). */
  notice?: { text: string; tone: "info" | "error"; at: number };
}

export const initialSessionState: SessionState = {
  bar: 0,
  direction: "",
  chords: [],
  players: [],
  inputs: [],
  voices: [],
  speech: [],
  transcriber: { status: "off" },
  timeline: [],
};

export type ServerMessage =
  | { type: "status"; status: ConnectionStatus }
  | { type: "tracks"; tracks: TrackState[] }
  | { type: "transport"; transport: TransportState }
  | { type: "session"; session: SessionState };

export const transportCommands = ["play", "stop", "toggleRecord", "toggleMetronome", "toggleLoop"] as const;

export type TransportCommand = (typeof transportCommands)[number];

/** Longest style direction the server keeps; the decision model reads it every bar. */
export const MAX_DIRECTION_LENGTH = 300;

export type ClientMessage =
  | { type: "command"; command: TransportCommand }
  /** What the musician wants the players to play, e.g. "funky 70s soul, laid back". */
  | { type: "direction"; text: string }
  /** Turns a track's Session Input (or Session Voice) on or off. */
  | { type: "listen"; trackId: number; on: boolean };

export const isTransportCommand = (value: unknown): value is TransportCommand => {
  return transportCommands.includes(value as TransportCommand);
};

export interface Position {
  bar: number;
  beat: number;
  sixteenth: number;
}

/**
 * Converts song time in beats to Live's "bars.beats.sixteenths" position.
 * Assumes a constant time signature, so it drifts from Live's display after
 * a signature change in the arrangement.
 */
export const getPosition = (songTime: number, numerator: number, denominator: number): Position => {
  const time = Math.max(songTime, 0) + 1e-6;
  const beatLength = 4 / denominator;
  const barLength = numerator * beatLength;
  const bar = Math.floor(time / barLength);
  const timeInBar = time - bar * barLength;
  const beat = Math.floor(timeInBar / beatLength);
  const timeInBeat = timeInBar - beat * beatLength;
  const sixteenth = Math.floor(timeInBeat / 0.25);
  return { bar: bar + 1, beat: beat + 1, sixteenth: sixteenth + 1 };
};

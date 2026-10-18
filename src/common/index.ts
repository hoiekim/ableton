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

/** Present on Session Player and Session Input devices, recognized by their parameter names. */
export interface SessionDeviceInfo {
  kind: "player" | "input";
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

export type DecisionOutcome = "fired" | "kept" | "missed";

export interface DecisionLog {
  /** Bar number (1-based, counted from when playback started) the decision is for. */
  bar: number;
  pattern: string;
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
  /** The text the decision model was given. */
  state: string;
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
  stats: { decisions: number; misses: number; p90Ms: number };
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
}

export const initialSessionState: SessionState = { bar: 0, direction: "", chords: [], players: [], inputs: [] };

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
  | { type: "direction"; text: string };

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

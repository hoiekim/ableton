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

export interface DeviceState {
  id: number;
  name: string;
  className: string;
  classDisplayName: string;
  type: DeviceType;
  isActive: boolean;
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

export type ServerMessage =
  | { type: "status"; status: ConnectionStatus }
  | { type: "tracks"; tracks: TrackState[] }
  | { type: "transport"; transport: TransportState };

export const transportCommands = ["play", "stop", "toggleRecord", "toggleMetronome", "toggleLoop"] as const;

export type TransportCommand = (typeof transportCommands)[number];

export type ClientMessage = { type: "command"; command: TransportCommand };

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

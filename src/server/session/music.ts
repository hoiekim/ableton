import { Chord, Note } from "tonal";

/** A note to write into a clip. Times are in beats from the clip start. */
export interface ClipNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export interface ChordInfo {
  /** Display symbol, e.g. "Am7", "F", "G7". */
  symbol: string;
  /** Root pitch class, 0 = C. */
  root: number;
  /** Chord tones as semitones above the root, root first. */
  intervals: number[];
  minor: boolean;
}

export interface KeyInfo {
  tonic: number;
  mode: "major" | "minor";
  name: string;
}

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const pitchClassName = (pc: number) => SHARP_NAMES[((pc % 12) + 12) % 12];

export const noteName = (pitch: number) => Note.fromMidiSharps(pitch);

/** A note named the way Live labels it, where middle C (60) is C3 and Drum Rack kicks sit on C1. */
export const liveNoteName = (pitch: number) => `${pitchClassName(pitch)}${Math.floor(pitch / 12) - 2}`;

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Tonal writes a plain major triad as "CM"; musicians write "C". */
const tidySymbol = (symbol: string) => symbol.replace(/^([A-G][#b]?)M$/, "$1");

export const chordFromSymbol = (symbol: string): ChordInfo | undefined => {
  const chord = Chord.get(symbol);
  const root = Note.chroma(chord.tonic ?? "");
  if (chord.empty || root === undefined || Number.isNaN(root)) return undefined;
  const intervals = chord.notes.map((note) => (((Note.chroma(note) ?? 0) - root) % 12 + 12) % 12);
  return {
    symbol: tidySymbol(chord.symbol),
    root,
    intervals,
    minor: chord.quality === "Minor" || chord.quality === "Diminished",
  };
};

/** A plain triad on a root, for when the band gives too little to name a chord. */
export const triad = (root: number, minor: boolean): ChordInfo => ({
  symbol: `${pitchClassName(root)}${minor ? "m" : ""}`,
  root,
  intervals: minor ? [0, 3, 7] : [0, 4, 7],
  minor,
});

/** Lowest pitch at or above `min` with the given pitch class. */
export const pitchAtOrAbove = (pc: number, min: number) => min + ((((pc - min) % 12) + 12) % 12);

/**
 * Places chord tones between `low` and `high`, keeping the voicing close to
 * the previous one so changes move smoothly.
 */
export const voiceChord = (chord: ChordInfo, low: number, high: number, previousCenter?: number) => {
  const pcs = chord.intervals.slice(0, 4).map((interval) => (chord.root + interval) % 12);
  const center = previousCenter ?? (low + high) / 2;
  const pitches = pcs.map((pc) => {
    let pitch = pitchAtOrAbove(pc, low);
    while (pitch + 12 <= high && Math.abs(pitch + 12 - center) < Math.abs(pitch - center)) pitch += 12;
    return pitch;
  });
  return [...new Set(pitches)].sort((a, b) => a - b);
};

/** Small deterministic generator, so a given bar always renders the same way. */
export const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const hashString = (text: string) => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
};

import { Chord } from "tonal";
import { InputRole } from "common";
import { ChordInfo, KeyInfo, chordFromSymbol, clamp, noteName, pitchClassName, triad } from "./music";

/** A note heard during one bar. Times are in beats from the bar's start. */
export interface HeardNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  /** Still sounding from an earlier bar, so not a new onset. */
  held: boolean;
}

export interface InputBar {
  deviceId: number;
  trackName: string;
  role: InputRole;
  notes: HeardNote[];
}

export interface BarRecord {
  /** Bar number counted from when playback started, 1-based. */
  index: number;
  beatsPerBar: number;
  inputs: InputBar[];
  /** The bar is still playing; only part of it has been heard. */
  partial?: boolean;
}

export type PartRole = Exclude<InputRole, "auto">;

export interface PartFeatures {
  deviceId: number;
  trackName: string;
  role: PartRole;
  onsets: number;
  /** 16 steps, "x" where a note starts. */
  grid: string;
  velocity: number;
  /** Median pitch of the notes heard. */
  register: number;
  /** Average number of notes sounding together. */
  polyphony: number;
  notes: string[];
}

export interface BarFeatures {
  index: number;
  partial: boolean;
  parts: PartFeatures[];
  chord?: ChordInfo;
  /** Duration-weighted pitch-class profile of the harmonic parts. */
  pitchClasses: number[];
  onsets: number;
  /** 1–10. */
  energy: number;
}

export interface ChordGuess {
  chord?: ChordInfo;
  predicted: boolean;
  /**
   * Heard in a finished bar, read from the clips the band is playing,
   * predicted from a repeating loop, or the latest chord held over.
   */
  source: "heard" | "clip" | "loop" | "held";
  /** 0–1. */
  confidence: number;
  /** For a chord read from clips: the tracks whose clips it came from. */
  tracks?: string[];
}

/**
 * What the band's clips will play in a bar (the current one or one ahead),
 * per input, in the bar's beats. Inputs played live aren't in it.
 */
export type UpcomingNotes = (index: number) => InputBar[];

export interface BandAnalysis {
  bars: BarFeatures[];
  key?: KeyInfo;
  /** Length in bars of a repeating chord loop, when one is found. */
  loopLength?: number;
  loopConfidence: number;
  energy: number;
  energyTrend: "rising" | "falling" | "steady";
  /**
   * Chord for a bar index (completed, current or future). Ahead of what's been
   * heard it's read from the band's clips when they play any, else predicted.
   */
  chordAt: (index: number) => ChordGuess;
}

const STEPS = 16;

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const resolveRole = (role: InputRole, notes: HeardNote[], beatsPerBar: number): PartRole => {
  if (role !== "auto") return role;
  if (!notes.length) return "melody";
  const polyphony = averagePolyphony(notes, beatsPerBar);
  if (polyphony >= 1.8) return "chords";
  return median(notes.map((note) => note.pitch)) < 52 ? "bass" : "melody";
};

const averagePolyphony = (notes: HeardNote[], beatsPerBar: number) => {
  const sounding = notes.reduce((sum, note) => sum + note.duration, 0);
  const covered = new Set<number>();
  for (const note of notes) {
    const from = Math.floor((note.start / beatsPerBar) * STEPS);
    const to = Math.ceil(((note.start + note.duration) / beatsPerBar) * STEPS);
    for (let step = from; step < Math.min(to, STEPS); step++) covered.add(step);
  }
  const coveredBeats = (covered.size / STEPS) * beatsPerBar;
  return coveredBeats ? sounding / coveredBeats : 0;
};

const describePart = (input: InputBar, beatsPerBar: number): PartFeatures => {
  const { notes } = input;
  const onsets = notes.filter((note) => !note.held);
  const grid = Array.from({ length: STEPS }, () => ".");
  // Nearest step, not the one below: players land a little early or late.
  for (const note of onsets) grid[clamp(Math.round((note.start / beatsPerBar) * STEPS), 0, STEPS - 1)] = "x";
  const velocity = onsets.length ? onsets.reduce((sum, note) => sum + note.velocity, 0) / onsets.length : 0;
  return {
    deviceId: input.deviceId,
    trackName: input.trackName,
    role: resolveRole(input.role, notes, beatsPerBar),
    onsets: onsets.length,
    grid: grid.join(""),
    velocity: Math.round(velocity),
    register: median(notes.map((note) => note.pitch)),
    polyphony: Math.round(averagePolyphony(notes, beatsPerBar) * 10) / 10,
    notes: [...new Set(onsets.map((note) => noteName(note.pitch)))],
  };
};

/** Whether a chord on `root` is minor in the key, for filling in thin harmony. */
const isMinorInKey = (root: number, key?: KeyInfo) => {
  if (!key) return false;
  const degree = (root - key.tonic + 12) % 12;
  return key.mode === "major" ? [2, 4, 9, 11].includes(degree) : [0, 5, 7, 2].includes(degree);
};

/**
 * Names the chord from a duration-weighted pitch-class profile with Tonal,
 * preferring a chord rooted on the bass note.
 */
export const detectChord = (pitchClasses: number[], bassPc: number | undefined, key?: KeyInfo) => {
  const max = Math.max(...pitchClasses);
  if (max <= 0) return undefined;
  const strong = pitchClasses
    .map((weight, pc) => ({ pc, weight }))
    .filter(({ weight }) => weight >= max * 0.2)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map(({ pc }) => pc);
  const ordered = bassPc !== undefined && strong.includes(bassPc) ? [bassPc, ...strong.filter((pc) => pc !== bassPc)] : strong;
  const root = ordered[0];

  const candidates = Chord.detect(ordered.map(pitchClassName))
    .map(chordFromSymbol)
    .filter((chord): chord is ChordInfo => !!chord && !chord.symbol.includes("/"));
  const rooted = candidates.find((chord) => chord.root === root);
  if (rooted ?? candidates[0]) return rooted ?? candidates[0];

  // Too few notes to name a chord: build a triad on the root.
  const intervals = ordered.slice(1).map((pc) => (pc - root + 12) % 12);
  if (intervals.includes(3)) return triad(root, true);
  if (intervals.includes(4)) return triad(root, false);
  return triad(root, isMinorInKey(root, key));
};

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const correlate = (a: number[], b: number[]) => {
  const meanA = a.reduce((sum, v) => sum + v, 0) / a.length;
  const meanB = b.reduce((sum, v) => sum + v, 0) / b.length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - meanA) * (b[i] - meanB);
    denA += (a[i] - meanA) ** 2;
    denB += (b[i] - meanB) ** 2;
  }
  return denA && denB ? num / Math.sqrt(denA * denB) : 0;
};

/** Krumhansl–Schmuckler key finding. */
export const detectKey = (pitchClasses: number[]): KeyInfo | undefined => {
  if (pitchClasses.reduce((sum, v) => sum + v, 0) < 2) return undefined;
  let best: { score: number; key: KeyInfo } | undefined;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = profile.map((_, pc) => profile[(pc - tonic + 12) % 12]);
      const score = correlate(pitchClasses, rotated);
      if (!best || score > best.score) best = { score, key: { tonic, mode, name: `${pitchClassName(tonic)} ${mode}` } };
    }
  }
  return best?.key;
};

/**
 * Finds the shortest chord loop (1, 2, 4 or 8 bars) that the latest bars
 * repeat, so the chord of an upcoming bar can be predicted. Only the unbroken
 * run of repeats up to now counts: an odd bar earlier on (say, one heard only
 * in part) doesn't hide a loop, and a change of progression ends it at once.
 * Confidence reaches 1 after one full repeat.
 */
export const detectLoop = (symbols: (string | undefined)[]) => {
  let best: { length: number; confidence: number } | undefined;
  for (const length of [1, 2, 4, 8]) {
    let streak = 0;
    for (let i = symbols.length - 1; i - length >= 0; i--) {
      if (!symbols[i] || symbols[i] !== symbols[i - length]) break;
      streak++;
    }
    if (!streak) continue;
    const confidence = Math.min(1, streak / length);
    if (!best || confidence > best.confidence + 0.05) best = { length, confidence };
  }
  return best;
};

const barEnergy = (parts: PartFeatures[]) => {
  const onsets = parts.reduce((sum, part) => sum + part.onsets, 0);
  const velocities = parts.filter((part) => part.onsets).map((part) => part.velocity);
  const velocity = velocities.length ? velocities.reduce((sum, v) => sum + v, 0) / velocities.length : 0;
  if (!onsets) return 1;
  const density = Math.min(1, onsets / 24);
  const loudness = clamp((velocity - 40) / 80, 0, 1);
  return clamp(Math.round(1 + 9 * (0.55 * density + 0.45 * loudness)), 1, 10);
};

export const analyzeBar = (bar: BarRecord, key?: KeyInfo): BarFeatures => {
  const parts = bar.inputs.filter((input) => input.notes.length).map((input) => describePart(input, bar.beatsPerBar));
  const pitchClasses = new Array(12).fill(0);
  const bassWeights = new Array(12).fill(0);
  for (const input of bar.inputs) {
    const role = parts.find((part) => part.deviceId === input.deviceId)?.role;
    if (!role || role === "drums") continue;
    for (const note of input.notes) {
      const weight = note.duration * (0.5 + note.velocity / 127) * (role === "bass" ? 1.5 : 1);
      pitchClasses[note.pitch % 12] += weight;
      if (role === "bass") bassWeights[note.pitch % 12] += weight;
    }
  }
  // Without a bass part, the lowest sustained note stands in for the bass.
  let bassPc: number | undefined;
  if (Math.max(...bassWeights) > 0) bassPc = bassWeights.indexOf(Math.max(...bassWeights));
  else {
    const harmonic = bar.inputs
      .filter((input) => parts.find((part) => part.deviceId === input.deviceId)?.role !== "drums")
      .flatMap((input) => input.notes)
      .filter((note) => note.duration >= 0.5);
    if (harmonic.length) bassPc = Math.min(...harmonic.map((note) => note.pitch)) % 12;
  }
  return {
    index: bar.index,
    partial: !!bar.partial,
    parts,
    chord: detectChord(pitchClasses, bassPc, key),
    pitchClasses,
    onsets: parts.reduce((sum, part) => sum + part.onsets, 0),
    energy: barEnergy(parts),
  };
};

/** Confidence in a chord read from clips: they say exactly what will play, unless someone launches another. */
const CLIP_CONFIDENCE = 0.95;

/**
 * Analyzes recent bars (oldest first; the last may be partial). `upcoming`
 * gives the notes the band's clips will play, for the bars not yet heard.
 */
export const analyzeBand = (records: BarRecord[], upcoming?: UpcomingNotes): BandAnalysis => {
  const keyProfile = new Array(12).fill(0);
  const firstPass = records.map((record) => analyzeBar(record));
  firstPass.slice(-8).forEach((bar) => bar.pitchClasses.forEach((w, pc) => (keyProfile[pc] += w)));
  const key = detectKey(keyProfile);
  // Second pass with the key, which settles thin bars (a lone root note, say).
  const bars = records.map((record) => analyzeBar(record, key));

  // Fill silent bars with the previous chord: the harmony usually carries on.
  let lastChord: ChordInfo | undefined;
  const chords = bars.map((bar) => (lastChord = bar.chord ?? lastChord));
  const complete = bars.filter((bar) => !bar.partial);
  // The bar in progress counts once something's been heard in it: decisions
  // come late in the bar, when most of it has been played.
  const known = bars.filter((bar) => !bar.partial || bar.parts.length);
  const loop = detectLoop(known.map((bar) => chords[bars.indexOf(bar)]?.symbol));

  const recentEnergy = complete.slice(-2).map((bar) => bar.energy);
  const earlierEnergy = complete.slice(-6, -2).map((bar) => bar.energy);
  const average = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);
  const energy = Math.round(average(recentEnergy.length ? recentEnergy : bars.map((bar) => bar.energy))) || 1;
  const delta = earlierEnergy.length ? average(recentEnergy) - average(earlierEnergy) : 0;

  const lastIndex = bars.length ? bars[bars.length - 1].index : 0;
  const beatsPerBar = records[records.length - 1]?.beatsPerBar ?? 4;
  const fromClips = new Map<number, ChordGuess | undefined>();
  const clipChord = (index: number) => {
    if (fromClips.has(index)) return fromClips.get(index);
    const inputs = upcoming?.(index).filter((input) => input.notes.length) ?? [];
    const bar = inputs.length ? analyzeBar({ index, beatsPerBar, inputs }, key) : undefined;
    const tracks = bar?.parts.filter((part) => part.role !== "drums").map((part) => part.trackName) ?? [];
    // A bar the clips leave silent says nothing about the harmony.
    const guess: ChordGuess | undefined =
      bar?.chord && tracks.length ? { chord: bar.chord, predicted: true, source: "clip", confidence: CLIP_CONFIDENCE, tracks } : undefined;
    fromClips.set(index, guess);
    return guess;
  };

  const chordAt = (index: number): ChordGuess => {
    const position = bars.findIndex((bar) => bar.index === index);
    const bar = bars[position];
    if (bar && !bar.partial && chords[position]) return { chord: chords[position], predicted: false, source: "heard", confidence: 1 };
    // Ahead of what's been heard: read the band's clips, else follow the loop,
    // else hold the latest chord.
    const clip = !bar || bar.partial ? clipChord(index) : undefined;
    if (clip) return clip;
    const anchor = known[known.length - 1]?.index ?? 0;
    if (loop && known.length >= loop.length && index > anchor) {
      const steps = index - anchor;
      const source = anchor - loop.length + (((steps - 1) % loop.length) + 1);
      const chord = chords[bars.findIndex((b) => b.index === source)];
      if (chord) return { chord, predicted: true, source: "loop", confidence: loop.confidence };
    }
    const latest = chords[Math.min(position >= 0 ? position : chords.length - 1, chords.length - 1)];
    return { chord: latest, predicted: index > lastIndex || !!bar?.partial, source: "held", confidence: latest ? 0.3 : 0 };
  };

  return {
    bars,
    key,
    loopLength: loop?.length,
    loopConfidence: loop?.confidence ?? 0,
    energy,
    energyTrend: delta >= 1.5 ? "rising" : delta <= -1.5 ? "falling" : "steady",
    chordAt,
  };
};

import { DrumRole, Kit, KitRole } from "../instrument";
import { ChordInfo, ClipNote, clamp } from "../music";

export interface RenderContext {
  /** Chord for each bar of the clip. */
  chords: ChordInfo[];
  /** Chord right after the clip, for lines that lead into it. */
  nextChord?: ChordInfo;
  beatsPerBar: number;
  /** Length of one signature beat in quarter notes (1 in x/4, 0.5 in x/8). */
  beatLength: number;
  /** 1–10. */
  energy: number;
  /** End the clip with a fill. */
  fill: boolean;
  /** The previous clip ended with a fill, so open with an accent. */
  accent: boolean;
  /** The note each drum sound plays in the loaded kit. */
  kit: Kit;
  random: () => number;
}

/** How a pattern plays, to judge how well it suits the loaded sound. */
export type Articulation = "sustained" | "rhythmic" | "busy";

export interface Pattern {
  /** Stable id; the decision model answers with it. */
  id: string;
  /** What it sounds like and when it fits. The decision model chooses by this text. */
  description: string;
  /** Energy range (1–10) the local rules use it for. */
  energy: [number, number];
  /** How busy the rest of the band should be for this to fit. */
  suits: "sparse" | "busy" | "any";
  /** Melodic patterns: how the notes are played. */
  articulation?: Articulation;
  /** Drum patterns: the kit sounds it plays, named in its description for the loaded kit. */
  uses?: KitRole[];
  /** Drum patterns: offered only when the kit has one of these sounds of its own (and two for toms). */
  requires?: DrumRole[];
  render: (context: RenderContext) => ClipNote[];
}

/** Calls `render` for each bar, shifting its notes to the bar's offset in the clip. */
export const eachBar = (
  context: RenderContext,
  render: (chord: ChordInfo, barIndex: number, isLast: boolean) => ClipNote[]
) => {
  return context.chords.flatMap((chord, i) => {
    const offset = i * context.beatsPerBar;
    const isLast = i === context.chords.length - 1;
    return render(chord, i, isLast).map((note) => ({ ...note, start: note.start + offset }));
  });
};

/** Velocity scaled by energy, with a little humanizing. */
export const velocity = (context: RenderContext, accent = 0) => {
  const base = 42 + context.energy * 6 + accent;
  return clamp(Math.round(base + (context.random() - 0.5) * 8), 1, 127);
};

/** Positions of each signature beat in the bar, in quarter notes. */
export const beats = (context: RenderContext) => {
  return Array.from({ length: context.beatsPerBar / context.beatLength }, (_, i) => i * context.beatLength);
};

/** Positions every `step` quarter notes across the bar. */
export const grid = (context: RenderContext, step: number) => {
  return Array.from({ length: Math.round(context.beatsPerBar / step) }, (_, i) => i * step);
};

export const note = (pitch: number, start: number, duration: number, vel: number): ClipNote => ({
  pitch,
  start,
  duration,
  velocity: vel,
});

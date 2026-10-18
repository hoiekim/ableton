import { ChordInfo, ClipNote, pitchAtOrAbove, voiceChord } from "../music";
import { Pattern, RenderContext, beats, eachBar, grid, note, velocity } from "./types";

/** Guitar-like spread: a low root plus chord tones in the middle register. */
const shape = (chord: ChordInfo) => {
  const bassNote = pitchAtOrAbove(chord.root, 40);
  return [bassNote, ...voiceChord(chord, 52, 71, 60).filter((pitch) => pitch > bassNote)];
};

/** A strum: strings sounded one after another, upward for downstrokes. */
const strum = (context: RenderContext, chord: ChordInfo, start: number, duration: number, down = true, accent = 0): ClipNote[] => {
  const strings = down ? shape(chord) : [...shape(chord)].reverse();
  const vel = velocity(context, accent);
  return strings.map((pitch, i) => note(pitch, start + i * 0.02, duration - i * 0.02, vel - (down ? 0 : 10)));
};

const powerChord = (chord: ChordInfo) => {
  const r = pitchAtOrAbove(chord.root, 40);
  return [r, r + 7, r + 12];
};

const withFill = (context: RenderContext, notes: ClipNote[]) => {
  if (!context.fill) return notes;
  const clipLength = context.chords.length * context.beatsPerBar;
  const start = clipLength - context.beatLength;
  const last = context.chords[context.chords.length - 1];
  const strums = grid({ ...context, beatsPerBar: context.beatLength }, context.beatLength / 4).flatMap((t, i) =>
    strum(context, last, start + t, context.beatLength / 4, i % 2 === 0, 4 + i * 3)
  );
  return [...notes.filter((n) => n.start < start), ...strums];
};

const guitarPattern = (
  pattern: Omit<Pattern, "render">,
  bar: (context: RenderContext, chord: ChordInfo) => ClipNote[]
): Pattern => ({
  ...pattern,
  render: (context) => {
    const notes = eachBar(context, (chord) => bar(context, chord));
    return notes.length ? withFill(context, notes) : notes;
  },
});

export const guitar: Pattern[] = [
  guitarPattern(
    {
      id: "ballad-strum",
      description: "One big strum on beat 1 left ringing, a lighter strum on beat 3. Open and gentle; for ballads and quiet verses.",
      energy: [1, 4],
      suits: "busy",
      articulation: "sustained",
    },
    (context, chord) => [
      ...strum(context, chord, 0, context.beatsPerBar / 2, true, 4),
      ...strum(context, chord, context.beatsPerBar / 2, context.beatsPerBar / 2 - 0.05, true, -10),
    ]
  ),
  guitarPattern(
    {
      id: "strum-quarters",
      description: "Downstrokes on every beat. Steady rhythm guitar for pop and rock.",
      energy: [3, 6],
      suits: "any",
      articulation: "rhythmic",
    },
    (context, chord) => beats(context).flatMap((t, i) => strum(context, chord, t, context.beatLength * 0.9, true, i ? -4 : 4))
  ),
  guitarPattern(
    {
      id: "strum-eighths",
      description: "Down-up eighth-note strumming. Busy acoustic feel; for folk, pop and singer-songwriter grooves.",
      energy: [4, 8],
      suits: "sparse",
      articulation: "busy",
    },
    (context, chord) => grid(context, 0.5).flatMap((t, i) => strum(context, chord, t, 0.45, i % 2 === 0, i % 2 ? -6 : 2))
  ),
  guitarPattern(
    {
      id: "power-eighths",
      description: "Palm-muted power chords chugging in eighth notes. Hard rock and punk; heavy and driving.",
      energy: [6, 10],
      suits: "any",
      articulation: "busy",
    },
    (context, chord) => grid(context, 0.5).flatMap((t, i) => powerChord(chord).map((pitch) => note(pitch, t, 0.3, velocity(context, i % 2 ? -4 : 6))))
  ),
  guitarPattern(
    {
      id: "funk-chops",
      description: "Short muted chord chops on syncopated sixteenths. Funk and disco rhythm guitar; tight and percussive.",
      energy: [6, 10],
      suits: "any",
      articulation: "busy",
    },
    (context, chord) => {
      const hits = [0.5, 1, 1.75, 2.5, 3, 3.75].filter((t) => t < context.beatsPerBar);
      return hits.flatMap((t, i) => shape(chord).slice(1).map((pitch) => note(pitch, t, 0.12, velocity(context, i % 2 ? -6 : 4))));
    }
  ),
  guitarPattern(
    {
      id: "picking",
      description: "Fingerpicked eighth notes: bass note then the chord's upper strings in turn. Delicate and flowing; for folk and soft pop.",
      energy: [2, 6],
      suits: "sparse",
      articulation: "busy",
    },
    (context, chord) => {
      const strings = shape(chord);
      const order = [0, 2, 1, 3, 0, 2, 1, 3].map((i) => strings[Math.min(i, strings.length - 1)]);
      return grid(context, 0.5).map((t, i) => note(order[i % order.length], t, 0.9, velocity(context, i % 4 ? -10 : 0)));
    }
  ),
  guitarPattern(
    {
      id: "rest",
      description: "Guitar drops out for this bar. For breaks, or to leave room for other parts.",
      energy: [1, 2],
      suits: "busy",
    },
    () => []
  ),
];

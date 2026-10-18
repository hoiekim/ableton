import { ChordInfo, ClipNote, pitchAtOrAbove } from "../music";
import { Pattern, RenderContext, beats, eachBar, grid, note, velocity } from "./types";

const LOW = 33; // A1: roots sit between A1 and G#2

const root = (chord: ChordInfo) => pitchAtOrAbove(chord.root, LOW);
const fifth = (chord: ChordInfo) => root(chord) + (chord.intervals.includes(6) && !chord.intervals.includes(7) ? 6 : 7);
const third = (chord: ChordInfo) => root(chord) + (chord.minor ? 3 : 4);

/** The chord after `barIndex`: the next bar's, or the one after the clip. */
const following = (context: RenderContext, barIndex: number) => context.chords[barIndex + 1] ?? context.nextChord;

/** A chromatic step into the next chord's root, played on the last eighth. */
const approach = (context: RenderContext, barIndex: number, from: number) => {
  const next = following(context, barIndex);
  if (!next) return [];
  const target = root(next);
  const step = target > from ? target - 1 : target + 1;
  return [note(step, context.beatsPerBar - 0.5, 0.45, velocity(context, -4))];
};

/** Replaces the last beat of the clip with a run up to the next root. */
const withFill = (context: RenderContext, notes: ClipNote[]) => {
  if (!context.fill) return notes;
  const clipLength = context.chords.length * context.beatsPerBar;
  const start = clipLength - context.beatLength;
  const last = context.chords[context.chords.length - 1];
  const r = root(last);
  const run = [r, third(last), fifth(last), r + 12].map((pitch, i) =>
    note(pitch, start + (i * context.beatLength) / 4, context.beatLength / 4.5, velocity(context, 4 + i * 3))
  );
  return [...notes.filter((n) => n.start < start), ...run];
};

const bassPattern = (
  pattern: Omit<Pattern, "render">,
  bar: (context: RenderContext, chord: ChordInfo, barIndex: number) => ClipNote[]
): Pattern => ({
  ...pattern,
  render: (context) => {
    const notes = eachBar(context, (chord, barIndex) => bar(context, chord, barIndex));
    return notes.length ? withFill(context, notes) : notes;
  },
});

export const bass: Pattern[] = [
  bassPattern(
    {
      id: "pedal",
      description: "Long held root note for the whole bar. Calm and spacious; for ballads, intros and pads.",
      energy: [1, 3],
      suits: "busy",
    },
    (context, chord) => [note(root(chord), 0, context.beatsPerBar * 0.95, velocity(context))]
  ),
  bassPattern(
    {
      id: "root-quarters",
      description: "Root note on every beat. Simple and steady; locks the harmony down without getting busy.",
      energy: [3, 6],
      suits: "any",
    },
    (context, chord) => beats(context).map((t) => note(root(chord), t, context.beatLength * 0.85, velocity(context, t ? -4 : 6)))
  ),
  bassPattern(
    {
      id: "root-eighths",
      description: "Driving eighth notes on the root. Rock and punk energy; pushes the band forward.",
      energy: [5, 9],
      suits: "any",
    },
    (context, chord) => grid(context, 0.5).map((t, i) => note(root(chord), t, 0.4, velocity(context, i % 2 ? -8 : 2)))
  ),
  bassPattern(
    {
      id: "root-fifth",
      description: "Root on the strong beats, fifth on the others. Country, folk and two-beat feel; bouncy but simple.",
      energy: [3, 6],
      suits: "any",
    },
    (context, chord) => beats(context).map((t, i) => note(i % 2 ? fifth(chord) - 12 : root(chord), t, context.beatLength * 0.8, velocity(context, i % 2 ? -6 : 6)))
  ),
  bassPattern(
    {
      id: "octave-bounce",
      description: "Eighth notes jumping between the root and its octave. Disco and dance; very rhythmic and bright.",
      energy: [6, 10],
      suits: "sparse",
    },
    (context, chord) => grid(context, 0.5).map((t, i) => note(root(chord) + (i % 2 ? 12 : 0), t, 0.35, velocity(context, i % 2 ? -4 : 4)))
  ),
  bassPattern(
    {
      id: "walking",
      description: "Walking quarter notes through chord tones, stepping into the next chord. Jazz, swing and blues.",
      energy: [4, 7],
      suits: "any",
    },
    (context, chord, barIndex) => {
      const line = [root(chord), third(chord), fifth(chord), root(chord) + 12];
      const notes = beats(context).map((t, i) => note(line[i % line.length], t, context.beatLength * 0.9, velocity(context, i ? -2 : 6)));
      const lead = approach(context, barIndex, line[(beats(context).length - 1) % line.length]);
      if (lead.length) notes[notes.length - 1] = { ...lead[0], start: notes[notes.length - 1].start, duration: context.beatLength * 0.9 };
      return notes;
    }
  ),
  bassPattern(
    {
      id: "syncopated",
      description: "Funky sixteenth-note syncopation around the root with octave pops. For funk, R&B and busy grooves.",
      energy: [6, 10],
      suits: "sparse",
    },
    (context, chord) => {
      const r = root(chord);
      const hits: [number, number][] = [
        [0, r],
        [0.75, r],
        [1.5, r + 12],
        [2.5, r],
        [3, fifth(chord) - 12],
        [3.5, r + 12],
      ];
      return hits
        .filter(([t]) => t < context.beatsPerBar)
        .map(([t, pitch], i) => note(pitch, t, 0.22, velocity(context, i === 0 ? 8 : -2)));
    }
  ),
  bassPattern(
    {
      id: "arpeggio",
      description: "Eighth-note arpeggio up the chord tones. Melodic and flowing; for pop and electronic music.",
      energy: [4, 8],
      suits: "sparse",
    },
    (context, chord) => {
      const tones = [root(chord), third(chord), fifth(chord), root(chord) + 12];
      return grid(context, 0.5).map((t, i) => note(tones[i % tones.length], t, 0.45, velocity(context, i % 4 ? -6 : 4)));
    }
  ),
  bassPattern(
    {
      id: "rest",
      description: "Bass drops out for this bar. For breaks, or to leave room when another part carries the low end.",
      energy: [1, 2],
      suits: "busy",
    },
    () => []
  ),
];

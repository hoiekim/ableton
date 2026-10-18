import { ChordInfo, ClipNote, pitchAtOrAbove, voiceChord } from "../music";
import { Pattern, RenderContext, beats, eachBar, grid, note, velocity } from "./types";

const LOW = 55;
const HIGH = 76;

const voicing = (chord: ChordInfo) => voiceChord(chord, LOW, HIGH, 64);

const block = (context: RenderContext, chord: ChordInfo, start: number, duration: number, accent = 0): ClipNote[] => {
  const vel = velocity(context, accent);
  return voicing(chord).map((pitch) => note(pitch, start, duration, vel));
};

/** Left-hand root an octave or two below the voicing. */
const leftHand = (chord: ChordInfo) => pitchAtOrAbove(chord.root, 43);

/** A quick scale run up to the next chord in the clip's last beat. */
const withFill = (context: RenderContext, notes: ClipNote[]) => {
  if (!context.fill) return notes;
  const clipLength = context.chords.length * context.beatsPerBar;
  const start = clipLength - context.beatLength;
  const last = context.chords[context.chords.length - 1];
  const tones = voicing(last);
  const run = [...tones, tones[0] + 12].slice(0, 4);
  return [
    ...notes.filter((n) => n.start < start),
    ...run.map((pitch, i) => note(pitch, start + (i * context.beatLength) / 4, context.beatLength / 4, velocity(context, i * 4))),
  ];
};

const keysPattern = (
  pattern: Omit<Pattern, "render">,
  bar: (context: RenderContext, chord: ChordInfo) => ClipNote[]
): Pattern => ({
  ...pattern,
  render: (context) => {
    const notes = eachBar(context, (chord) => bar(context, chord));
    return notes.length ? withFill(context, notes) : notes;
  },
});

export const keys: Pattern[] = [
  keysPattern(
    {
      id: "pad",
      description: "Soft sustained chord held for the whole bar. Warm background harmony; leaves room for everyone else.",
      energy: [1, 4],
      suits: "busy",
    },
    (context, chord) => block(context, chord, 0, context.beatsPerBar * 0.98, -12)
  ),
  keysPattern(
    {
      id: "half-notes",
      description: "Chords on beats 1 and 3 with a low root in the left hand. Classic piano accompaniment for ballads and pop.",
      energy: [3, 6],
      suits: "any",
    },
    (context, chord) => [
      note(leftHand(chord), 0, context.beatsPerBar * 0.95, velocity(context)),
      ...grid(context, context.beatsPerBar / 2).flatMap((t) => block(context, chord, t, context.beatsPerBar / 2 - 0.1)),
    ]
  ),
  keysPattern(
    {
      id: "block-quarters",
      description: "Chords struck on every beat. Steady and full; for rock and gospel, or when the band needs a pulse.",
      energy: [5, 8],
      suits: "sparse",
    },
    (context, chord) => beats(context).flatMap((t, i) => block(context, chord, t, context.beatLength * 0.8, i ? -6 : 4))
  ),
  keysPattern(
    {
      id: "offbeat-stabs",
      description: "Short chord stabs on the off-beats (the 'and's). Reggae skank, ska and house piano.",
      energy: [5, 9],
      suits: "any",
    },
    (context, chord) => beats(context).flatMap((t) => block(context, chord, t + context.beatLength / 2, 0.2))
  ),
  keysPattern(
    {
      id: "comping",
      description: "Jazz comping: syncopated chord hits on 1 and the and-of-2. Conversational; good with walking bass and swing.",
      energy: [3, 7],
      suits: "any",
    },
    (context, chord) => [...block(context, chord, 0, 0.9, 2), ...block(context, chord, context.beatLength * 1.5, 0.45, -4)]
  ),
  keysPattern(
    {
      id: "arpeggio",
      description: "Rolling eighth-note arpeggio through the chord, up and back down. Flowing and melodic; for pop, film and electronic music.",
      energy: [3, 7],
      suits: "sparse",
    },
    (context, chord) => {
      const tones = voicing(chord);
      const line = [...tones, tones[0] + 12, ...tones.slice(1).reverse()];
      return grid(context, 0.5).map((t, i) => note(line[i % line.length], t, 0.45, velocity(context, i % 4 ? -8 : 2)));
    }
  ),
  keysPattern(
    {
      id: "broken-chord",
      description: "Alberti-style broken chord in sixteenths (low, high, middle, high). Busy and classical; adds motion.",
      energy: [5, 8],
      suits: "sparse",
    },
    (context, chord) => {
      const [low, middle, high] = voicing(chord);
      const figure = [low, high ?? middle, middle, high ?? middle];
      return grid(context, 0.25).map((t, i) => note(figure[i % 4], t, 0.22, velocity(context, i % 4 ? -10 : 0)));
    }
  ),
  keysPattern(
    {
      id: "rest",
      description: "Keys drop out for this bar. For breaks, or when the harmony is already full.",
      energy: [1, 2],
      suits: "busy",
    },
    () => []
  ),
];

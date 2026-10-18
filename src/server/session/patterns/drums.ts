import { ClipNote } from "../music";
import { Pattern, RenderContext, beats, eachBar, grid, note, velocity } from "./types";

// Every drum note comes from `context.kit`, which maps each sound to the note
// it plays in the loaded Drum Rack (see instrument.ts).

const HIT = 0.1;

/** Snare and toms over the last beat, getting louder. */
const fillNotes = (context: RenderContext, barStart: number) => {
  const { kit } = context;
  const start = barStart + context.beatsPerBar - context.beatLength;
  const toms = [kit["tom-high"], kit["tom-high"], kit["tom-mid"], kit["tom-low"]];
  return grid({ ...context, beatsPerBar: context.beatLength }, context.beatLength / 4).map((t, i) =>
    note(context.energy >= 6 ? toms[i % 4] : kit.snare, start + t, HIT, velocity(context, 4 + i * 6))
  );
};

/** Drops notes in the last beat of the clip when a fill replaces it. */
const withFill = (context: RenderContext, notes: ClipNote[]) => {
  if (!context.fill) return notes;
  const clipLength = context.chords.length * context.beatsPerBar;
  const fillStart = clipLength - context.beatLength;
  return [
    ...notes.filter((n) => n.start < fillStart || n.pitch === context.kit.kick),
    ...fillNotes(context, clipLength - context.beatsPerBar),
  ];
};

const withAccent = (context: RenderContext, notes: ClipNote[]) => {
  return context.accent ? [note(context.kit.crash, 0, HIT, velocity(context, 15)), ...notes] : notes;
};

const drumPattern = (pattern: Omit<Pattern, "render">, bar: (context: RenderContext) => ClipNote[]): Pattern => ({
  ...pattern,
  render: (context) => {
    const notes = eachBar(context, () => bar(context));
    return notes.length ? withAccent(context, withFill(context, notes)) : notes;
  },
});

/** Snare on the even beats (2 and 4 in 4/4). */
const backbeats = (context: RenderContext) => beats(context).filter((_, i) => i % 2 === 1);

const downbeats = (context: RenderContext) => beats(context).filter((_, i) => i % 2 === 0);

export const drums: Pattern[] = [
  drumPattern(
    {
      id: "backbeat",
      description: "Straight rock/pop groove: kick on 1 and 3, snare on 2 and 4, steady eighth-note hi-hats. The safe default for most songs.",
      energy: [4, 7],
      suits: "any",
      uses: ["kick", "snare", "closed-hat"],
    },
    (context) => [
      ...downbeats(context).map((t) => note(context.kit.kick, t, HIT, velocity(context, 10))),
      ...(context.energy >= 7 ? [note(context.kit.kick, context.beatsPerBar - context.beatLength * 1.5, HIT, velocity(context))] : []),
      ...backbeats(context).map((t) => note(context.kit.snare, t, HIT, velocity(context, 12))),
      ...grid(context, context.energy >= 8 ? 0.25 : 0.5).map((t, i) =>
        note(context.kit["closed-hat"], t, HIT, velocity(context, i % 2 ? -14 : -4))
      ),
    ]
  ),
  drumPattern(
    {
      id: "four-on-floor",
      description: "Dance groove: kick on every beat, clap on 2 and 4, open hi-hat on the off-beats. For house, disco and driving dance music.",
      energy: [6, 10],
      suits: "any",
      uses: ["kick", "clap", "open-hat"],
    },
    (context) => [
      ...beats(context).map((t) => note(context.kit.kick, t, HIT, velocity(context, 12))),
      ...backbeats(context).map((t) => note(context.kit.clap, t, HIT, velocity(context, 6))),
      ...beats(context).map((t) => note(context.kit["open-hat"], t + context.beatLength / 2, HIT, velocity(context, -6))),
    ]
  ),
  drumPattern(
    {
      id: "half-time",
      description: "Half-time feel: kick on 1, snare on 3, eighth-note hats. Heavy and laid back; good for slower sections or a breakdown.",
      energy: [3, 6],
      suits: "sparse",
      uses: ["kick", "snare", "closed-hat"],
    },
    (context) => [
      note(context.kit.kick, 0, HIT, velocity(context, 10)),
      note(context.kit.kick, context.beatsPerBar * 0.625, HIT, velocity(context)),
      note(context.kit.snare, context.beatsPerBar / 2, HIT, velocity(context, 12)),
      ...grid(context, 0.5).map((t, i) => note(context.kit["closed-hat"], t, HIT, velocity(context, i % 2 ? -16 : -6))),
    ]
  ),
  drumPattern(
    {
      id: "breakbeat",
      description: "Syncopated funk/hip-hop break: kick on 1 and the and-of-2, snare on 2 and 4 with ghost notes, busy hats. Use when the band is funky and rhythmic.",
      energy: [5, 9],
      suits: "busy",
      uses: ["kick", "snare", "closed-hat"],
    },
    (context) => [
      note(context.kit.kick, 0, HIT, velocity(context, 10)),
      note(context.kit.kick, context.beatLength * 1.5, HIT, velocity(context, 4)),
      note(context.kit.kick, context.beatLength * 2.5, HIT, velocity(context)),
      ...backbeats(context).map((t) => note(context.kit.snare, t, HIT, velocity(context, 12))),
      ...(context.energy >= 6 ? [note(context.kit.snare, context.beatLength * 1.75, HIT, velocity(context, -30))] : []),
      ...grid(context, 0.25).map((t, i) => note(context.kit["closed-hat"], t, HIT, velocity(context, i % 2 ? -20 : -8))),
    ]
  ),
  drumPattern(
    {
      id: "shuffle",
      description: "Swung shuffle: triplet-feel ride, kick on 1 and 3, snare on 2 and 4. For blues, swing and laid-back grooves.",
      energy: [3, 7],
      suits: "any",
      uses: ["kick", "snare", "ride"],
    },
    (context) => [
      ...downbeats(context).map((t) => note(context.kit.kick, t, HIT, velocity(context, 8))),
      ...backbeats(context).map((t) => note(context.kit.snare, t, HIT, velocity(context, 10))),
      ...beats(context).flatMap((t) => [
        note(context.kit.ride, t, HIT, velocity(context, -4)),
        note(context.kit.ride, t + (context.beatLength * 2) / 3, HIT, velocity(context, -16)),
      ]),
    ]
  ),
  drumPattern(
    {
      id: "sparse",
      description: "Minimal time-keeping: ride on the beats, kick on 1, rim click on 3. Quiet, leaves space; for intros, verses and soft parts.",
      energy: [1, 4],
      suits: "busy",
      uses: ["kick", "rim", "ride"],
    },
    (context) => [
      note(context.kit.kick, 0, HIT, velocity(context, 4)),
      note(context.kit.rim, context.beatsPerBar / 2, HIT, velocity(context, -4)),
      ...beats(context).map((t) => note(context.kit.ride, t, HIT, velocity(context, -10))),
    ]
  ),
  drumPattern(
    {
      id: "build",
      description: "Build-up: snare on every beat getting busier toward the end, kick on the beats. Use to lift into a bigger section.",
      energy: [6, 10],
      suits: "any",
      uses: ["kick", "snare"],
    },
    (context) => [
      ...beats(context).map((t) => note(context.kit.kick, t, HIT, velocity(context, 6))),
      ...grid(context, 0.5).map((t, i, all) => note(context.kit.snare, t, HIT, velocity(context, -20 + (i / all.length) * 30))),
    ]
  ),
  drumPattern(
    {
      id: "percussion-groove",
      description: "Backbeat with a hand-percussion layer: kick and snare, sixteenth-note shaker and syncopated percussion hits. Adds motion and a Latin/afro feel.",
      energy: [4, 8],
      suits: "sparse",
      uses: ["kick", "snare", "shaker", "perc"],
      requires: ["shaker", "tambourine", "conga", "cowbell", "perc"],
    },
    (context) => [
      ...downbeats(context).map((t) => note(context.kit.kick, t, HIT, velocity(context, 8))),
      ...backbeats(context).map((t) => note(context.kit.snare, t, HIT, velocity(context, 8))),
      ...grid(context, 0.25).map((t, i) => note(context.kit.shaker, t, HIT, velocity(context, i % 4 === 2 ? -6 : -18))),
      ...[0.75, 1.5, 2.75, 3.5]
        .map((t) => t * context.beatLength)
        .filter((t) => t < context.beatsPerBar)
        .map((t, i) => note(context.kit.perc, t, HIT, velocity(context, i % 2 ? -4 : 2))),
    ]
  ),
  drumPattern(
    {
      id: "tom-groove",
      description: "Tribal tom groove: rolling toms low to high with the kick underneath, no hi-hats. Big and dramatic; for builds and breakdowns.",
      energy: [5, 9],
      suits: "sparse",
      uses: ["kick", "tom-low", "tom-mid", "tom-high"],
      requires: ["tom"],
    },
    (context) => {
      const { kit } = context;
      const toms = [kit["tom-low"], kit["tom-low"], kit["tom-mid"], kit["tom-high"]];
      return [
        ...downbeats(context).map((t) => note(kit.kick, t, HIT, velocity(context, 8))),
        ...grid(context, 0.5).map((t, i) => note(toms[i % 4], t, HIT, velocity(context, i % 4 === 0 ? 6 : -6))),
      ];
    }
  ),
  drumPattern(
    {
      id: "rest",
      description: "Drums drop out for this bar. Use for a dramatic break or when the band is very quiet.",
      energy: [1, 2],
      suits: "any",
      uses: [],
    },
    () => []
  ),
];

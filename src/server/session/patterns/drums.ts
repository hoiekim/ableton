import { ClipNote } from "../music";
import { Pattern, RenderContext, beats, eachBar, grid, note, velocity } from "./types";

// General MIDI drum map, which Live's Drum Racks follow (C1 = kick).
const KICK = 36;
const SNARE = 38;
const CLAP = 39;
const CLOSED_HAT = 42;
const OPEN_HAT = 46;
const CRASH = 49;
const RIDE = 51;
const RIM = 37;
const LOW_TOM = 45;
const MID_TOM = 47;
const HIGH_TOM = 50;

const HIT = 0.1;

/** Snare and toms over the last beat, getting louder. */
const fillNotes = (context: RenderContext, barStart: number) => {
  const start = barStart + context.beatsPerBar - context.beatLength;
  const toms = [HIGH_TOM, HIGH_TOM, MID_TOM, LOW_TOM];
  return grid({ ...context, beatsPerBar: context.beatLength }, context.beatLength / 4).map((t, i) =>
    note(context.energy >= 6 ? toms[i % 4] : SNARE, start + t, HIT, velocity(context, 4 + i * 6))
  );
};

/** Drops notes in the last beat of the clip when a fill replaces it. */
const withFill = (context: RenderContext, notes: ClipNote[]) => {
  if (!context.fill) return notes;
  const clipLength = context.chords.length * context.beatsPerBar;
  const fillStart = clipLength - context.beatLength;
  return [...notes.filter((n) => n.start < fillStart || n.pitch === KICK), ...fillNotes(context, clipLength - context.beatsPerBar)];
};

const withAccent = (context: RenderContext, notes: ClipNote[]) => {
  return context.accent ? [note(CRASH, 0, HIT, velocity(context, 15)), ...notes] : notes;
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

export const drums: Pattern[] = [
  drumPattern(
    {
      id: "backbeat",
      description: "Straight rock/pop groove: kick on 1 and 3, snare on 2 and 4, steady eighth-note hi-hats. The safe default for most songs.",
      energy: [4, 7],
      suits: "any",
    },
    (context) => [
      ...beats(context).filter((_, i) => i % 2 === 0).map((t) => note(KICK, t, HIT, velocity(context, 10))),
      ...(context.energy >= 7 ? [note(KICK, context.beatsPerBar - context.beatLength * 1.5, HIT, velocity(context))] : []),
      ...backbeats(context).map((t) => note(SNARE, t, HIT, velocity(context, 12))),
      ...grid(context, context.energy >= 8 ? 0.25 : 0.5).map((t, i) => note(CLOSED_HAT, t, HIT, velocity(context, i % 2 ? -14 : -4))),
    ]
  ),
  drumPattern(
    {
      id: "four-on-floor",
      description: "Dance groove: kick on every beat, clap on 2 and 4, open hi-hat on the off-beats. For house, disco and driving dance music.",
      energy: [6, 10],
      suits: "any",
    },
    (context) => [
      ...beats(context).map((t) => note(KICK, t, HIT, velocity(context, 12))),
      ...backbeats(context).map((t) => note(CLAP, t, HIT, velocity(context, 6))),
      ...beats(context).map((t) => note(OPEN_HAT, t + context.beatLength / 2, HIT, velocity(context, -6))),
    ]
  ),
  drumPattern(
    {
      id: "half-time",
      description: "Half-time feel: kick on 1, snare on 3, eighth-note hats. Heavy and laid back; good for slower sections or a breakdown.",
      energy: [3, 6],
      suits: "sparse",
    },
    (context) => [
      note(KICK, 0, HIT, velocity(context, 10)),
      note(KICK, context.beatsPerBar * 0.625, HIT, velocity(context)),
      note(SNARE, context.beatsPerBar / 2, HIT, velocity(context, 12)),
      ...grid(context, 0.5).map((t, i) => note(CLOSED_HAT, t, HIT, velocity(context, i % 2 ? -16 : -6))),
    ]
  ),
  drumPattern(
    {
      id: "breakbeat",
      description: "Syncopated funk/hip-hop break: kick on 1 and the and-of-2, snare on 2 and 4 with ghost notes, busy hats. Use when the band is funky and rhythmic.",
      energy: [5, 9],
      suits: "busy",
    },
    (context) => [
      note(KICK, 0, HIT, velocity(context, 10)),
      note(KICK, context.beatLength * 1.5, HIT, velocity(context, 4)),
      note(KICK, context.beatLength * 2.5, HIT, velocity(context)),
      ...backbeats(context).map((t) => note(SNARE, t, HIT, velocity(context, 12))),
      ...(context.energy >= 6 ? [note(SNARE, context.beatLength * 1.75, HIT, velocity(context, -30))] : []),
      ...grid(context, 0.25).map((t, i) => note(CLOSED_HAT, t, HIT, velocity(context, i % 2 ? -20 : -8))),
    ]
  ),
  drumPattern(
    {
      id: "shuffle",
      description: "Swung shuffle: triplet-feel hi-hats, kick on 1 and 3, snare on 2 and 4. For blues, swing and laid-back grooves.",
      energy: [3, 7],
      suits: "any",
    },
    (context) => [
      ...beats(context).filter((_, i) => i % 2 === 0).map((t) => note(KICK, t, HIT, velocity(context, 8))),
      ...backbeats(context).map((t) => note(SNARE, t, HIT, velocity(context, 10))),
      ...beats(context).flatMap((t) => [
        note(RIDE, t, HIT, velocity(context, -4)),
        note(RIDE, t + (context.beatLength * 2) / 3, HIT, velocity(context, -16)),
      ]),
    ]
  ),
  drumPattern(
    {
      id: "sparse",
      description: "Minimal time-keeping: ride on the beats, kick on 1, rim click on 3. Quiet, leaves space; for intros, verses and soft parts.",
      energy: [1, 4],
      suits: "busy",
    },
    (context) => [
      note(KICK, 0, HIT, velocity(context, 4)),
      note(RIM, context.beatsPerBar / 2, HIT, velocity(context, -4)),
      ...beats(context).map((t) => note(RIDE, t, HIT, velocity(context, -10))),
    ]
  ),
  drumPattern(
    {
      id: "build",
      description: "Build-up: snare on every beat getting busier toward the end, kick on the beats. Use to lift into a bigger section.",
      energy: [6, 10],
      suits: "any",
    },
    (context) => [
      ...beats(context).map((t) => note(KICK, t, HIT, velocity(context, 6))),
      ...grid(context, 0.5).map((t, i, all) => note(SNARE, t, HIT, velocity(context, -20 + (i / all.length) * 30))),
    ]
  ),
  drumPattern(
    {
      id: "rest",
      description: "Drums drop out for this bar. Use for a dramatic break or when the band is very quiet.",
      energy: [1, 2],
      suits: "any",
    },
    () => []
  ),
];

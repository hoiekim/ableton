import { describe, expect, test } from "bun:test";
import { Note } from "tonal";
import { initialTransport } from "common";
import { BarRecord, InputBar, analyzeBand } from "./analyze";
import { PlayerContext, describeState } from "./state";

/** The keys holding a root-position chord. */
const keys = (chord: string[]): InputBar => {
  const root = Note.midi(`${chord[0]}3`)!;
  return {
    deviceId: 2,
    trackName: "Keys",
    role: "chords",
    notes: chord.map((name) => ({
      pitch: root + ((Note.chroma(name)! - (root % 12) + 12) % 12),
      start: 0,
      duration: 3.9,
      velocity: 70,
      held: false,
    })),
  };
};

const bass = (root: string): InputBar => ({
  deviceId: 1,
  trackName: "Bass",
  role: "bass",
  notes: [{ pitch: Note.midi(`${root}2`)!, start: 0, duration: 3.9, velocity: 90, held: false }],
});

const record = (index: number, inputs: InputBar[], partial = false): BarRecord => ({ index, beatsPerBar: 4, inputs, partial });

const player: PlayerContext = { instrument: "guitar", targetBar: 2, phraseLength: 4, barsSinceFill: 1 };
const transport = { ...initialTransport, tempo: 120, isPlaying: true };

describe("describeState", () => {
  test("says when the next bar's chord comes from a clip", () => {
    const analysis = analyzeBand([record(1, [keys(["A", "C", "E", "G"])], true)], () => [keys(["F", "A", "C", "E"])]);
    expect(describeState(analysis, transport, player)).toContain("Chord for the next bar: Fmaj7 (from the Keys clip).");
  });

  test("names every track whose clip it comes from", () => {
    const analysis = analyzeBand([record(1, [keys(["A", "C", "E"])], true)], () => [bass("F"), keys(["F", "A", "C"])]);
    expect(describeState(analysis, transport, player)).toContain("Chord for the next bar: F (from the Bass and Keys clips).");
  });

  test("without clips it's still a guess", () => {
    const analysis = analyzeBand([record(1, [keys(["A", "C", "E", "G"])], true)]);
    expect(describeState(analysis, transport, player)).toContain("Chord for the next bar: Am7 (a guess: the last chord continuing).");
  });
});

describe("describeState with speech", () => {
  test("tells the decision model what was just said, after the direction", () => {
    const text = describeState(analyzeBand([]), initialTransport, {
      instrument: "drums",
      targetBar: 6,
      phraseLength: 4,
      barsSinceFill: 2,
      direction: "punk",
      speech: [
        { text: "Are you ready?", trackName: "Vocals", when: "just before playback started" },
        { text: "ok let's go, give me a cue", trackName: "Vocals", when: "last bar" },
      ],
    });
    expect(text.split("\n").slice(0, 3)).toEqual([
      'The musician wants: "punk".',
      'Heard on Vocals just before playback started: "Are you ready?"',
      'Heard on Vocals last bar: "ok let\'s go, give me a cue"',
    ]);
  });
});

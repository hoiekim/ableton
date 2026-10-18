import { describe, expect, test } from "bun:test";
import { BarRecord, analyzeBand, detectChord, detectKey, detectLoop } from "./analyze";
import { Note } from "tonal";

const profile = (notes: string[], weights: number[] = []) => {
  const pcs = new Array(12).fill(0);
  notes.forEach((note, i) => (pcs[Note.chroma(note)!] += weights[i] ?? 1));
  return pcs;
};

/** A bar of the band: bass root in eighths plus a sustained chord in the keys. */
const bar = (index: number, chord: string[]): BarRecord => {
  const root = Note.midi(`${chord[0]}2`)!;
  return {
    index,
    beatsPerBar: 4,
    inputs: [
      {
        deviceId: 1,
        trackName: "Bass",
        role: "bass",
        notes: Array.from({ length: 8 }, (_, i) => ({ pitch: root, start: i * 0.5, duration: 0.4, velocity: 90, held: false })),
      },
      {
        deviceId: 2,
        trackName: "Keys",
        role: "chords",
        notes: chord.map((name) => ({ pitch: Note.midi(`${name}4`)!, start: 0, duration: 3.9, velocity: 70, held: false })),
      },
    ],
  };
};

const LOOP = [
  ["A", "C", "E", "G"],
  ["F", "A", "C", "E"],
  ["C", "E", "G"],
  ["G", "B", "D"],
];

describe("detectChord", () => {
  test("names seventh chords and plain triads", () => {
    expect(detectChord(profile(["A", "C", "E", "G"]), 9)?.symbol).toBe("Am7");
    expect(detectChord(profile(["F", "A", "C", "E"]), 5)?.symbol).toBe("Fmaj7");
    expect(detectChord(profile(["G", "B", "D"]), 7)?.symbol).toBe("G");
  });

  test("prefers the chord rooted on the bass note", () => {
    // A C E G is Am7 or C6; with C in the bass it's C6.
    expect(detectChord(profile(["A", "C", "E", "G"]), 0)?.root).toBe(0);
  });

  test("fills in a triad from a lone root using the key", () => {
    const chord = detectChord(profile(["D"]), 2, { tonic: 0, mode: "major", name: "C major" });
    expect(chord?.symbol).toBe("Dm");
  });

  test("returns nothing for silence", () => {
    expect(detectChord(new Array(12).fill(0), undefined)).toBeUndefined();
  });
});

describe("detectKey", () => {
  test("finds C major and A minor", () => {
    expect(detectKey(profile(["C", "D", "E", "F", "G", "A", "B"], [3, 1, 2, 1, 2.5, 1, 1]))?.name).toBe("C major");
    expect(detectKey(profile(["A", "B", "C", "D", "E", "F", "G"], [3, 1, 2, 1, 2.5, 1, 1]))?.name).toBe("A minor");
  });
});

describe("detectLoop", () => {
  test("finds a repeating 4-bar progression", () => {
    expect(detectLoop(["Am", "F", "C", "G", "Am", "F", "C", "G"])?.length).toBe(4);
  });

  test("guesses a loop as soon as it starts repeating, with low confidence", () => {
    const loop = detectLoop(["Am", "F", "C", "G", "Am"]);
    expect(loop?.length).toBe(4);
    expect(loop?.confidence).toBeLessThan(0.5);
  });

  test("isn't put off by an odd bar before the loop", () => {
    // The first bar was only partly heard; the loop shows once F comes round again.
    expect(detectLoop(["C6", "F", "C", "G", "Am", "F"])).toMatchObject({ length: 4 });
  });

  test("drops the loop as soon as the progression changes", () => {
    expect(detectLoop(["Am", "F", "C", "G", "Am", "F", "C", "G", "Dm"])).toBeUndefined();
  });

  test("finds a 1-bar vamp", () => {
    expect(detectLoop(["Am", "Am", "Am"])?.length).toBe(1);
  });

  test("finds nothing in a progression that doesn't repeat", () => {
    expect(detectLoop(["Am", "F", "C", "G", "Dm", "E", "Bb", "D"])).toBeUndefined();
  });
});

describe("analyzeBand", () => {
  const records = Array.from({ length: 8 }, (_, i) => bar(i + 1, LOOP[i % 4]));
  const analysis = analyzeBand(records);

  test("reads each bar's chord and the key", () => {
    expect(analysis.bars.map((b) => b.chord?.symbol)).toEqual(["Am7", "Fmaj7", "C", "G", "Am7", "Fmaj7", "C", "G"]);
    expect(analysis.key?.name).toMatch(/A minor|C major/);
  });

  test("predicts upcoming chords from the loop", () => {
    expect(analysis.loopLength).toBe(4);
    expect(analysis.chordAt(9)).toMatchObject({ predicted: true, chord: { symbol: "Am7" } });
    expect(analysis.chordAt(10).chord?.symbol).toBe("Fmaj7");
    expect(analysis.chordAt(12).chord?.symbol).toBe("G");
  });

  test("describes the parts", () => {
    const [bass, keys] = analysis.bars[0].parts;
    expect(bass).toMatchObject({ role: "bass", onsets: 8, grid: "x.x.x.x.x.x.x.x." });
    expect(keys).toMatchObject({ role: "chords", onsets: 4 });
  });

  test("reads slightly early or late notes as on the grid", () => {
    const early = bar(1, LOOP[0]);
    early.inputs[0].notes = early.inputs[0].notes.map((note, i) => ({ ...note, start: note.start + (i % 2 ? -0.01 : 0.01) }));
    expect(analyzeBand([early]).bars[0].parts[0].grid).toBe("x.x.x.x.x.x.x.x.");
  });

  test("holds the last chord when there's no loop yet", () => {
    const short = analyzeBand([bar(1, LOOP[0]), bar(2, LOOP[1])]);
    expect(short.chordAt(3)).toMatchObject({ predicted: true, chord: { symbol: "Fmaj7" } });
  });
});

describe("analyzeBand with the band's clips", () => {
  /** The clips play the loop from bar 1: Bass and Keys, as `bar` builds them. */
  const fromClips = (index: number) => bar(index, LOOP[(index - 1) % 4]).inputs;
  const partial = (index: number): BarRecord => ({ ...bar(index, LOOP[(index - 1) % 4]), partial: true });

  test("reads the next bar's chord from the clips before it's been heard", () => {
    const analysis = analyzeBand([partial(1)], fromClips);
    expect(analysis.chordAt(2)).toMatchObject({ source: "clip", predicted: true, chord: { symbol: "Fmaj7" }, tracks: ["Bass", "Keys"] });
    expect(analysis.chordAt(3).chord?.symbol).toBe("C");
    expect(analysis.chordAt(2).confidence).toBeGreaterThan(0.9);
  });

  test("covers the bar in progress too", () => {
    expect(analyzeBand([partial(1)], fromClips).chordAt(1)).toMatchObject({ source: "clip", chord: { symbol: "Am7" } });
  });

  test("prefers the clips over the repeating loop", () => {
    // The band launched a new progression: the clips say Dm for bar 9.
    const records = Array.from({ length: 8 }, (_, i) => bar(i + 1, LOOP[i % 4]));
    const analysis = analyzeBand(records, (index) => (index === 9 ? bar(9, ["D", "F", "A"]).inputs : fromClips(index)));
    expect(analysis.loopLength).toBe(4);
    expect(analysis.chordAt(9)).toMatchObject({ source: "clip", chord: { symbol: "Dm" } });
  });

  test("keeps what was heard in finished bars", () => {
    const analysis = analyzeBand([bar(1, LOOP[0]), partial(2)], () => bar(0, ["D", "F", "A"]).inputs);
    expect(analysis.chordAt(1)).toMatchObject({ source: "heard", chord: { symbol: "Am7" } });
  });

  test("falls back to the loop or the held chord where the clips are silent", () => {
    const records = [bar(1, LOOP[0]), bar(2, LOOP[1])];
    const silent = analyzeBand(records, (index) => fromClips(index).map((input) => ({ ...input, notes: [] })));
    expect(silent.chordAt(3)).toMatchObject({ source: "held", chord: { symbol: "Fmaj7" } });
  });

  test("a drum clip says nothing about the chord", () => {
    const drums = (index: number) => [{ deviceId: 9, trackName: "Drums", role: "drums" as const, notes: bar(index, ["C"]).inputs[0].notes }];
    expect(analyzeBand([bar(1, LOOP[0]), bar(2, LOOP[1])], drums).chordAt(3).source).toBe("held");
  });
});

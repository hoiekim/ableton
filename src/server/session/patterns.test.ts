import { describe, expect, test } from "bun:test";
import { instruments } from "common";
import { STANDARD_KIT } from "./instrument";
import { chordFromSymbol, seededRandom } from "./music";
import { RenderContext, builtInPatterns } from "./patterns";

const chords = ["Am7", "Fmaj7"].map((symbol) => chordFromSymbol(symbol)!);

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({
  chords,
  nextChord: chordFromSymbol("C"),
  beatsPerBar: 4,
  beatLength: 1,
  energy: 6,
  fill: false,
  accent: false,
  kit: STANDARD_KIT,
  random: seededRandom(1),
  ...overrides,
});

describe.each([...instruments])("%s patterns", (instrument) => {
  const patterns = builtInPatterns[instrument];

  test("have unique ids and descriptions", () => {
    const ids = patterns.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    patterns.forEach((p) => expect(p.description.length).toBeGreaterThan(20));
  });

  test.each(patterns.map((p) => [p.id, p] as const))("%s renders valid notes inside the clip", (_, pattern) => {
    for (const fill of [false, true]) {
      for (const energy of [1, 5, 10]) {
        const notes = pattern.render(context({ fill, energy }));
        for (const note of notes) {
          expect(note.start).toBeGreaterThanOrEqual(0);
          expect(note.start).toBeLessThan(8);
          expect(note.duration).toBeGreaterThan(0);
          expect(note.pitch).toBeGreaterThanOrEqual(0);
          expect(note.pitch).toBeLessThanOrEqual(127);
          expect(note.velocity).toBeGreaterThanOrEqual(1);
          expect(note.velocity).toBeLessThanOrEqual(127);
        }
        if (pattern.id !== "rest") expect(notes.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("harmony", () => {
  const pcs = (symbol: string) => {
    const chord = chordFromSymbol(symbol)!;
    return new Set(chord.intervals.map((i) => (chord.root + i) % 12));
  };

  test("keys voicings use only chord tones", () => {
    for (const pattern of builtInPatterns.keys.filter((p) => p.id !== "rest")) {
      const notes = pattern.render(context({ chords: [chordFromSymbol("Am7")!] }));
      const allowed = pcs("Am7");
      notes.forEach((note) => expect(allowed.has(note.pitch % 12)).toBe(true));
    }
  });

  test("bass roots follow the chord of each bar", () => {
    const bass = builtInPatterns.bass.find((p) => p.id === "root-eighths")!;
    const notes = bass.render(context());
    expect(notes.filter((n) => n.start < 4).every((n) => n.pitch % 12 === 9)).toBe(true);
    expect(notes.filter((n) => n.start >= 4).every((n) => n.pitch % 12 === 5)).toBe(true);
  });

  test("rendering is reproducible for the same seed", () => {
    const drums = builtInPatterns.drums[0];
    expect(drums.render(context({ random: seededRandom(7) }))).toEqual(drums.render(context({ random: seededRandom(7) })));
  });
});

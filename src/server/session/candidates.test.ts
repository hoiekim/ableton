import { describe, expect, test } from "bun:test";
import { PartFeatures } from "./analyze";
import { BarContext, generateCandidates, pickFromOdds, renderRecipe } from "./candidates";
import { STANDARD_KIT } from "./instrument";
import { chordFromSymbol } from "./music";
import { optionsFor } from "./patterns";

const part = (role: PartFeatures["role"], trackName: string, grid: string): PartFeatures => ({
  deviceId: trackName.length,
  trackName,
  role,
  onsets: [...grid].filter((c) => c === "x").length,
  grid,
  velocity: 80,
  register: 50,
  polyphony: role === "chords" ? 3 : 1,
  notes: [],
});

/** Funk: bass on 1, 2&, 3, 4&; keys stabs on 2 and 4; a singer on 1, 2 and 3. */
const BAND = [part("bass", "Bass", "x.....x.x.....x."), part("chords", "Keys", "....x.......x..."), part("melody", "Vocals", "x...x...x.......")];

const context = (overrides: Partial<BarContext> = {}): BarContext => ({
  instrument: "drums",
  options: optionsFor(overrides.instrument ?? "drums", undefined),
  chords: [chordFromSymbol("Am7")!],
  nextChord: chordFromSymbol("Fmaj7"),
  beatsPerBar: 4,
  beatLength: 1,
  energy: 6,
  ending: "none",
  accent: false,
  kit: STANDARD_KIT,
  trackId: 7,
  previous: { pattern: "backbeat", variant: "base", energy: 6 },
  band: BAND,
  max: 32,
  ...overrides,
});

describe("generateCandidates", () => {
  test("offers the last bar, the patterns near the energy, variations and a rest, within the limit", () => {
    const candidates = generateCandidates(context());
    expect(candidates.length).toBeGreaterThan(15);
    expect(candidates.length).toBeLessThanOrEqual(32);
    expect(candidates[0]).toMatchObject({ id: "backbeat", variant: "base" });
    expect(candidates[0].description).toContain("same as your last bar");
    expect(candidates.map((c) => c.id)).toEqual(expect.arrayContaining(["backbeat~lock", "backbeat~ghosts", "rest"]));
    // Each rendering is offered once.
    const notes = candidates.map((c) => JSON.stringify(c.notes));
    expect(new Set(notes).size).toBe(notes.length);
  });

  test("the locked bar's kick plays the bass's rhythm, and says so", () => {
    const lock = generateCandidates(context()).find((c) => c.id === "backbeat~lock")!;
    const kicks = lock.notes.filter((n) => n.pitch === STANDARD_KIT.kick).map((n) => n.start);
    expect(kicks).toEqual([0, 1.5, 2, 3.5]);
    expect(lock.description).toStartWith("Locked to the band: kick 1, 2&, 3, 4&");
    expect(lock.description).toContain("kick lands with 4 of the 4 Bass notes (locked)");
  });

  test("descriptions say what's played and how it sits with the band, briefly", () => {
    for (const instrument of ["drums", "bass", "keys", "guitar"] as const) {
      const previous = { drums: "backbeat", bass: "root-eighths", keys: "block-quarters", guitar: "strum-quarters" }[instrument];
      for (const candidate of generateCandidates(context({ instrument, options: optionsFor(instrument, undefined), previous: { pattern: previous, variant: "base", energy: 6 } }))) {
        expect(candidate.description).toContain(candidate.pattern === "rest" ? "Drops out" : "Energy");
        // About 50 tokens at most: Jev reads every one, every bar.
        expect(candidate.description.length).toBeLessThan(260);
      }
    }
    const keys = generateCandidates(context({ instrument: "keys", options: optionsFor("keys", undefined), previous: undefined }));
    expect(keys.find((c) => c.id === "offbeat-stabs")!.description).toContain("4 of its 4 hits in the melody's rests");
  });

  test("fills are offered as twins of the leading bars, or played by all", () => {
    const offered = generateCandidates(context({ ending: "offer" }));
    expect(offered.filter((c) => c.fill).length).toBeGreaterThan(0);
    expect(offered.find((c) => c.id === "backbeat+fill")!.description).toContain("ends with a fill");
    const all = generateCandidates(context({ ending: "fill" }));
    expect(all.filter((c) => c.pattern !== "rest").every((c) => c.fill)).toBe(true);
    expect(generateCandidates(context()).some((c) => c.fill)).toBe(false);
  });

  test("a notch harder and softer are offered for the leading patterns", () => {
    const ids = generateCandidates(context()).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["backbeat@7", "backbeat@5"]));
  });

  test("the same recipe plays the same notes, and melodic recipes follow the chords", () => {
    const recipe = { pattern: "root-fifth", variant: "base" as const, energy: 6 };
    const bass = context({ instrument: "bass", options: optionsFor("bass", undefined) });
    expect(renderRecipe(recipe, bass, "none")).toEqual(renderRecipe(recipe, bass, "none")!);
    const onF = renderRecipe(recipe, { ...bass, chords: [chordFromSymbol("F")!] }, "none")!;
    expect(onF[0].pitch % 12).toBe(5);
  });

  test("variations that don't apply aren't offered", () => {
    const noBass = generateCandidates(context({ band: [] })).map((c) => c.id);
    expect(noBass).not.toContain("backbeat~lock");
  });
});

describe("pickFromOdds", () => {
  const odds = { a: 0.4, b: 0.35, c: 0.2, d: 0.05 };
  test("picks among the options near the top, the same way for the same seed", () => {
    const picks = Array.from({ length: 200 }, (_, seed) => pickFromOdds(odds, seed, { band: 0.7, stickiness: 1 }));
    expect(new Set(picks)).toEqual(new Set(["a", "b"]));
    expect(pickFromOdds(odds, 42, { band: 0.7, stickiness: 1 })).toBe(pickFromOdds(odds, 42, { band: 0.7, stickiness: 1 })!);
  });

  test("keeping the same part is favoured", () => {
    const count = (sticky?: string) =>
      Array.from({ length: 400 }, (_, seed) => pickFromOdds(odds, seed, { band: 0.7, stickiness: 2, sticky })).filter((p) => p === "b").length;
    expect(count("b")).toBeGreaterThan(count());
  });

  test("a band of 1 always takes the top", () => {
    expect(new Set(Array.from({ length: 50 }, (_, seed) => pickFromOdds(odds, seed, { band: 1, stickiness: 1 })))).toEqual(new Set(["a"]));
  });
});

import { describe, expect, test } from "bun:test";
import { BandPlan, ENDINGS, KEEP, SECTIONS, describeTarget, phraseStart, planFromAnswers, planQuestions, targetFor } from "./plan";

const plan = (sections: [keyof typeof SECTIONS, keyof typeof ENDINGS][], intensity = 5, from = 5): BandPlan => ({
  decidedAt: from - 1,
  intensity,
  provider: "jev",
  phrases: sections.map(([section, ending], i) => ({ start: from + i * 4, section, ending })),
});

describe("targetFor", () => {
  const shaped = plan([
    ["build", "big-fill"],
    ["climax", "stop"],
    ["breakdown", "none"],
    ["break", "fill"],
  ]);
  const energies = (start: number) => [0, 1, 2, 3].map((i) => targetFor(shaped, start + i, 4)!.energy);

  test("a build rises to two above the intensity, a climax is at least 8, a breakdown falls, a break rests", () => {
    expect(energies(5)).toEqual([4, 5, 6, 7]);
    expect(energies(9)).toEqual([8, 8, 8, 8]);
    expect(energies(13)).toEqual([4, 3, 2, 1]);
    expect(energies(17)).toEqual([1, 1, 1, 1]);
  });

  test("the ending applies in the phrase's last bar, and the next section is known", () => {
    expect(targetFor(shaped, 7, 4)).toMatchObject({ section: "build", barInPhrase: 3, lastBar: false, ending: "big-fill", next: "climax" });
    expect(targetFor(shaped, 8, 4)).toMatchObject({ barInPhrase: 4, lastBar: true, ending: "big-fill" });
    expect(targetFor(shaped, 12, 4)).toMatchObject({ section: "climax", lastBar: true, ending: "stop" });
  });

  test("energy stays in 1–10, and there's no target outside the plan", () => {
    const loud = plan([["build", "none"]], 10);
    expect(targetFor(loud, 8, 4)!.energy).toBe(10);
    expect(targetFor(shaped, 4, 4)).toBeUndefined();
    expect(targetFor(shaped, 21, 4)).toBeUndefined();
    expect(targetFor(undefined, 5, 4)).toBeUndefined();
  });

  test("phrases start at bar 1, 5, 9…", () => {
    expect([1, 4, 5, 8, 9].map((bar) => phraseStart(bar, 4))).toEqual([1, 1, 5, 5, 9]);
  });

  test("a player reads the plan for its bar in one line", () => {
    expect(describeTarget(shaped, targetFor(shaped, 7, 4)!)).toBe(
      "Band plan (made in bar 4): this phrase is a BUILD, bar 3 of 4, aim for energy 6; it ends with a big fill. Then: CLIMAX, BREAKDOWN, BREAK."
    );
  });
});

describe("planning questions and answers", () => {
  const request = { state: "", starts: [9, 13, 17, 21], phraseLength: 4, current: plan([["groove", "none"], ["build", "fill"]], 5, 9) };

  test("a section and an ending per phrase, keep where something is planned, and the intensity", () => {
    const questions = planQuestions(request, Array.from({ length: 10 }, (_, i) => `${i + 1}`)) as Record<string, { criteria: unknown }>;
    expect(Object.keys(questions)).toEqual(["section1", "ending1", "section2", "ending2", "section3", "ending3", "section4", "ending4", "intensity"]);
    expect(Object.keys(questions.section1.criteria as object)[0]).toBe(KEEP);
    expect(Object.keys(questions.section3.criteria as object)).not.toContain(KEEP);
  });

  test("keep keeps the planned phrase; a new answer changes it", () => {
    const next = planFromAnswers(
      { section1: { choice: KEEP }, ending1: { choice: "big-fill" }, section2: { choice: "climax" }, ending2: { choice: KEEP }, intensity: { score: 6.4 } },
      request,
      8,
      "jev"
    );
    expect(next.phrases.slice(0, 2)).toEqual([
      { start: 9, section: "groove", ending: "big-fill" },
      { start: 13, section: "climax", ending: "fill" },
    ]);
    // Unplanned phrases with no usable answer are a plain groove.
    expect(next.phrases[2]).toEqual({ start: 17, section: "groove", ending: "none" });
    expect(next).toMatchObject({ decidedAt: 8, intensity: 7, provider: "jev" });
  });
});

import { describe, expect, test } from "bun:test";
import { analyzeBand } from "../analyze";
import { defaultConfig } from "../config";
import { builtInPatterns, optionsFor } from "../patterns";
import { createJevProvider } from "./jev";
import { DecisionRequest } from "./types";

const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  instrument: "bass",
  state: "The next bar is bar 5 of the jam. Tempo 120 BPM, 4/4 time.",
  analysis: analyzeBand([]),
  patterns: optionsFor("bass", undefined),
  targetBar: 5,
  phraseLength: 4,
  previous: { pattern: "root-fifth", energy: 5 },
  barsSinceFill: 3,
  seed: 1,
  ...overrides,
});

/** A fetch that records the request and answers like the TypeSafe API. */
const fakeApi = (answers: Record<string, unknown>) => {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 120, output_tokens: 0 } }), {
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
};

const ANSWERS = {
  pattern: { type: "choice", choice: "walking", confidence: 0.8, probabilities: { walking: 0.8 } },
  energy: { type: "score", score: 5.6, confidence: 0.7, legend: {}, probabilities: {} },
  fill: { type: "noul", noul: 0.7 },
};

describe("Jev provider", () => {
  process.env.TYPESAFE_API_KEY ??= "test-key";

  test("sends the state and one question each for pattern, energy and fill", async () => {
    const api = fakeApi(ANSWERS);
    const provider = createJevProvider(defaultConfig.jev, api.fetch);
    const decision = await provider.decide(request(), { timeoutMs: 1000 });

    expect(api.calls).toHaveLength(1);
    const { url, body, headers } = api.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(headers.get("authorization")).toStartWith("Bearer ");
    expect(body.model).toBe("jev-latest");
    expect(body.state).toContain("bar 5");
    expect(body.questions.pattern.type).toBe("choice");
    expect(Object.keys(body.questions.pattern.criteria)).toEqual([...builtInPatterns.bass.map((p) => p.id), "hold"]);
    expect(body.questions.energy).toMatchObject({ type: "score" });
    expect(body.questions.energy.criteria).toHaveLength(10);
    expect(body.questions.fill.type).toBe("noul");

    expect(decision).toMatchObject({ pattern: "walking", energy: 7, fill: true, provider: "jev", confidence: 0.8 });
    expect(decision.odds).toEqual([{ pattern: "walking", p: 0.8 }]);
    expect(decision.fillP).toBe(0.7);
    expect(decision.trace?.questions).toEqual(body.questions);
    expect((decision.trace?.received as any).answers.pattern.choice).toBe("walking");
  });

  test("passes the musician's direction to every question", async () => {
    const api = fakeApi(ANSWERS);
    await createJevProvider(defaultConfig.jev, api.fetch).decide(request({ direction: "dub reggae" }), { timeoutMs: 1000 });
    for (const question of Object.values(api.calls[0].body.questions) as { instructions: string }[]) {
      expect(question.instructions).toContain('The musician wants: "dub reggae"');
    }
  });

  test("asks every question with what was just said in mind, and lets a cue bring a fill early", async () => {
    const api = fakeApi(ANSWERS);
    const speech = [{ text: "ok let's go, give me a cue", trackName: "Vocals", when: "this bar" }];
    await createJevProvider(defaultConfig.jev, api.fetch).decide(request({ speech, cueAt: Date.now() }), { timeoutMs: 1000 });
    const { questions } = api.calls[0].body;
    for (const question of Object.values(questions) as { instructions: string }[]) {
      expect(question.instructions).toContain("Someone in the band just spoke or sang");
    }
    expect(questions.fill.instructions).toContain("play one now if someone just asked for a cue");
    expect(questions.fill.instructions).not.toContain("never in a bar that starts a phrase");

    await createJevProvider(defaultConfig.jev, api.fetch).decide(request(), { timeoutMs: 1000 });
    expect(api.calls[1].body.questions.pattern.instructions).not.toContain("spoke or sang");
    expect(api.calls[1].body.questions.fill.instructions).toContain("never in a bar that starts a phrase");
  });

  test("asks whether to come in now only when asked early", async () => {
    const api = fakeApi({ ...ANSWERS, join: { noul: 0.2 } });
    const jev = createJevProvider(defaultConfig.jev, api.fetch);
    const early = await jev.decide(request({ joinBar: 5 }), { timeoutMs: 1000 });
    expect(api.calls[0].body.questions.join).toMatchObject({ type: "noul" });
    expect(api.calls[0].body.questions.join.instructions).toContain("come in at bar 5");
    expect(early.join).toBe(false);
    const normal = await jev.decide(request(), { timeoutMs: 1000 });
    expect(api.calls[1].body.questions.join).toBeUndefined();
    expect(normal.join).toBeUndefined();
  });

  test("leaves out the energy question when the device sets energy", async () => {
    const api = fakeApi({ pattern: ANSWERS.pattern, fill: ANSWERS.fill });
    const provider = createJevProvider(defaultConfig.jev, api.fetch);
    const decision = await provider.decide(request({ energyOverride: 3 }), { timeoutMs: 1000 });
    expect(api.calls[0].body.questions.energy).toBeUndefined();
    expect(decision.energy).toBe(3);
  });

  test("hold keeps the previous pattern and energy", async () => {
    const api = fakeApi({ ...ANSWERS, pattern: { ...ANSWERS.pattern, choice: "hold" } });
    const decision = await createJevProvider(defaultConfig.jev, api.fetch).decide(request(), { timeoutMs: 1000 });
    expect(decision).toMatchObject({ pattern: "root-fifth", energy: 5, provider: "jev" });
  });

  test("an unsure answer falls back to local rules", async () => {
    const api = fakeApi({ ...ANSWERS, pattern: { ...ANSWERS.pattern, confidence: 0.1 } });
    const decision = await createJevProvider(defaultConfig.jev, api.fetch).decide(request(), { timeoutMs: 1000 });
    expect(decision.provider).toBe("local");
    expect(decision.fallbackReason).toContain("unsure");
  });
});

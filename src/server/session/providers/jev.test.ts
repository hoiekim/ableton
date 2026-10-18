import { describe, expect, test } from "bun:test";
import { analyzeBand } from "../analyze";
import { defaultConfig } from "../config";
import { builtInPatterns } from "../patterns";
import { createJevProvider } from "./jev";
import { DecisionRequest } from "./types";

const request = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  instrument: "bass",
  state: "The next bar is bar 5 of the jam. Tempo 120 BPM, 4/4 time.",
  analysis: analyzeBand([]),
  patterns: builtInPatterns.bass,
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

    expect(decision).toEqual({ pattern: "walking", energy: 7, fill: true, provider: "jev", confidence: 0.8 });
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

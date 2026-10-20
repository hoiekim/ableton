import { SessionConfig } from "../config";
import { clamp } from "../music";
import { HOLD, HOLD_DESCRIPTION } from "../patterns";
import { pickFromOdds } from "../candidates";
import { planQuestions } from "../plan";
import { decideLocally } from "./local";
import { Decision, DecisionProvider, DecisionRequest } from "./types";

// TypeSafe's REST API, called directly: the official SDK reads response bodies
// in a way Bun rejects ("Body already used").
const DEFAULT_BASE_URL = "https://api.typesafe.ai";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface JevAnswers {
  pattern: { choice: string; confidence: number; probabilities?: Record<string, number> };
  energy?: { score: number };
  fill: { noul: number };
  join?: { noul: number };
}

const ENERGY_LEVELS = [
  "1: barely there, a few soft notes",
  "2: very quiet and sparse",
  "3: quiet, relaxed",
  "4: gentle but present",
  "5: medium, comfortable groove",
  "6: confident and full",
  "7: strong, driving",
  "8: loud and busy",
  "9: very intense",
  "10: as hard and busy as possible",
];

/** The questions sent to Jev for one decision. */
export const buildQuestions = (request: DecisionRequest, config: SessionConfig["jev"]) => {
  const direction = request.direction ? `The musician wants: "${request.direction}". Follow it.` : "";
  const heard = request.speech?.length
    ? 'Someone in the band just spoke or sang (the "Heard on" lines). If it\'s meant for the band, like a count-in, a cue, "take it down" or "let\'s go", do what it asks. If it\'s lyrics, fit their mood.'
    : "";
  const preamble = [config.instructions, direction, heard].filter(Boolean).map((line) => `${line}\n`).join("");
  const fillRule =
    request.cueAt !== undefined
      ? "A fill cues the band into what comes next: play one now if someone just asked for a cue, a fill or a change; otherwise only in the last bar of a phrase."
      : "Fills go in the last bar of a phrase, leading into the next phrase or a new section; never in a bar that starts a phrase.";
  const join = request.joinBar !== undefined && {
    join: {
      type: "noul",
      instructions:
        `${preamble}You haven't started playing yet; you're set to come in at bar ${request.joinBar}. Start playing in the next bar instead. ` +
        "Start if someone just told the band to go, counted in, or asked you to come in; wait if they only asked whether everyone is ready, or said something else.",
    },
  };
  // Concrete bars: each option is the part itself, energy and any fill included.
  if (request.candidates?.length) {
    return {
      pattern: {
        type: "choice",
        instructions:
          `${preamble}You are the ${request.instrument} player in a live jam. Choose exactly what to play next. ` +
          "Each option is a concrete part, with how it sits with the band and how it differs from what you just played.",
        criteria: Object.fromEntries(request.candidates.map((candidate) => [candidate.id, candidate.description])),
      },
      ...join,
    };
  }
  const criteria: Record<string, string> = Object.fromEntries(request.patterns.map((p) => [p.id, p.description]));
  if (request.previous) criteria[HOLD] = HOLD_DESCRIPTION;
  return {
    pattern: {
      type: "choice",
      instructions: `${preamble}You are the ${request.instrument} player in a live jam. Choose what to play in the next bar so it fits with the band.`,
      criteria,
    },
    ...(request.energyOverride === undefined && {
      energy: {
        type: "score",
        instructions: `${preamble}How intense should your next bar be, to fit the band's energy and where the music is going?`,
        criteria: ENERGY_LEVELS,
      },
    }),
    fill: {
      type: "noul",
      instructions: `${preamble}Play a fill in the next bar. ${fillRule}`,
    },
    ...join,
  };
};

/**
 * Jev's answer among concrete bars. With sampling on, the bar is drawn from
 * its top answers (keeping the current part favoured). Many options are
 * variations of a few patterns, so its certainty is judged per pattern: the
 * probability of all the bars made from the chosen one.
 */
const chooseCandidate = (
  request: DecisionRequest,
  received: { answers: JevAnswers },
  questions: unknown,
  config: SessionConfig["jev"]
): Decision => {
  const { answers } = received;
  const candidates = request.candidates!;
  const asked = request.joinBar !== undefined && answers.join;
  const join = asked ? answers.join!.noul >= 0.5 : undefined;
  const probabilities = answers.pattern.probabilities ?? { [answers.pattern.choice]: answers.pattern.confidence };
  const previous = request.bar?.previous;
  const sticky = candidates.find(
    (c) => !c.fill && previous && c.pattern === previous.pattern && c.variant === previous.variant && c.energy === previous.energy
  )?.id;
  const id = (config.sampling && pickFromOdds(probabilities, request.seed, { ...config.sampling, sticky })) || answers.pattern.choice;
  const seen = {
    join,
    odds: Object.entries(probabilities)
      .map(([pattern, p]) => ({ pattern, p }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 3),
    joinP: asked ? answers.join!.noul : undefined,
  };
  const trace = { questions, received };
  const candidate = candidates.find((c) => c.id === id);
  const local = (reason: string) => {
    const decision = decideLocally(request);
    return { ...decision, ...seen, trace: { ...trace, ranking: decision.trace?.ranking }, fallbackReason: reason };
  };
  if (!candidate) return local(`Jev chose an unknown bar "${id}"`);
  const family = candidates.filter((c) => c.pattern === candidate.pattern).reduce((sum, c) => sum + (probabilities[c.id] ?? 0), 0);
  if (family < config.minConfidence) return local(`Jev was unsure (${family.toFixed(2)} for ${candidate.pattern})`);
  const { pattern, variant, energy, fill, notes } = candidate;
  return { pattern, variant, energy, fill, notes, candidateId: candidate.id, ...seen, provider: "jev", confidence: probabilities[candidate.id], trace };
};

/**
 * Asks TypeSafe's Jev to pick the pattern, energy and whether to fill. Jev
 * chooses between the described patterns; it doesn't write notes. When it's
 * unsure, local rules decide instead.
 */
export const createJevProvider = (config: SessionConfig["jev"], fetch: Fetch = globalThis.fetch): DecisionProvider => ({
  name: "jev",
  plan: async (request, { timeoutMs }) => {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("TYPESAFE_API_KEY isn't set");
    const baseUrl = (process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const questions = planQuestions(request, ENERGY_LEVELS, config.instructions);
    const response = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, state: request.state, questions }),
      signal: AbortSignal.timeout(Math.max(timeoutMs, 50)),
    });
    if (!response.ok) throw new Error(`Jev answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const received = (await response.json()) as { answers: Record<string, { choice?: string; score?: number }> };
    return { answers: received.answers, trace: { questions, received } };
  },
  decide: async (request, { timeoutMs }): Promise<Decision> => {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("TYPESAFE_API_KEY isn't set");
    const questions = buildQuestions(request, config);
    const baseUrl = (process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, state: request.state, questions }),
      signal: AbortSignal.timeout(Math.max(timeoutMs, 50)),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`Jev answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const received = (await response.json()) as { answers: JevAnswers };
    if (request.candidates?.length) return chooseCandidate(request, received, questions, config);
    const { answers } = received;
    const { choice, confidence } = answers.pattern;
    const energy = request.energyOverride ?? clamp(Math.round((answers.energy?.score ?? 4) + 1), 1, 10);
    const fill = answers.fill.noul >= 0.5;
    const asked = request.joinBar !== undefined && answers.join;
    const join = asked ? answers.join!.noul >= 0.5 : undefined;
    // What the dashboard shows of the answer, whoever ends up deciding.
    const seen = {
      fill,
      join,
      odds: Object.entries(answers.pattern.probabilities ?? { [choice]: confidence })
        .map(([pattern, p]) => ({ pattern, p }))
        .sort((a, b) => b.p - a.p)
        .slice(0, 3),
      fillP: answers.fill.noul,
      joinP: asked ? answers.join!.noul : undefined,
    };
    const local = () => {
      const decision = decideLocally(request);
      return { ...decision, ...seen, trace: { questions, received, ranking: decision.trace?.ranking } };
    };

    if (confidence < config.minConfidence) return { ...local(), fallbackReason: `Jev was unsure (${confidence.toFixed(2)})` };
    const trace = { questions, received };
    // "hold" keeps the previous part, re-rendered for the next chord.
    if (choice === HOLD && request.previous) return { ...request.previous, ...seen, provider: "jev", confidence, trace };
    if (!request.patterns.some((pattern) => pattern.id === choice)) {
      return { ...local(), fallbackReason: `Jev chose an unknown pattern "${choice}"` };
    }
    return { pattern: choice, energy, ...seen, provider: "jev", confidence, trace };
  },
});

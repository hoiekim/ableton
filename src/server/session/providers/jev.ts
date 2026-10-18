import { SessionConfig } from "../config";
import { clamp } from "../music";
import { HOLD, HOLD_DESCRIPTION } from "../patterns";
import { decideLocally } from "./local";
import { Decision, DecisionProvider, DecisionRequest } from "./types";

// TypeSafe's REST API, called directly: the official SDK reads response bodies
// in a way Bun rejects ("Body already used").
const DEFAULT_BASE_URL = "https://api.typesafe.ai";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface JevAnswers {
  pattern: { choice: string; confidence: number };
  energy?: { score: number };
  fill: { noul: number };
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
  const preamble = [config.instructions, direction].filter(Boolean).map((line) => `${line}\n`).join("");
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
      instructions: `${preamble}Play a fill in the next bar. Fills go in the last bar of a phrase, leading into the next phrase or a new section; never in a bar that starts a phrase.`,
    },
  };
};

/**
 * Asks TypeSafe's Jev to pick the pattern, energy and whether to fill. Jev
 * chooses between the described patterns; it doesn't write notes. When it's
 * unsure, local rules decide instead.
 */
export const createJevProvider = (config: SessionConfig["jev"], fetch: Fetch = globalThis.fetch): DecisionProvider => ({
  name: "jev",
  decide: async (request, { timeoutMs }): Promise<Decision> => {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("TYPESAFE_API_KEY isn't set");
    const baseUrl = (process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, state: request.state, questions: buildQuestions(request, config) }),
      signal: AbortSignal.timeout(Math.max(timeoutMs, 50)),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`Jev answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const { answers } = (await response.json()) as { answers: JevAnswers };
    const { choice, confidence } = answers.pattern;
    const energy = request.energyOverride ?? clamp(Math.round((answers.energy?.score ?? 4) + 1), 1, 10);
    const fill = answers.fill.noul >= 0.5;

    if (confidence < config.minConfidence) {
      return { ...decideLocally(request), fill, fallbackReason: `Jev was unsure (${confidence.toFixed(2)})` };
    }
    // "hold" keeps the previous part, re-rendered for the next chord.
    if (choice === HOLD && request.previous) return { ...request.previous, fill, provider: "jev", confidence };
    if (!request.patterns.some((pattern) => pattern.id === choice)) {
      return { ...decideLocally(request), fill, fallbackReason: `Jev chose an unknown pattern "${choice}"` };
    }
    return { pattern: choice, energy, fill, provider: "jev", confidence };
  },
});

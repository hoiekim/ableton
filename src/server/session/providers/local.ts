import { clamp, seededRandom } from "../music";
import { Option } from "../patterns";
import { energyBias, styleAffinity } from "../style";
import { Decision, DecisionProvider, DecisionRequest } from "./types";

const BUSY_ONSETS = 14;
const SPARSE_ONSETS = 5;

/**
 * Fast rules that pick a pattern from what the band is doing: match energy,
 * fill the space the band leaves, and mostly stick with what's working,
 * changing at phrase starts. Always available, so it's also the fallback.
 */
export const decideLocally = (request: DecisionRequest): Decision => {
  const { analysis, patterns, previous, instrument, targetBar, phraseLength } = request;
  const random = seededRandom(request.seed);
  const latest = analysis.bars.filter((bar) => !bar.partial).slice(-1)[0] ?? analysis.bars[analysis.bars.length - 1];
  const parts = latest?.parts ?? [];
  const bandOnsets = parts.reduce((sum, part) => sum + part.onsets, 0);
  const silent = bandOnsets === 0;

  const direction = request.direction ?? "";
  const bandEnergy = silent ? previous?.energy ?? 4 : analysis.energy;
  const energy = request.energyOverride ?? clamp(bandEnergy + energyBias(direction), 1, 10);

  // Someone else already covering this role leaves less room.
  const sameRole = parts.some((part) => part.role === (instrument === "keys" || instrument === "guitar" ? "chords" : instrument));
  const busy = bandOnsets >= BUSY_ONSETS || sameRole;
  const sparse = bandOnsets <= SPARSE_ONSETS && !sameRole;

  const position = ((targetBar - 1) % phraseLength) + 1;
  const phraseStart = position === 1;
  const score = (pattern: Option) => {
    if (pattern.id === "rest") return silent || energy > 2 ? -10 : 0;
    const [low, high] = pattern.energy;
    let total = energy >= low && energy <= high ? 2 : -Math.min(Math.abs(energy - low), Math.abs(energy - high));
    if (pattern.suits === "busy") total += busy ? 1 : sparse ? -1 : 0;
    if (pattern.suits === "sparse") total += sparse ? 1 : busy ? -1 : 0;
    if (pattern.id === previous?.pattern) total += phraseStart && random() < 0.35 ? 0.5 : 2.5;
    // How well it suits the loaded sound, e.g. no fast arpeggios on a slow pad.
    total += pattern.fit;
    // What the musician asked for outweighs sticking with the current pattern.
    total += styleAffinity(direction, pattern.id) * 3;
    return total + random() * 0.5;
  };
  // Each pattern scored once, so its small random part is the same wherever it's compared.
  const ranked = patterns.map((pattern) => ({ pattern: pattern.id, score: score(pattern) })).sort((a, b) => b.score - a.score);

  const fill = position === phraseLength && request.barsSinceFill >= phraseLength - 1 && energy >= 3 && random() < 0.75;

  // Among concrete bars, the energy they were made for (the band plan's, when there is one).
  if (request.candidates?.length) return pickCandidate(request, ranked, request.bar?.energy ?? energy, fill);

  return {
    pattern: ranked[0]?.pattern ?? "rest",
    energy,
    fill,
    provider: "local",
    trace: { ranking: ranked.map(({ pattern, score }) => ({ pattern, score: Math.round(score * 100) / 100 })) },
  };
};

/**
 * Among concrete bars: the one whose pattern the rules rank best, at the
 * energy they want, keeping what's playing, locked with the bass when it can,
 * and with a fill only when the rules want one.
 */
const pickCandidate = (request: DecisionRequest, ranked: { pattern: string; score: number }[], energy: number, fill: boolean): Decision => {
  const patternScores = new Map(ranked.map(({ pattern, score }) => [pattern, score]));
  const previous = request.bar?.previous;
  const scored = request.candidates!.map((candidate) => {
    let score = (patternScores.get(candidate.pattern) ?? -10) - Math.abs(candidate.energy - energy) * 1.5;
    if (candidate.variant !== "base") score -= 0.3;
    if (previous && candidate.pattern === previous.pattern && candidate.variant === previous.variant && candidate.energy === previous.energy) score += 1;
    if (candidate.variant === "lock" && candidate.description.includes("(locked)")) score += 0.6;
    if (request.bar?.ending === "offer") score += candidate.fill === fill ? 3 : -3;
    return { candidate, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const { candidate } = scored[0];
  return {
    pattern: candidate.pattern,
    variant: candidate.variant,
    energy: candidate.energy,
    fill: candidate.fill,
    notes: candidate.notes,
    candidateId: candidate.id,
    provider: "local",
    trace: { ranking: scored.slice(0, 12).map(({ candidate, score }) => ({ pattern: candidate.id, score: Math.round(score * 100) / 100 })) },
  };
};

export const localProvider: DecisionProvider = {
  name: "local",
  decide: async (request) => decideLocally(request),
};

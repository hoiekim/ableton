/**
 * The band plan: what the next few phrases are (a groove, a build, a climax,
 * a break...) and how each ends (a fill, a big fill, a stop). The decision
 * model chooses it for the whole band, so the players build, drop and fill
 * together, and revises it before every phrase; each bar's decision follows
 * it. The plan sets the direction (energy, endings, breaks); the players
 * still choose what to play.
 */
import { TransportState } from "common";
import { BandAnalysis } from "./analyze";
import { clamp } from "./music";
import { describePart } from "./state";
import type { HeardSpeech } from "./providers/types";

export const SECTIONS = {
  groove: "Groove: settle into the feel and keep it steady.",
  build: "Build: rise bar by bar, busier and louder, toward what comes next.",
  climax: "Climax: the peak, everything at full energy.",
  breakdown: "Breakdown: strip back bar by bar, sparser and softer.",
  break: "Break: the AI players drop out and leave space (the musicians carry on).",
  "half-time": "Half-time: the same tempo with a heavier, half-time feel.",
  variation: "Variation: change the parts for contrast, at the same energy.",
  outro: "Outro: wind down toward an ending.",
} as const;

export type Section = keyof typeof SECTIONS;

export const ENDINGS = {
  none: "No ending: flow straight into the next phrase.",
  fill: "A fill in the last bar, leading into the next phrase.",
  "big-fill": "A big, loud fill in the last bar, for a dramatic change.",
  stop: "A stop: everyone hits beat 1 of the last bar together, then silence until the next phrase.",
} as const;

export type Ending = keyof typeof ENDINGS;

/** The decision model's answer that keeps what the plan already says. */
export const KEEP = "keep";

export interface PlannedPhrase {
  /** Its first bar, counted from Play. */
  start: number;
  section: Section;
  ending: Ending;
}

export interface BandPlan {
  /** The bar the plan was made in. */
  decidedAt: number;
  /** 1–10: how intense this part of the jam is overall. */
  intensity: number;
  phrases: PlannedPhrase[];
  provider: string;
}

/** What the plan asks of one bar. */
export interface PlanTarget {
  section: Section;
  /** The phrase's first bar. */
  start: number;
  /** 1-based. */
  barInPhrase: number;
  phraseLength: number;
  /** The energy to aim for, 1–10. */
  energy: number;
  /** How the phrase ends; it applies in its last bar. */
  ending: Ending;
  /** Whether this is the phrase's last bar, where the ending is played. */
  lastBar: boolean;
  next?: Section;
}

/** The phrase starting at or before a bar (phrases start at bar 1, 1 + length, ...). */
export const phraseStart = (bar: number, phraseLength: number) => bar - ((bar - 1) % phraseLength);

/**
 * What the plan asks of a bar: its section, energy and ending. A build rises
 * from just under the plan's intensity to two above it; a breakdown and an
 * outro fall; a climax is at least 8; a break rests.
 */
export const targetFor = (plan: BandPlan | undefined, bar: number, phraseLength: number): PlanTarget | undefined => {
  if (!plan) return undefined;
  const start = phraseStart(bar, phraseLength);
  const index = plan.phrases.findIndex((phrase) => phrase.start === start);
  const phrase = plan.phrases[index];
  if (!phrase) return undefined;
  const barInPhrase = bar - start + 1;
  const progress = phraseLength > 1 ? (barInPhrase - 1) / (phraseLength - 1) : 1;
  const i = plan.intensity;
  const ramp = (from: number, to: number) => Math.round(from + (to - from) * progress);
  const energy = {
    groove: i,
    build: ramp(i - 1, i + 2),
    climax: Math.max(i + 2, 8),
    breakdown: ramp(i - 1, i - 4),
    break: 1,
    "half-time": i - 1,
    variation: i,
    outro: ramp(i, 2),
  }[phrase.section];
  return {
    section: phrase.section,
    start,
    barInPhrase,
    phraseLength,
    energy: clamp(energy, 1, 10),
    ending: phrase.ending,
    lastBar: barInPhrase === phraseLength,
    next: plan.phrases[index + 1]?.section,
  };
};

const NAMES: Record<Section, string> = {
  groove: "GROOVE",
  build: "BUILD",
  climax: "CLIMAX",
  breakdown: "BREAKDOWN",
  break: "BREAK",
  "half-time": "HALF-TIME",
  variation: "VARIATION",
  outro: "OUTRO",
};

const ENDING_WORDS: Record<Ending, string> = { none: "flows on", fill: "ends with a fill", "big-fill": "ends with a big fill", stop: "ends with a stop" };

/** The plan as a player reads it for one bar: one line. */
export const describeTarget = (plan: BandPlan, target: PlanTarget) => {
  const later = plan.phrases
    .filter((p) => p.start > target.start)
    .map((p) => NAMES[p.section])
    .slice(0, 3);
  return (
    `Band plan (made in bar ${plan.decidedAt}): this phrase is a ${NAMES[target.section]}, bar ${target.barInPhrase} of ${target.phraseLength}, ` +
    `aim for energy ${target.energy}; it ${ENDING_WORDS[target.ending]}.` +
    (later.length ? ` Then: ${later.join(", ")}.` : "")
  );
};

export interface PlanRequest {
  state: string;
  /** The phrases to plan, by first bar. */
  starts: number[];
  phraseLength: number;
  current?: BandPlan;
  direction?: string;
  speech?: HeardSpeech[];
}

/** What the band is doing, for the arranger: the parts, the chords, the energy, and what was said. */
export const describeBand = (
  analysis: BandAnalysis,
  transport: TransportState,
  context: { bar: number; players: string[]; direction?: string; speech?: HeardSpeech[]; current?: BandPlan; phraseLength: number }
) => {
  const lines: string[] = [];
  if (context.direction) lines.push(`The musician wants: "${context.direction}".`);
  for (const said of context.speech ?? []) lines.push(`Heard on ${said.trackName} ${said.when}: "${said.text}"`);
  lines.push(
    `Bar ${context.bar} of the jam. Tempo ${Math.round(transport.tempo)} BPM, ${transport.signatureNumerator}/${transport.signatureDenominator}. ` +
      `Phrases are ${context.phraseLength} bars.` +
      (analysis.key ? ` Key: ${analysis.key.name}.` : "")
  );
  const complete = analysis.bars.filter((bar) => !bar.partial);
  if (analysis.loopLength) lines.push(`The chords repeat every ${analysis.loopLength} bars.`);
  lines.push(`Band energy: ${analysis.energy} of 10, ${analysis.energyTrend}.`);
  const parts = complete[complete.length - 1]?.parts ?? [];
  lines.push(...(parts.length ? parts.map(describePart) : ["The band is silent right now."]));
  lines.push(`The AI players: ${context.players.join(", ")}.`);
  if (context.current) {
    const plan = context.current.phrases.map((p) => `bars ${p.start}–${p.start + context.phraseLength - 1} ${NAMES[p.section]} (${ENDING_WORDS[p.ending]})`);
    lines.push(`Your plan so far (made in bar ${context.current.decidedAt}, intensity ${context.current.intensity}): ${plan.join("; ")}.`);
  }
  return lines.join("\n");
};

/** The questions for one plan: a section and an ending per phrase, and the intensity. */
export const planQuestions = (request: PlanRequest, energyLevels: string[], instructions?: string) => {
  const preamble = [instructions, request.direction ? `The musician wants: "${request.direction}". Follow it.` : ""]
    .filter(Boolean)
    .map((line) => `${line}\n`)
    .join("");
  const role =
    `${preamble}You are the arranger of a live jam: plan where the AI players take the music over the next ` +
    `${request.starts.length * request.phraseLength} bars, phrase by phrase, so the jam has a shape. ` +
    "Follow the musicians: if they've changed what they play, or said something, plan for it.";
  const questions: Record<string, unknown> = {};
  request.starts.forEach((start, i) => {
    const bars = `bars ${start}–${start + request.phraseLength - 1}`;
    const planned = request.current?.phrases.find((p) => p.start === start);
    questions[`section${i + 1}`] = {
      type: "choice",
      instructions: `${role}\nWhat is the phrase in ${bars}?`,
      criteria: { ...(planned && { [KEEP]: `Keep the plan: ${SECTIONS[planned.section]}` }), ...SECTIONS },
    };
    questions[`ending${i + 1}`] = {
      type: "choice",
      instructions: `${role}\nHow does the phrase in ${bars} end?`,
      criteria: { ...(planned && { [KEEP]: `Keep the plan: ${ENDINGS[planned.ending]}` }), ...ENDINGS },
    };
  });
  questions.intensity = {
    type: "score",
    instructions: `${role}\nHow intense is this stretch of the jam overall?`,
    criteria: energyLevels,
  };
  return questions;
};

interface PlanAnswers {
  [question: string]: { choice?: string; score?: number } | undefined;
}

/** The plan from the decision model's answers; "keep" (or nonsense) keeps what was planned. */
export const planFromAnswers = (answers: PlanAnswers, request: PlanRequest, bar: number, provider: string): BandPlan => {
  const phrases = request.starts.map((start, i) => {
    const planned = request.current?.phrases.find((p) => p.start === start);
    const section = answers[`section${i + 1}`]?.choice;
    const ending = answers[`ending${i + 1}`]?.choice;
    return {
      start,
      section: section && section in SECTIONS ? (section as Section) : (planned?.section ?? "groove"),
      ending: ending && ending in ENDINGS ? (ending as Ending) : (planned?.ending ?? "none"),
    };
  });
  const score = answers.intensity?.score;
  const intensity = score === undefined ? (request.current?.intensity ?? 5) : clamp(Math.round(score + 1), 1, 10);
  return { decidedAt: bar, intensity, phrases, provider };
};

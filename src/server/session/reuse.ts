/**
 * When a player can skip calling the decision model and reuse its last answer.
 * Calls are skipped only where the answer would almost surely be the same:
 * mid-phrase bars when nothing has changed since the last call, and a band
 * that has been silent for a while. Phrase edges, any change, speech, and the
 * bar after a fallback are always asked about.
 */
import { Instrument, TransportState } from "common";
import { BandAnalysis, PartFeatures } from "./analyze";
import { ReuseSettings } from "./config";
import { density, loudness, register } from "./state";

/** A loop must be this sure before its bars count as repeating. */
const LOOP_CONFIDENCE = 0.75;

/** The decision model's last own answer (not a fallback), kept to reuse while nothing changes. */
export interface Asked {
  bar: number;
  pattern: string;
  energy: number;
  provider: string;
  confidence?: number;
  fingerprint: Fingerprint;
}

/**
 * What the decision model's answer depends on, coarsely, so that bar-to-bar
 * churn doesn't count as change. `setup` is what the musician sets; `band` is
 * what the band is doing.
 */
export interface Fingerprint {
  setup: string;
  band: string;
}

export interface FingerprintContext {
  instrument: Instrument;
  targetBar: number;
  direction: string;
  /** The loaded instrument's summary. */
  sound?: string;
  energyOverride?: number;
}

const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

/**
 * The fingerprint for a decision. The band's parts are summed up over the
 * last pass of a repeating loop (or the last 2 bars), so a loop whose bars
 * differ reads the same from one bar to the next, while a part starting,
 * stopping or changing how busy, high or loud it plays changes it.
 */
export const fingerprint = (analysis: BandAnalysis, transport: TransportState, context: FingerprintContext): Fingerprint => {
  const complete = analysis.bars.filter((bar) => !bar.partial);
  const loop = analysis.loopLength && analysis.loopConfidence >= LOOP_CONFIDENCE ? analysis.loopLength : undefined;
  const window = complete.slice(-(loop && loop <= 4 ? loop : 2));
  const byPart = new Map<number, PartFeatures[]>();
  window.forEach((bar) => bar.parts.forEach((part) => byPart.set(part.deviceId, [...(byPart.get(part.deviceId) ?? []), part])));
  const parts = [...byPart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, heard]) => {
      const onsets = heard.reduce((sum, part) => sum + part.onsets, 0) / Math.max(window.length, 1);
      const loud = average(heard.filter((part) => part.onsets).map((part) => part.velocity));
      return `${id} ${heard[0].role} ${density(Math.round(onsets))} ${register(average(heard.map((part) => part.register)))} ${loud ? loudness(loud) : "held"}`;
    });
  const latest = complete[complete.length - 1]?.parts.map((part) => part.deviceId).sort((a, b) => a - b) ?? [];
  return {
    setup: JSON.stringify([
      context.instrument,
      context.direction,
      context.sound ?? "",
      context.energyOverride ?? "auto",
      Math.round(transport.tempo),
      `${transport.signatureNumerator}/${transport.signatureDenominator}`,
    ]),
    band: JSON.stringify([
      analysis.key?.name ?? "",
      loop ?? 0,
      analysis.energy,
      analysis.energyTrend,
      parts,
      latest,
      analysis.chordAt(context.targetBar).source,
    ]),
  };
};

/** Nothing played or held in the last finished bar, nor so far in this one. */
export const bandQuiet = (analysis: BandAnalysis) => {
  const complete = analysis.bars.filter((bar) => !bar.partial);
  const last = complete[complete.length - 1];
  const current = analysis.bars.find((bar) => bar.partial);
  return !!last && !last.parts.length && !current?.parts.length;
};

export interface ReuseCheck {
  settings: ReuseSettings | false;
  /** The decision model's last own answer. */
  asked?: Asked;
  /** The previous decision came from the local rules standing in. */
  lastWasFallback: boolean;
  /** The player has come in; until then every decision is asked. */
  joined: boolean;
  /** Something was said in the last few bars. */
  speechFresh: boolean;
  quiet: boolean;
  /** Decisions asked about since the band went quiet. */
  quietAsks: number;
  bar: number;
  /** Bars the clip lasts. */
  length: number;
  phraseLength: number;
  fingerprint: Fingerprint;
}

/** Why the decision for a bar can reuse the last answer, or undefined when it should be asked. */
export const reuseReason = (check: ReuseCheck): string | undefined => {
  const { settings, asked } = check;
  if (!settings || !asked || !check.joined || check.lastWasFallback || check.speechFresh) return undefined;
  if (check.fingerprint.setup !== asked.fingerprint.setup) return undefined;
  if (check.quiet) return check.quietAsks >= settings.silentBars ? "the band is silent" : undefined;
  if (!settings.midPhrase) return undefined;
  // Changes and fills happen at a phrase's first and last bars: always ask there.
  const positions = Array.from({ length: check.length }, (_, i) => (check.bar + i - 1) % check.phraseLength);
  if (positions.some((position) => position === 0 || position === check.phraseLength - 1)) return undefined;
  return check.fingerprint.band === asked.fingerprint.band ? "mid-phrase, nothing changed" : undefined;
};

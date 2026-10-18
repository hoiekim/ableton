import { Instrument, TransportState } from "common";
import { BandAnalysis, PartFeatures } from "./analyze";
import type { HeardSpeech } from "./providers/types";

export interface PlayerContext {
  instrument: Instrument;
  /** Bar the decision is for (counted from when playback started). */
  targetBar: number;
  phraseLength: number;
  lastPattern?: string;
  lastEnergy?: number;
  barsSinceFill: number;
  /** The loaded instrument, as worked out from Live (see instrument.ts). */
  sound?: string;
  /** The musician's style direction. */
  direction?: string;
  /** What was just said or sung, oldest first. */
  speech?: HeardSpeech[];
}

const ROLE_NAMES = { bass: "Bass", chords: "Chords", melody: "Melody", drums: "Drums" } as const;

const density = (onsets: number) => {
  if (onsets === 0) return "silent";
  if (onsets <= 3) return "sparse";
  if (onsets <= 8) return "moderate";
  if (onsets <= 16) return "busy";
  return "very busy";
};

const register = (pitch: number) => (pitch < 48 ? "low" : pitch < 65 ? "middle" : "high");

const loudness = (velocity: number) => (velocity < 50 ? "soft" : velocity < 85 ? "medium" : "loud");

/** Names the rhythm from a 16-step onset grid, since the model reads words better than grids. */
const rhythm = (grid: string) => {
  const steps = [...grid].map((c, i) => (c === "x" ? i : -1)).filter((i) => i >= 0);
  if (!steps.length) return "no new notes";
  if (steps.every((i) => i % 4 === 0)) return steps.length >= 4 ? "on every beat" : "on some beats";
  if (steps.every((i) => i % 2 === 0)) return "eighth notes";
  return "syncopated sixteenths";
};

const describePart = (part: PartFeatures) => {
  const sustained = part.polyphony >= 2 && part.onsets <= 4;
  const feel = sustained ? "sustained chords" : `${density(part.onsets)}, ${rhythm(part.grid)}`;
  return `${ROLE_NAMES[part.role]} (${part.trackName}): ${feel}, ${part.onsets} new notes, ${register(part.register)} register, ${loudness(part.velocity)}.`;
};

/** "Keys", "Bass and Keys", "Bass, Keys and Pad". */
const listNames = (names: string[]) => {
  const unique = [...new Set(names)];
  return unique.length > 1 ? `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}` : (unique[0] ?? "band's");
};

/**
 * Sums up what the band is doing as short sentences for the decision model.
 * Every number is worked out here; the model only has to read.
 */
export const describeState = (analysis: BandAnalysis, transport: TransportState, player: PlayerContext) => {
  const lines: string[] = [];
  const { targetBar, phraseLength } = player;
  if (player.direction) lines.push(`The musician wants: "${player.direction}".`);
  for (const said of player.speech ?? []) lines.push(`Heard on ${said.trackName} ${said.when}: "${said.text}"`);
  const signature = `${transport.signatureNumerator}/${transport.signatureDenominator}`;
  lines.push(
    `The next bar is bar ${targetBar} of the jam. Tempo ${Math.round(transport.tempo)} BPM, ${signature} time.` +
      (analysis.key ? ` Key: ${analysis.key.name}.` : " Key: not clear yet.")
  );

  const complete = analysis.bars.filter((bar) => !bar.partial);
  const recentChords = complete.slice(-4).map((bar) => analysis.chordAt(bar.index).chord?.symbol ?? "none");
  if (recentChords.length) {
    const loop = analysis.loopLength
      ? ` They repeat every ${analysis.loopLength} bar${analysis.loopLength > 1 ? "s" : ""}${analysis.loopConfidence >= 0.9 ? " (sure)" : ""}.`
      : " No repeating pattern yet.";
    lines.push(`Chords in the last ${recentChords.length} bars: ${recentChords.join(", ")}.${loop}`);
  }
  const next = analysis.chordAt(targetBar);
  if (next.chord) {
    const how = {
      heard: "heard",
      clip: `from the ${listNames(next.tracks ?? [])} clip${(next.tracks?.length ?? 0) > 1 ? "s" : ""}`,
      loop: next.confidence >= 0.75 ? "predicted from the repeating chords" : "a guess from the chords starting to repeat",
      held: "a guess: the last chord continuing",
    }[next.source];
    lines.push(`Chord for the next bar: ${next.chord.symbol} (${how}).`);
  }

  lines.push(`Band energy: ${analysis.energy} of 10, ${analysis.energyTrend}.`);

  const latest = complete[complete.length - 1];
  const current = analysis.bars[analysis.bars.length - 1];
  const parts = (current?.partial && current.parts.length ? current : latest)?.parts ?? [];
  if (parts.length) lines.push(...parts.map(describePart));
  else lines.push("The band is silent right now.");

  const position = ((targetBar - 1) % phraseLength) + 1;
  const phrase =
    position === phraseLength
      ? `The next bar is the last bar of a ${phraseLength}-bar phrase.`
      : position === 1
        ? `The next bar starts a new ${phraseLength}-bar phrase.`
        : `The next bar is bar ${position} of a ${phraseLength}-bar phrase.`;
  const last = player.lastPattern
    ? `Your last bar: ${player.lastPattern} at energy ${player.lastEnergy}.`
    : "You haven't played yet.";
  lines.push(`You play ${player.instrument}. ${last} Bars since your last fill: ${player.barsSinceFill}. ${phrase}`);
  if (player.sound) lines.push(`Your instrument: ${player.sound}.`);

  return lines.join("\n");
};

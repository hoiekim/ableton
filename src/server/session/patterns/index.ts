import { Instrument } from "common";
import { bass } from "./bass";
import { drums } from "./drums";
import { guitar } from "./guitar";
import { keys } from "./keys";
import { Pattern } from "./types";

export * from "./types";

/** A choice that keeps the current clip looping instead of writing a new one. */
export const HOLD = "hold";

export const HOLD_DESCRIPTION =
  "Keep playing exactly what you played in the previous bar. Best when the band is repeating and nothing has changed.";

export const builtInPatterns: Record<Instrument, Pattern[]> = { drums, bass, keys, guitar };

/**
 * Built-in patterns with the ones from session.config.ts merged in; a config
 * pattern with the same id replaces the built-in one.
 */
export const patternsFor = (instrument: Instrument, extra: Partial<Record<Instrument, Pattern[]>> = {}) => {
  const byId = new Map(builtInPatterns[instrument].map((pattern) => [pattern.id, pattern]));
  for (const pattern of extra[instrument] ?? []) byId.set(pattern.id, pattern);
  return [...byId.values()];
};

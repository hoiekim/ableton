import { Instrument } from "common";
import { InstrumentProfile, KitRole } from "../instrument";
import { liveNoteName } from "../music";
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

/** An option for the decision model: a pattern described for the loaded instrument. */
export type Option = Pattern & {
  /** How well it suits the loaded sound: positive suits, negative doesn't. */
  fit: number;
};

const KIT_LABELS: Record<KitRole, string> = {
  kick: "kick",
  snare: "snare",
  clap: "clap",
  rim: "rim",
  "closed-hat": "closed hat",
  "open-hat": "open hat",
  ride: "ride",
  crash: "crash",
  "tom-low": "low tom",
  "tom-mid": "mid tom",
  "tom-high": "high tom",
  shaker: "shaker",
  perc: "percussion",
};

/** "Plays: kick "Kick 808" C1, clap on "Snare Tight" D1, ..." for the loaded kit. */
const kitSounds = (uses: KitRole[], profile: InstrumentProfile) => {
  const parts = uses.map((role) => {
    const note = profile.kit[role];
    const sound = profile.sounds.find((s) => s.note === note);
    const where = profile.notesAssumed ? "" : ` ${liveNoteName(note)}`;
    if (!sound) return `${KIT_LABELS[role]} (not in this kit)`;
    const standIn = profile.substituted[role];
    return standIn ? `${KIT_LABELS[role]} on "${sound.name}"${where}` : `${KIT_LABELS[role]} "${sound.name}"${where}`;
  });
  return parts.length ? ` Plays: ${parts.join(", ")}.` : "";
};

/** Does the kit have, of its own, a sound the pattern needs (two toms for a tom groove)? */
const kitHas = (pattern: Pattern, profile: InstrumentProfile) => {
  if (!pattern.requires) return true;
  return pattern.requires.some((role) => {
    const count = profile.sounds.filter((sound) => sound.role === role).length;
    return role === "tom" ? count >= 2 : count >= 1;
  });
};

const SUSTAINED_SOUNDS = new Set(["pad", "strings", "organ", "brass"]);
const SHORT_SOUNDS = new Set(["pluck", "bell", "mallet"]);

/** How well a melodic pattern's articulation suits the sound, with a reason for the model. */
export const soundFit = (pattern: Pattern, profile: InstrumentProfile): { fit: number; note?: string } => {
  const sustained = profile.tags.some((tag) => SUSTAINED_SOUNDS.has(tag)) || profile.envelope.attack === "slow";
  // A piano's decay is natural; it still holds chords well.
  const piano = profile.tags.includes("piano") || profile.tags.includes("electric piano");
  const short = profile.tags.some((tag) => SHORT_SOUNDS.has(tag)) || (!!profile.envelope.plucky && !piano);
  switch (pattern.articulation) {
    case "sustained":
      if (sustained && !short) return { fit: 1, note: "Suits this sustained sound." };
      if (short) return { fit: -1, note: "Poor fit: this short, plucky sound dies away before long notes end." };
      return { fit: 0 };
    case "busy":
      if (short) return { fit: 1, note: "Suits this short, plucky sound." };
      if (profile.envelope.attack === "slow") return { fit: -1.5, note: "Poor fit: fast notes blur on this slow-attack sound." };
      if (sustained) return { fit: -0.5, note: "Busy for this sustained sound." };
      return { fit: 0 };
    case "rhythmic":
      if (profile.envelope.attack === "slow") return { fit: -0.5, note: "Its slow attack softens the rhythm." };
      return { fit: short ? 0.5 : 0 };
    default:
      return { fit: 0 };
  }
};

/**
 * The choices offered to the decision model for a role, adapted to the loaded
 * instrument: for drums, only patterns the kit has the sounds for, each naming
 * the pads it plays; for melodic instruments, each pattern says how well it
 * suits the sound.
 */
export const optionsFor = (
  role: Instrument,
  profile: InstrumentProfile | undefined,
  extra: Partial<Record<Instrument, Pattern[]>> = {}
): Option[] => {
  const patterns = patternsFor(role, extra);
  if (!profile) return patterns.map((pattern) => ({ ...pattern, fit: 0 }));
  if (role === "drums") {
    if (profile.kind !== "drums") return patterns.map((pattern) => ({ ...pattern, fit: 0 }));
    return patterns
      .filter((pattern) => kitHas(pattern, profile))
      .map((pattern) => ({ ...pattern, description: pattern.description + kitSounds(pattern.uses ?? [], profile), fit: 0 }));
  }
  if (profile.kind !== "melodic") return patterns.map((pattern) => ({ ...pattern, fit: 0 }));
  return patterns.map((pattern) => {
    const { fit, note } = soundFit(pattern, profile);
    return { ...pattern, description: note ? `${pattern.description} ${note}` : pattern.description, fit };
  });
};

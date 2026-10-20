import { Instrument } from "common";
import userConfig from "../../../session.config";
import { Pattern } from "./patterns";

export type ProviderName = "auto" | "local" | "jev";

/** Concrete bars offered to the decision model (see candidates.ts). */
export interface CandidateSettings {
  /** Most bars offered per decision; each costs about 50 tokens. */
  max: number;
}

/** Picking among the decision model's top answers rather than always the top one. */
export interface SamplingSettings {
  /** Answers within this share of the top probability are in the running (1: always the top). */
  band: number;
  /** How much more likely keeping the same part is than its probability says. */
  stickiness: number;
}

/** When a player may reuse the decision model's last answer instead of asking again (see reuse.ts). */
export interface ReuseSettings {
  /** Mid-phrase bars where nothing has changed since the last call reuse its answer. */
  midPhrase: boolean;
  /** Bars of a silent band still asked about; after that the last answer holds until something is played or said. */
  silentBars: number;
}

export interface SessionConfig {
  /** "auto" uses Jev when TYPESAFE_API_KEY is set, local rules otherwise. */
  provider: ProviderName;
  jev: {
    model: string;
    /** Below this confidence in the pattern choice, local rules decide instead. */
    minConfidence: number;
    /** Extra instructions prepended to every question. */
    instructions?: string;
    /** When to reuse the last answer instead of calling; false calls for every decision. */
    reuse: ReuseSettings | false;
    /** Offer concrete bars rather than pattern names; false offers the named patterns (and asks energy and fill apart). */
    candidates: CandidateSettings | false;
    /** Pick among the top answers for variety; false always takes the top one. */
    sampling: SamplingSettings | false;
  };
  timing: {
    /** Clip must be written and fired at least this long before the bar starts. */
    fireMarginMs: number;
    /** Assumed decision time until real ones have been measured. */
    initialDecisionMs: number;
    /** Assumed time to write a clip until measured. */
    initialWriteMs: number;
  };
  /** How many of the player track's last clip slots it cycles through. */
  slots: number;
  /** Bars per phrase, used for fills and pattern changes. */
  phraseLength: number;
  /** The band plan (see plan.ts): how many phrases ahead the decision model plans; false plans nothing. */
  plan: { phrases: number } | false;
  /** UDP port the Session Input devices send to. */
  oscPort: number;
  /** Speech-to-text for the Session Voice devices: a local whisper.cpp server, started when one is in the set. */
  voice: {
    /** The whisper-server program (from `brew install whisper-cpp`). */
    whisperServer: string;
    /** A whisper.cpp model, relative to where the server is started. */
    model: string;
    /** Local port for whisper-server; one already running there is reused. */
    port: number;
    /** Below this average log probability a transcribed phrase is taken for noise. */
    minLogprob: number;
  };
  /** Patterns to add, or to replace built-in ones with the same id. */
  patterns: Partial<Record<Instrument, Pattern[]>>;
}

export type UserSessionConfig = Partial<Omit<SessionConfig, "jev" | "timing" | "voice" | "plan">> & {
  plan?: Partial<{ phrases: number }> | false;
  jev?: Partial<Omit<SessionConfig["jev"], "reuse" | "candidates" | "sampling">> & {
    reuse?: Partial<ReuseSettings> | false;
    candidates?: Partial<CandidateSettings> | false;
    sampling?: Partial<SamplingSettings> | false;
  };
  timing?: Partial<SessionConfig["timing"]>;
  voice?: Partial<SessionConfig["voice"]>;
};

export const defaultConfig: SessionConfig = {
  provider: "auto",
  jev: {
    model: "jev-latest",
    minConfidence: 0.25,
    reuse: { midPhrase: true, silentBars: 2 },
    candidates: { max: 32 },
    sampling: { band: 0.7, stickiness: 1.5 },
  },
  timing: { fireMarginMs: 150, initialDecisionMs: 450, initialWriteMs: 60 },
  slots: 4,
  phraseLength: 4,
  plan: { phrases: 4 },
  oscPort: 9101,
  voice: { whisperServer: "whisper-server", model: "models/ggml-base.en.bin", port: 9103, minLogprob: -1 },
  patterns: {},
};

export const loadConfig = (overrides: UserSessionConfig = userConfig): SessionConfig => {
  const provider = (process.env.SESSION_PROVIDER as ProviderName | undefined) ?? overrides.provider ?? defaultConfig.provider;
  return {
    ...defaultConfig,
    ...overrides,
    provider,
    jev: {
      ...defaultConfig.jev,
      ...overrides.jev,
      reuse: overrides.jev?.reuse === false ? false : { ...(defaultConfig.jev.reuse as ReuseSettings), ...overrides.jev?.reuse },
      // SESSION_CANDIDATES=0 offers the named patterns instead of concrete bars.
      candidates:
        overrides.jev?.candidates === false || process.env.SESSION_CANDIDATES === "0"
          ? false
          : { ...(defaultConfig.jev.candidates as CandidateSettings), ...overrides.jev?.candidates },
      sampling: overrides.jev?.sampling === false ? false : { ...(defaultConfig.jev.sampling as SamplingSettings), ...overrides.jev?.sampling },
    },
    timing: { ...defaultConfig.timing, ...overrides.timing },
    // SESSION_PLAN=0 turns the band plan off.
    plan: overrides.plan === false || process.env.SESSION_PLAN === "0" ? false : { phrases: 4, ...overrides.plan },
    oscPort: Number(process.env.SESSION_OSC_PORT) || overrides.oscPort || defaultConfig.oscPort,
    voice: {
      ...defaultConfig.voice,
      ...overrides.voice,
      ...(process.env.SESSION_WHISPER_MODEL && { model: process.env.SESSION_WHISPER_MODEL }),
      ...(Number(process.env.SESSION_WHISPER_PORT) && { port: Number(process.env.SESSION_WHISPER_PORT) }),
    },
    patterns: overrides.patterns ?? {},
  };
};

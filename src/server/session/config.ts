import { Instrument } from "common";
import userConfig from "../../../session.config";
import { Pattern } from "./patterns";

export type ProviderName = "auto" | "local" | "jev";

export interface SessionConfig {
  /** "auto" uses Jev when TYPESAFE_API_KEY is set, local rules otherwise. */
  provider: ProviderName;
  jev: {
    model: string;
    /** Below this confidence in the pattern choice, local rules decide instead. */
    minConfidence: number;
    /** Extra instructions prepended to every question. */
    instructions?: string;
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

export type UserSessionConfig = Partial<Omit<SessionConfig, "jev" | "timing" | "voice">> & {
  jev?: Partial<SessionConfig["jev"]>;
  timing?: Partial<SessionConfig["timing"]>;
  voice?: Partial<SessionConfig["voice"]>;
};

export const defaultConfig: SessionConfig = {
  provider: "auto",
  jev: { model: "jev-latest", minConfidence: 0.25 },
  timing: { fireMarginMs: 150, initialDecisionMs: 450, initialWriteMs: 60 },
  slots: 4,
  phraseLength: 4,
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
    jev: { ...defaultConfig.jev, ...overrides.jev },
    timing: { ...defaultConfig.timing, ...overrides.timing },
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

import type { UserSessionConfig } from "./src/server/session/config";

/**
 * Session Player settings. Anything left out uses the defaults in
 * src/server/session/config.ts. Rebuild (`bun run build`) after editing.
 *
 * Patterns: add your own per instrument, or replace a built-in one by reusing
 * its id. Each needs a description (the decision model chooses by it) and a
 * render function that returns notes for the bars it's given. See
 * src/server/session/patterns/ for the built-in ones.
 */
const config: UserSessionConfig = {
  // "auto" uses Jev when TYPESAFE_API_KEY is set, local rules otherwise.
  provider: "auto",
  jev: {
    model: "jev-latest",
    minConfidence: 0.25,
    // When a player may reuse Jev's last answer instead of calling again
    // (docs/DESIGN.md, "Reusing answers"). false calls for every decision.
    reuse: {
      midPhrase: true, // mid-phrase bars where nothing changed since the last call
      silentBars: 2, // bars of a silent band still asked about before the answer holds
    },
    // Concrete bars to choose from instead of pattern names (docs/DESIGN.md, "Concrete bars").
    candidates: { max: 32 },
    // Draw among Jev's top answers: those within 70% of the top, keeping the current part favoured.
    sampling: { band: 0.7, stickiness: 1.5 },
  },
  // The band plan: phrases planned ahead by Jev for all players (docs/DESIGN.md, "Band plan").
  plan: { phrases: 4 },
  timing: {
    fireMarginMs: 150,
  },
  slots: 4,
  phraseLength: 4,
  // Speech-to-text for Session Voice: whisper.cpp's server, started when a Session Voice is in the set.
  voice: {
    model: "models/ggml-base.en.bin",
    port: 9103,
  },
  patterns: {},
};

export default config;

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
  },
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

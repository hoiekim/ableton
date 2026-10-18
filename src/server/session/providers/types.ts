import { Instrument } from "common";
import { BandAnalysis } from "../analyze";
import { Option } from "../patterns";

export interface DecisionRequest {
  instrument: Instrument;
  /** The band summed up as text (see state.ts). */
  state: string;
  analysis: BandAnalysis;
  /** The options, described for the loaded instrument. */
  patterns: Option[];
  targetBar: number;
  phraseLength: number;
  previous?: { pattern: string; energy: number };
  barsSinceFill: number;
  /** Set when the device's Energy control isn't on Auto. */
  energyOverride?: number;
  /** The musician's style direction, e.g. "funky 70s soul"; empty when none. */
  direction?: string;
  /** What was just said or sung on the Session Voice tracks, oldest first. */
  speech?: HeardSpeech[];
  /** When the latest phrase recent enough to cue a fill was heard (Unix ms). */
  cueAt?: number;
  /** Set when the player hasn't come in yet and would at this bar: should it start now instead? */
  joinBar?: number;
  /** Varies the local rules' small random choices from bar to bar, reproducibly. */
  seed: number;
}

export interface HeardSpeech {
  text: string;
  trackName: string;
  /** "this bar", "2 bars ago", "just before playback started". */
  when: string;
}

export interface Decision {
  pattern: string;
  /** 1–10. */
  energy: number;
  fill: boolean;
  /** For an early request (joinBar set): whether to come in now. Undefined means yes. */
  join?: boolean;
  provider: string;
  confidence?: number;
  fallbackReason?: string;
}

export interface DecisionProvider {
  name: string;
  decide: (request: DecisionRequest, options: { timeoutMs: number }) => Promise<Decision>;
}

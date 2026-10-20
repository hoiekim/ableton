import { DecisionOdds, Instrument, ReusedFrom } from "common";
import { BandAnalysis } from "../analyze";
import { BarContext, Candidate, Variant } from "../candidates";
import { ClipNote } from "../music";
import type { PlanRequest } from "../plan";
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
  /** Concrete bars to choose from (see candidates.ts); without them, the named patterns. */
  candidates?: Candidate[];
  /** What the candidates were rendered for, to render a recipe again (reused or carried). */
  bar?: BarContext;
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
  /** The pattern played, or for a concrete bar the pattern it was made from. */
  pattern: string;
  /** For a concrete bar: the variation of the pattern, and the notes it plays. */
  variant?: Variant;
  notes?: ClipNote[];
  candidateId?: string;
  /** 1–10. */
  energy: number;
  fill: boolean;
  /** For an early request (joinBar set): whether to come in now. Undefined means yes. */
  join?: boolean;
  provider: string;
  confidence?: number;
  fallbackReason?: string;
  /** The decision model's likeliest patterns, and its fill and join probabilities. */
  odds?: DecisionOdds[];
  fillP?: number;
  joinP?: number;
  /** What was sent and received, for the dashboard. */
  trace?: DecisionTrace;
  /** Set when an earlier answer was reused instead of asking. */
  reused?: ReusedFrom;
}

export interface DecisionTrace {
  /** The questions as sent to the decision model. */
  questions?: unknown;
  /** Its answer as it came back. */
  received?: unknown;
  /** How the local rules scored each pattern. */
  ranking?: { pattern: string; score: number }[];
}

export interface DecisionProvider {
  name: string;
  decide: (request: DecisionRequest, options: { timeoutMs: number }) => Promise<Decision>;
  /** The band plan's answers (see plan.ts); providers without one plan nothing. */
  plan?: (request: PlanRequest, options: { timeoutMs: number }) => Promise<{ answers: Record<string, { choice?: string; score?: number }>; trace: DecisionTrace }>;
}

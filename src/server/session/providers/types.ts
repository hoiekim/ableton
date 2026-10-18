import { Instrument } from "common";
import { BandAnalysis } from "../analyze";
import { Pattern } from "../patterns";

export interface DecisionRequest {
  instrument: Instrument;
  /** The band summed up as text (see state.ts). */
  state: string;
  analysis: BandAnalysis;
  patterns: Pattern[];
  targetBar: number;
  phraseLength: number;
  previous?: { pattern: string; energy: number };
  barsSinceFill: number;
  /** Set when the device's Energy control isn't on Auto. */
  energyOverride?: number;
  /** Varies the local rules' small random choices from bar to bar, reproducibly. */
  seed: number;
}

export interface Decision {
  pattern: string;
  /** 1–10. */
  energy: number;
  fill: boolean;
  provider: string;
  confidence?: number;
  fallbackReason?: string;
}

export interface DecisionProvider {
  name: string;
  decide: (request: DecisionRequest, options: { timeoutMs: number }) => Promise<Decision>;
}

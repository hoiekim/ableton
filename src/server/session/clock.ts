import { TransportState } from "common";

export const beatsPerBar = (transport: TransportState) => (transport.signatureNumerator * 4) / transport.signatureDenominator;

export const msPerBeat = (transport: TransportState) => 60000 / Math.max(transport.tempo, 1);

/**
 * Live reports the song position every few dozen milliseconds; in between,
 * it's extrapolated from the last report, the elapsed time and the tempo.
 */
export const estimateSongTime = (transport: TransportState, reportedAt: number, now = performance.now()) => {
  if (!transport.isPlaying) return transport.songTime;
  return transport.songTime + Math.max(now - reportedAt, 0) / msPerBeat(transport);
};

/** Samples needed before they're trusted over the starting assumption. */
const TRUSTED_SAMPLES = 5;

/**
 * The slowest of recent samples. Until there are a few, not below `fallback`
 * either: one quick first answer says little about the next.
 */
export const slowest = (samples: number[], fallback: number) => {
  const max = samples.length ? Math.max(...samples) : 0;
  return samples.length >= TRUSTED_SAMPLES ? max : Math.max(max, fallback);
};

/** 90th percentile of recent samples, or `fallback` before there are any. */
export const p90 = (samples: number[], fallback: number) => {
  if (!samples.length) return fallback;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
};

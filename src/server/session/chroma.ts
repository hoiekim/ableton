import { HeardEvent, toVelocity } from "./audio";

/**
 * How an audio input is heard: one note at a time (fzero~'s pitch), chords
 * (the pitch classes FluCoMa's fluid.chroma~ measures, struck at each onset),
 * or hits (onsets only, for drums and percussion).
 */
export type AudioMode = "notes" | "chords" | "hits";

/** A pitch class sounds when it's at least this share of the strongest one. */
const PRESENT = 0.5;
/** Most pitch classes a chord event plays. */
const MAX_TONES = 4;
/** Frames after an attack to read the strum's chroma from: the analysis window trails the attack. */
const SETTLE_FRAMES = 2;
/** A chord change without an attack (legato, a fade-in) must hold this many frames (~140 ms). */
const CHANGE_FRAMES = 6;
/** The level must drop this far below the threshold to end the chord, so it doesn't flutter. */
const HYSTERESIS_DB = 4;
/** Loud frames kept to judge whether the input plays chords (about a second). */
const HISTORY_FRAMES = 40;
/** "Plays chords": at least this many pitch classes in this share of the recent loud frames. */
const POLYPHONIC_TONES = 3;
const POLYPHONIC_SHARE = 0.6;
/** Without chroma frames for this long (device off, FluCoMa missing), the chord ends. */
const SILENT_MS = 250;
/** A hit (drums mode) lasts this long, in beats. */
const HIT_LENGTH = 0.1;
/** The note a hit plays: a snare, for the rhythm grid. */
const HIT_PITCH = 38;

/**
 * The pitch classes sounding in a chroma frame, strongest first: those at
 * least half as strong as the strongest, at most 4.
 */
export const strongTones = (chroma: number[]) => {
  const max = Math.max(...chroma);
  if (!(max > 1e-9)) return [];
  return chroma
    .map((value, pitchClass) => ({ pitchClass, value }))
    .filter(({ value }) => value / max >= PRESENT)
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_TONES)
    .map(({ pitchClass }) => pitchClass);
};

/** The notes a chord event plays: the strongest pitch class lowest (C3–B3, usually the root), the rest above. */
const voicing = (tones: number[]) => tones.map((pitchClass, i) => (i === 0 ? 48 : 60) + pitchClass);

const average = (frames: number[][]) => frames[0].map((_, i) => frames.reduce((sum, frame) => sum + frame[i], 0) / frames.length);

/**
 * Turns Session Input Audio's chroma frames (about every 23 ms) and spectral
 * onsets into note events, so strummed chords reach the analysis the way
 * played MIDI chords do: each strum plays the pitch classes sounding just
 * after it, held until the next strum or until the guitar goes quiet. A chord
 * change without a new strum also counts once it holds. Its level comes from
 * the same device's pitch readings, gated by the input's Threshold.
 */
export class ChromaNotes {
  private sounding: number[] = [];
  private attack?: { beat: number; frames: number[][] };
  private change?: { key: string; frames: number; beat: number };
  private toneCounts: number[] = [];
  private db = -120;
  private thresholdDb = -40;
  private lastFrameAt = 0;

  constructor(private emit: (event: HeardEvent) => void) {}

  /** Whether chroma has been heard lately: without FluCoMa there is none. */
  isActive = (now = performance.now()) => now - this.lastFrameAt < SILENT_MS * 4;

  /** Whether the input has been playing chords rather than single notes. */
  isPolyphonic = () => {
    if (this.toneCounts.length < 10) return false;
    const chordal = this.toneCounts.filter((count) => count >= POLYPHONIC_TONES).length;
    return chordal / this.toneCounts.length >= POLYPHONIC_SHARE;
  };

  /** The input's level, from its pitch readings. Below the threshold the chord ends. */
  level = (db: number, thresholdDb: number, beat: number) => {
    this.db = db;
    this.thresholdDb = thresholdDb;
    if (this.sounding.length && db < thresholdDb - HYSTERESIS_DB) this.release(beat);
  };

  frame = (chroma: number[], beat: number, now = performance.now()) => {
    this.lastFrameAt = now;
    const loud = this.db >= this.thresholdDb;
    const tones = loud ? strongTones(chroma) : [];
    if (loud) {
      this.toneCounts.push(tones.length);
      if (this.toneCounts.length > HISTORY_FRAMES) this.toneCounts.shift();
    }

    if (this.attack) {
      this.attack.frames.push(chroma);
      if (this.attack.frames.length >= SETTLE_FRAMES) {
        const { beat: at, frames } = this.attack;
        this.attack = undefined;
        this.strike(strongTones(average(frames)), at);
      }
      return;
    }

    // No new attack: a different chord that holds still counts (legato, or onsets missed).
    const key = [...tones].sort((a, b) => a - b).join(",");
    const current = [...this.sounding].map((pitch) => pitch % 12).sort((a, b) => a - b).join(",");
    if (!tones.length || key === current) {
      this.change = undefined;
      return;
    }
    if (this.change?.key === key) this.change.frames++;
    else this.change = { key, frames: 1, beat };
    if (this.change.frames >= CHANGE_FRAMES) {
      const { beat: from } = this.change;
      this.change = undefined;
      this.strike(tones, from);
    }
  };

  /** A strum: the chord is read from the next frames and stamped at the attack. */
  strum = (beat: number) => {
    if (this.db < this.thresholdDb) return;
    this.attack = { beat, frames: [] };
    this.change = undefined;
  };

  /** A hit (drums mode): a short note on the attack, for the rhythm. */
  hit = (beat: number) => {
    if (this.db < this.thresholdDb) return;
    const velocity = toVelocity(this.db);
    this.emit({ pitch: HIT_PITCH, velocity, beat });
    this.emit({ pitch: HIT_PITCH, velocity: 0, beat: beat + HIT_LENGTH });
  };

  /** Ends the chord now. */
  release = (beat: number) => {
    this.sounding.forEach((pitch) => this.emit({ pitch, velocity: 0, beat }));
    this.sounding = [];
  };

  /** Ends the chord when chroma stops coming. */
  idle = (beat: number, now = performance.now()) => {
    if (this.sounding.length && now - this.lastFrameAt > SILENT_MS) this.release(beat);
  };

  private strike = (tones: number[], beat: number) => {
    if (!tones.length) return;
    this.release(beat);
    const velocity = toVelocity(this.db);
    this.sounding = voicing(tones);
    this.sounding.forEach((pitch) => this.emit({ pitch, velocity, beat }));
  };
}

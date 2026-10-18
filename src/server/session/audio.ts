import { clamp } from "./music";

export interface HeardEvent {
  pitch: number;
  /** 0 for note-off. */
  velocity: number;
  /** Song position in beats. */
  beat: number;
}

/** A note starts once the same pitch is heard in this many readings in a row (about 20 ms). */
const START_FRAMES = 2;
/** A held note changes pitch once the new pitch lasts this many readings (about 30 ms). */
const CHANGE_FRAMES = 3;
/** The level must drop this far below the threshold to end a note, so it doesn't flutter. */
const HYSTERESIS_DB = 4;
/** An onset re-attacks the held note only if it has sounded this long. */
const MIN_REATTACK_MS = 60;
/** Without readings for this long (device off, transport stopped), the held note ends. */
const SILENT_MS = 200;
const LOWEST = 24;
const HIGHEST = 108;

const toDb = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -120);

const toVelocity = (db: number) => clamp(Math.round(((db + 60) / 60) * 127), 1, 127);

const toPitch = (hz: number) => {
  if (!(hz > 0)) return undefined;
  const pitch = Math.round(69 + 12 * Math.log2(hz / 440));
  return pitch >= LOWEST && pitch <= HIGHEST ? pitch : undefined;
};

/**
 * Turns a Session Input Audio device's pitch readings (about every 10 ms) into
 * note-on and note-off events, one note at a time.
 */
export class AudioNotes {
  private sounding?: { pitch: number; velocity: number; startedAt: number };
  private candidate?: { pitch: number; frames: number; beat: number; velocity: number };
  private lastFrameAt = 0;
  private lastVelocity = 64;

  constructor(private emit: (event: HeardEvent) => void) {}

  frame = (hz: number, amplitude: number, beat: number, thresholdDb: number, now = performance.now()) => {
    this.lastFrameAt = now;
    const db = toDb(amplitude);
    const pitch = toPitch(hz);
    const velocity = toVelocity(db);
    this.lastVelocity = velocity;

    if (this.sounding) {
      if (db < thresholdDb - HYSTERESIS_DB || pitch === undefined) {
        this.end(beat);
        this.candidate = undefined;
        return;
      }
      if (pitch === this.sounding.pitch) {
        this.candidate = undefined;
        return;
      }
      // A new pitch while holding: switch once it's steady (legato).
      this.count(pitch, beat, velocity);
      if (this.candidate!.frames >= CHANGE_FRAMES) {
        const { pitch: next, beat: from, velocity: nextVelocity } = this.candidate!;
        this.end(from);
        this.start(next, nextVelocity, from, now);
      }
      return;
    }

    if (db < thresholdDb || pitch === undefined) {
      this.candidate = undefined;
      return;
    }
    this.count(pitch, beat, velocity);
    if (this.candidate!.frames >= START_FRAMES) this.start(pitch, this.candidate!.velocity, this.candidate!.beat, now);
  };

  /** A new attack on the same pitch (a re-plucked string, say) restarts the note. */
  onset = (beat: number, now = performance.now()) => {
    if (!this.sounding || now - this.sounding.startedAt < MIN_REATTACK_MS) return;
    const { pitch } = this.sounding;
    this.end(beat);
    this.start(pitch, this.lastVelocity, beat, now);
  };

  /** Ends the held note when readings stop coming. */
  idle = (beat: number, now = performance.now()) => {
    if (this.sounding && now - this.lastFrameAt > SILENT_MS) this.end(beat);
  };

  private count = (pitch: number, beat: number, velocity: number) => {
    if (this.candidate?.pitch === pitch) this.candidate.frames++;
    else this.candidate = { pitch, frames: 1, beat, velocity };
  };

  private start = (pitch: number, velocity: number, beat: number, now: number) => {
    this.sounding = { pitch, velocity, startedAt: now };
    this.candidate = undefined;
    this.emit({ pitch, velocity, beat });
  };

  private end = (beat: number) => {
    if (!this.sounding) return;
    this.emit({ pitch: this.sounding.pitch, velocity: 0, beat });
    this.sounding = undefined;
  };
}

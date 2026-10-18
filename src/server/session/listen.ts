import { fromBuffer } from "osc-min";
import { InputRole } from "common";
import { BarRecord, HeardNote, InputBar } from "./analyze";

/** Live's transport resolution: ticks per quarter note. */
const TICKS_PER_BEAT = 480;
/** Notes stamped this close before a bar's start count as on its downbeat. */
const EARLY = 0.03;
/** Held notes without a note-off are dropped after this many bars. */
const MAX_HELD_BARS = 8;
const STALE_MS = 10000;

export interface NoteEvent {
  deviceId: number;
  pitch: number;
  /** 0 for note-off. */
  velocity: number;
  /** Song position in beats (quarter notes). */
  beat: number;
  receivedAt: number;
}

export interface InputInfo {
  deviceId: number;
  trackName: string;
  role: InputRole;
}

interface OpenNote {
  start: number;
  velocity: number;
  held: boolean;
  bars: number;
}

export type OscMessage =
  | { type: "note"; deviceId: number; pitch: number; velocity: number; beat: number }
  | { type: "pitch"; deviceId: number; hz: number; amplitude: number; beat: number }
  | { type: "onset"; deviceId: number; beat: number }
  | { type: "hello"; deviceId: number; kind: string };

/** Decodes the Session Input devices' OSC messages; anything else is ignored. */
export const parseOsc = (buffer: Uint8Array): OscMessage | undefined => {
  let packet;
  try {
    packet = fromBuffer(buffer);
  } catch {
    return undefined;
  }
  if (packet.oscType !== "message") return undefined;
  const args = packet.args.map((arg) => ("value" in arg ? arg.value : undefined));
  if (packet.address === "/sp/note" && args.length >= 4) {
    const [deviceId, pitch, velocity, ticks] = args.map(Number);
    if ([deviceId, pitch, velocity, ticks].some((n) => !Number.isFinite(n))) return undefined;
    return { type: "note", deviceId, pitch: Math.round(pitch), velocity: Math.round(velocity), beat: ticks / TICKS_PER_BEAT };
  }
  if (packet.address === "/sp/pitch" && args.length >= 4) {
    const [deviceId, hz, amplitude, ticks] = args.map(Number);
    if ([deviceId, hz, amplitude, ticks].some((n) => !Number.isFinite(n))) return undefined;
    return { type: "pitch", deviceId, hz, amplitude, beat: ticks / TICKS_PER_BEAT };
  }
  if (packet.address === "/sp/onset" && args.length >= 2) {
    const [deviceId, ticks] = args.map(Number);
    if ([deviceId, ticks].some((n) => !Number.isFinite(n))) return undefined;
    return { type: "onset", deviceId, beat: ticks / TICKS_PER_BEAT };
  }
  if (packet.address === "/sp/hello" && args.length >= 1) {
    const deviceId = Number(args[0]);
    return Number.isFinite(deviceId) ? { type: "hello", deviceId, kind: String(args[1] ?? "midi") } : undefined;
  }
  return undefined;
};

/**
 * Collects note events from the inputs and cuts them into bars. Notes still
 * sounding at a bar's end carry into the next bar as held notes.
 */
export class Recorder {
  private events: NoteEvent[] = [];
  private open = new Map<number, Map<number, OpenNote>>();
  private hellos = new Map<number, number>();

  push = (event: NoteEvent) => {
    this.events.push(event);
  };

  hello = (deviceId: number, at = performance.now()) => {
    this.hellos.set(deviceId, at);
  };

  isConnected = (deviceId: number, now = performance.now()) => {
    const at = this.hellos.get(deviceId);
    return at !== undefined && now - at < 5000;
  };

  /**
   * Starts a new take. Notes from the last moment stay: the first notes after
   * Play can arrive before the server hears that Live started.
   */
  reset = (keepMs = 500) => {
    const now = performance.now();
    this.events = this.events.filter((event) => now - event.receivedAt < keepMs);
    this.open.clear();
  };

  /**
   * Cuts the bar starting at `startBeat` out of the events heard so far.
   * Events outside it stay for later bars (notes just past a loop's wrap point
   * arrive before the bar they belong to), unless they're older than `staleMs`.
   */
  closeBar = (index: number, startBeat: number, beatsPerBar: number, inputs: InputInfo[], staleMs = STALE_MS): BarRecord => {
    const record = this.build(index, startBeat, beatsPerBar, inputs, this.open, true);
    const now = performance.now();
    const inBar = (event: NoteEvent) => event.beat >= startBeat - EARLY && event.beat < startBeat + beatsPerBar - EARLY;
    this.events = this.events.filter((event) => !inBar(event) && now - event.receivedAt < staleMs);
    return record;
  };

  /** The bar in progress, heard up to now, without consuming anything. */
  peekBar = (index: number, startBeat: number, beatsPerBar: number, inputs: InputInfo[], uptoBeat: number): BarRecord => {
    const open = new Map([...this.open].map(([id, notes]) => [id, new Map([...notes].map(([p, n]) => [p, { ...n }]))]));
    const heard = Math.min(Math.max(uptoBeat - startBeat, 0), beatsPerBar);
    return { ...this.build(index, startBeat, heard || beatsPerBar, inputs, open, false), beatsPerBar, partial: true };
  };

  private build = (
    index: number,
    startBeat: number,
    span: number,
    inputs: InputInfo[],
    open: Map<number, Map<number, OpenNote>>,
    commit: boolean
  ): BarRecord => {
    const inBar = this.events
      .filter((event) => event.beat >= startBeat - EARLY && event.beat < startBeat + span - EARLY)
      .sort((a, b) => a.beat - b.beat);

    const bars: InputBar[] = inputs.map((input) => {
      const sounding = open.get(input.deviceId) ?? new Map<number, OpenNote>();
      const notes: HeardNote[] = [];
      for (const event of inBar.filter((e) => e.deviceId === input.deviceId)) {
        const position = Math.max(event.beat - startBeat, 0);
        const current = sounding.get(event.pitch);
        if (current) {
          notes.push({ pitch: event.pitch, start: current.start, duration: Math.max(position - current.start, 0.01), velocity: current.velocity, held: current.held });
          sounding.delete(event.pitch);
        }
        if (event.velocity > 0) sounding.set(event.pitch, { start: position, velocity: event.velocity, held: false, bars: 0 });
      }
      // Notes still down at the end of the span sound until then, and carry over.
      for (const [pitch, note] of sounding) {
        notes.push({ pitch, start: note.start, duration: Math.max(span - note.start, 0.01), velocity: note.velocity, held: note.held });
        if (note.bars + 1 >= MAX_HELD_BARS) sounding.delete(pitch);
        else sounding.set(pitch, { start: 0, velocity: note.velocity, held: true, bars: note.bars + 1 });
      }
      if (commit) open.set(input.deviceId, sounding);
      return { deviceId: input.deviceId, trackName: input.trackName, role: input.role, notes };
    });

    return { index, beatsPerBar: span, inputs: bars };
  };
}

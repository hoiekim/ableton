import { describe, expect, test } from "bun:test";
import { AudioNotes, HeardEvent } from "./audio";

const hz = (pitch: number) => 440 * 2 ** ((pitch - 69) / 12);
const LOUD = 0.25; // -12 dB
const QUIET = 0.001; // -60 dB
const THRESHOLD = -40;

type Frame = [pitch: number | undefined, amplitude: number];

/** Feeds readings every 10 ms (0.02 beats at 120 BPM). */
const run = (frames: Frame[]) => {
  const events: HeardEvent[] = [];
  const notes = new AudioNotes((event) => events.push(event));
  frames.forEach(([pitch, amplitude], i) => notes.frame(pitch === undefined ? 0 : hz(pitch), amplitude, i * 0.02, THRESHOLD, i * 10));
  return { events, notes };
};

const repeat = (item: Frame, times: number): Frame[] => Array.from({ length: times }, () => item);

describe("AudioNotes", () => {
  test("a steady tone becomes one note from its first reading to when it fades", () => {
    const { events } = run([...repeat([60, LOUD], 20), ...repeat([60, QUIET], 5)]);
    expect(events).toEqual([
      { pitch: 60, velocity: 102, beat: 0 },
      { pitch: 60, velocity: 0, beat: 0.4 },
    ]);
  });

  test("silence and noise below the threshold make no notes", () => {
    expect(run(repeat([60, QUIET], 30)).events).toEqual([]);
    expect(run(repeat([undefined, LOUD], 30)).events).toEqual([]);
  });

  test("a single stray reading isn't a note", () => {
    expect(run([[60, LOUD] as Frame, ...repeat([undefined, QUIET], 10)]).events).toEqual([]);
  });

  test("a legato change of pitch ends one note and starts the next", () => {
    const { events } = run([...repeat([60, LOUD], 10), ...repeat([64, LOUD], 10)]);
    expect(events.map((e) => [e.pitch, e.velocity > 0 ? "on" : "off", e.beat])).toEqual([
      [60, "on", 0],
      [60, "off", 0.2],
      [64, "on", 0.2],
    ]);
  });

  test("a brief pitch wobble doesn't split the note", () => {
    const { events } = run([...repeat([60, LOUD], 10), [61, LOUD] as Frame, ...repeat([60, LOUD], 10)]);
    expect(events).toHaveLength(1);
  });

  test("an onset re-attacks a held note, and stopped readings end it", () => {
    const { events, notes } = run(repeat([60, LOUD], 10));
    notes.onset(0.3, 150);
    notes.idle(0.5, 400);
    expect(events.map((e) => [e.pitch, e.velocity > 0 ? "on" : "off", e.beat])).toEqual([
      [60, "on", 0],
      [60, "off", 0.3],
      [60, "on", 0.3],
      [60, "off", 0.5],
    ]);
  });
});

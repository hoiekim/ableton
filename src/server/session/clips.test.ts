import { describe, expect, test } from "bun:test";
import { ClipNoteData, InputClip, anchorClip, clipNotesInBar } from "./clips";

const note = (pitch: number, start: number, duration: number, extra: Partial<ClipNoteData> = {}): ClipNoteData => ({
  pitch,
  start,
  duration,
  velocity: 90,
  mute: false,
  ...extra,
});

/** A 4-bar looping clip: one whole-bar note per bar, pitches 60, 62, 64, 65. */
const clip = (extra: Partial<InputClip> = {}): InputClip => ({
  trackId: 1,
  clipId: 2,
  name: "Keys",
  notes: [note(60, 0, 4), note(62, 4, 4), note(64, 8, 4), note(65, 12, 4)],
  looping: true,
  loopStart: 0,
  loopEnd: 16,
  startMarker: 0,
  endMarker: 16,
  position: 0,
  songTime: 0,
  ...extra,
});

const pitches = (notes: { pitch: number }[]) => notes.map((n) => n.pitch);

describe("anchorClip", () => {
  test("finds the playhead at the start of the bar from a reading later in it", () => {
    // Read 1.5 beats into the bar that starts at song beat 8, with the clip 5.5 beats in.
    expect(anchorClip(clip({ position: 5.5, songTime: 9.5 }), 3, 8)).toEqual({ bar: 3, position: 4 });
  });

  test("snaps a reading that's a little off to the launch grid", () => {
    expect(anchorClip(clip({ position: 5.53, songTime: 9.5 }), 3, 8).position).toBe(4);
    expect(anchorClip(clip({ position: 5.46, songTime: 9.5 }), 3, 8).position).toBe(4);
  });

  test("leaves a reading well off the grid alone", () => {
    expect(anchorClip(clip({ position: 5.375, songTime: 9.5 }), 3, 8).position).toBe(3.875);
  });

  test("works from a reading taken before the engine counted the new bar", () => {
    // The song is already 0.1 beats into the next bar; the anchor is for the bar the engine is still on.
    expect(anchorClip(clip({ position: 4.1, songTime: 12.1 }), 2, 8)).toEqual({ bar: 2, position: 0 });
  });
});

describe("clipNotesInBar", () => {
  test("reads each bar of a looping clip, wrapping at the loop end", () => {
    const anchor = { bar: 1, position: 0 };
    expect([1, 2, 3, 4, 5, 6].map((bar) => pitches(clipNotesInBar(clip(), anchor, bar, 4)))).toEqual([
      [60],
      [62],
      [64],
      [65],
      [60],
      [62],
    ]);
    expect(clipNotesInBar(clip(), anchor, 5, 4)[0]).toEqual({ pitch: 60, start: 0, duration: 4, velocity: 90, held: false });
  });

  test("follows a clip that started on a later bar of the song", () => {
    // The clip started at bar 3, so bar 3 plays its first bar.
    const anchor = anchorClip(clip({ position: 0, songTime: 8 }), 3, 8);
    expect(pitches(clipNotesInBar(clip(), anchor, 4, 4))).toEqual([62]);
  });

  test("a note sounding from before the bar is held; one past the bar is cut", () => {
    const sustained = clip({ notes: [note(48, 2, 4)], loopEnd: 8, endMarker: 8 });
    const [first] = clipNotesInBar(sustained, { bar: 1, position: 0 }, 1, 4);
    const [second] = clipNotesInBar(sustained, { bar: 1, position: 0 }, 2, 4);
    expect(first).toMatchObject({ start: 2, duration: 2, held: false });
    expect(second).toMatchObject({ start: 0, duration: 2, held: true });
  });

  test("a loop shorter than the bar plays several times in it", () => {
    const vamp = clip({ notes: [note(60, 0, 0.5), note(67, 1, 0.5)], loopEnd: 2, endMarker: 2 });
    const notes = clipNotesInBar(vamp, { bar: 1, position: 0 }, 3, 4);
    expect(notes.map((n) => [n.pitch, n.start])).toEqual([
      [60, 0],
      [67, 1],
      [60, 2],
      [67, 3],
    ]);
  });

  test("a loop that doesn't span whole bars lands mid-bar", () => {
    // 3-beat loop in 4/4: bar 2 starts 1 beat into the loop's second pass.
    const odd = clip({ notes: [note(60, 0, 1), note(62, 1, 1), note(64, 2, 1)], loopEnd: 3, endMarker: 3 });
    const notes = clipNotesInBar(odd, { bar: 1, position: 0 }, 2, 4);
    expect(notes.map((n) => [n.pitch, n.start])).toEqual([
      [62, 0],
      [64, 1],
      [60, 2],
      [62, 3],
    ]);
  });

  test("cuts notes at the loop end and doesn't carry them across the wrap", () => {
    const long = clip({ notes: [note(60, 6, 4)], loopEnd: 8, endMarker: 8 });
    const anchor = { bar: 1, position: 0 };
    expect(clipNotesInBar(long, anchor, 2, 4)).toEqual([{ pitch: 60, start: 2, duration: 2, velocity: 90, held: false }]);
    expect(clipNotesInBar(long, anchor, 3, 4)).toEqual([]);
  });

  test("plays only the loop once inside it, not notes before the loop start", () => {
    const inner = clip({ notes: [note(48, 0, 4), note(60, 4, 4)], loopStart: 4, loopEnd: 8, startMarker: 4, endMarker: 8 });
    const anchor = { bar: 1, position: 4 };
    expect([1, 2, 3].map((bar) => pitches(clipNotesInBar(inner, anchor, bar, 4)))).toEqual([[60], [60], [60]]);
  });

  test("a clip that doesn't loop stops at its end marker", () => {
    const once = clip({ looping: false, endMarker: 8 });
    const anchor = { bar: 1, position: 0 };
    expect([1, 2, 3].map((bar) => pitches(clipNotesInBar(once, anchor, bar, 4)))).toEqual([[60], [62], []]);
  });

  test("before a clip started mid-bar, the bar is silent", () => {
    // Launched on beat 3 of bar 1 (1/4 quantization).
    const anchor = anchorClip(clip({ position: 0, songTime: 2 }), 1, 0);
    expect(anchor.position).toBe(-2);
    expect(clipNotesInBar(clip(), anchor, 1, 4)).toEqual([{ pitch: 60, start: 2, duration: 2, velocity: 90, held: false }]);
    expect(clipNotesInBar(clip(), anchor, 2, 4).map((n) => [n.pitch, n.start, n.held])).toEqual([
      [60, 0, true],
      [62, 2, false],
    ]);
  });

  test("skips muted notes", () => {
    const muted = clip({ notes: [note(60, 0, 4, { mute: true }), note(64, 0, 4)] });
    expect(pitches(clipNotesInBar(muted, { bar: 1, position: 0 }, 1, 4))).toEqual([64]);
  });

  test("nothing for bars before the anchor", () => {
    expect(clipNotesInBar(clip(), { bar: 5, position: 0 }, 4, 4)).toEqual([]);
  });

  test("3/4 time", () => {
    const waltz = clip({ notes: [note(60, 0, 3), note(62, 3, 3)], loopEnd: 6, endMarker: 6 });
    const anchor = { bar: 1, position: 0 };
    expect([1, 2, 3].map((bar) => pitches(clipNotesInBar(waltz, anchor, bar, 3)))).toEqual([[60], [62], [60]]);
  });
});

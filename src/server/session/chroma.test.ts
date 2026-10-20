import { describe, expect, test } from "bun:test";
import { HeardEvent } from "./audio";
import { ChromaNotes, strongTones } from "./chroma";

/** A chroma frame with these pitch classes strong, a little of everything else. */
const frame = (strong: Record<number, number>) => Array.from({ length: 12 }, (_, pc) => strong[pc] ?? 0.05);
const A_MINOR = frame({ 9: 1, 0: 0.8, 4: 0.9 });
const F_MAJOR = frame({ 5: 1, 9: 0.7, 0: 0.8 });
const E_NOTE = frame({ 4: 1, 11: 0.35 });

const setup = () => {
  const events: HeardEvent[] = [];
  const notes = new ChromaNotes((event) => events.push(event));
  notes.level(-12, -40, 0);
  const on = () => events.filter((e) => e.velocity > 0);
  const off = () => events.filter((e) => e.velocity === 0);
  return { notes, events, on, off };
};

describe("strongTones", () => {
  test("the pitch classes at least half as strong as the strongest, strongest first, at most 4", () => {
    expect(strongTones(A_MINOR)).toEqual([9, 4, 0]);
    expect(strongTones(E_NOTE)).toEqual([4]);
    expect(strongTones(frame({ 0: 1, 2: 0.9, 4: 0.8, 7: 0.7, 11: 0.6 }))).toEqual([0, 2, 4, 7]);
    expect(strongTones(new Array(12).fill(0))).toEqual([]);
  });
});

describe("ChromaNotes", () => {
  test("a strum plays the chord sounding just after it, stamped at the strum, root lowest", () => {
    const { notes, on } = setup();
    notes.strum(1);
    notes.frame(A_MINOR, 1.05);
    expect(on()).toEqual([]);
    notes.frame(A_MINOR, 1.1);
    expect(on().map((e) => e.beat)).toEqual([1, 1, 1]);
    // A (strongest) lowest, the rest an octave up.
    expect(on().map((e) => e.pitch)).toEqual([57, 64, 60]);
  });

  test("the next strum ends the chord and plays the new one", () => {
    const { notes, on, off } = setup();
    notes.strum(1);
    notes.frame(A_MINOR, 1.05);
    notes.frame(A_MINOR, 1.1);
    notes.strum(2);
    notes.frame(F_MAJOR, 2.05);
    notes.frame(F_MAJOR, 2.1);
    expect(off().map((e) => e.beat)).toEqual([2, 2, 2]);
    expect(on().slice(3).map((e) => e.pitch % 12).sort((a, b) => a - b)).toEqual([0, 5, 9]);
  });

  test("a chord change without a strum counts once it holds", () => {
    const { notes, on } = setup();
    for (let i = 0; i < 5; i++) notes.frame(A_MINOR, 1 + i * 0.05);
    expect(on()).toEqual([]);
    notes.frame(A_MINOR, 1.25);
    expect(on().map((e) => e.beat)).toEqual([1, 1, 1]);
  });

  test("going quiet ends the chord, and nothing quiet is struck", () => {
    const { notes, on, off } = setup();
    notes.strum(1);
    notes.frame(A_MINOR, 1.05);
    notes.frame(A_MINOR, 1.1);
    notes.level(-50, -40, 3);
    expect(off().map((e) => e.beat)).toEqual([3, 3, 3]);
    notes.strum(4);
    notes.frame(A_MINOR, 4.05);
    notes.frame(A_MINOR, 4.1);
    expect(on()).toHaveLength(3);
  });

  test("chords are told from single notes by how many pitch classes keep sounding", () => {
    const chordal = setup();
    for (let i = 0; i < 20; i++) chordal.notes.frame(A_MINOR, i * 0.05);
    expect(chordal.notes.isPolyphonic()).toBe(true);
    const single = setup();
    for (let i = 0; i < 20; i++) single.notes.frame(E_NOTE, i * 0.05);
    expect(single.notes.isPolyphonic()).toBe(false);
  });

  test("a hit is a short note on the attack, for the rhythm", () => {
    const { notes, events } = setup();
    notes.hit(2.5);
    expect(events).toEqual([
      expect.objectContaining({ pitch: 38, beat: 2.5 }),
      { pitch: 38, velocity: 0, beat: 2.6 },
    ]);
  });
});

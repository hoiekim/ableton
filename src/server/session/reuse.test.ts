import { describe, expect, test } from "bun:test";
import { initialTransport } from "common";
import { BarRecord, analyzeBand } from "./analyze";
import { Asked, ReuseCheck, bandQuiet, fingerprint, reuseReason } from "./reuse";

const print = { setup: "s", band: "b" };
const asked: Asked = { bar: 5, pattern: "backbeat", energy: 6, provider: "jev", confidence: 0.4, fingerprint: print };

const check = (overrides: Partial<ReuseCheck> = {}): ReuseCheck => ({
  settings: { midPhrase: true, silentBars: 2 },
  asked,
  lastWasFallback: false,
  joined: true,
  speechFresh: false,
  quiet: false,
  quietAsks: 0,
  bar: 6,
  length: 1,
  phraseLength: 4,
  fingerprint: print,
  ...overrides,
});

describe("reuseReason", () => {
  test("mid-phrase bars reuse an unchanged answer, even an unsure one", () => {
    expect(reuseReason(check({ bar: 6 }))).toBe("mid-phrase, nothing changed");
    expect(reuseReason(check({ bar: 7 }))).toBe("mid-phrase, nothing changed");
  });

  test("a phrase's first and last bars are always asked, and so is a clip that reaches one", () => {
    expect(reuseReason(check({ bar: 5 }))).toBeUndefined();
    expect(reuseReason(check({ bar: 8 }))).toBeUndefined();
    expect(reuseReason(check({ bar: 7, length: 2 }))).toBeUndefined();
  });

  test("any change, speech, a fallback, or not having joined yet means asking", () => {
    expect(reuseReason(check({ fingerprint: { setup: "s", band: "changed" } }))).toBeUndefined();
    expect(reuseReason(check({ fingerprint: { setup: "new style", band: "b" } }))).toBeUndefined();
    expect(reuseReason(check({ speechFresh: true }))).toBeUndefined();
    expect(reuseReason(check({ lastWasFallback: true }))).toBeUndefined();
    expect(reuseReason(check({ joined: false }))).toBeUndefined();
    expect(reuseReason(check({ asked: undefined }))).toBeUndefined();
    expect(reuseReason(check({ settings: false }))).toBeUndefined();
    expect(reuseReason(check({ settings: { midPhrase: false, silentBars: 2 } }))).toBeUndefined();
  });

  test("a silent band is asked about for the first bars, then holds, phrase edges included", () => {
    expect(reuseReason(check({ quiet: true, quietAsks: 1, bar: 8 }))).toBeUndefined();
    expect(reuseReason(check({ quiet: true, quietAsks: 2, bar: 8 }))).toBe("the band is silent");
    expect(reuseReason(check({ quiet: true, quietAsks: 5, speechFresh: true }))).toBeUndefined();
    expect(reuseReason(check({ quiet: true, quietAsks: 5, fingerprint: { setup: "new style", band: "b" } }))).toBeUndefined();
  });
});

/** Bass on the root and keys on the chord; `busy` doubles the bass's notes. */
const bar = (index: number, root: number, options: { busy?: boolean; keys?: boolean; partial?: boolean } = {}): BarRecord => ({
  index,
  beatsPerBar: 4,
  partial: options.partial,
  inputs: [
    {
      deviceId: 1,
      trackName: "Bass",
      role: "bass",
      notes: Array.from({ length: options.busy ? 8 : 4 }, (_, i) => ({ pitch: root, start: i * (options.busy ? 0.5 : 1), duration: 0.4, velocity: 90, held: false })),
    },
    {
      deviceId: 2,
      trackName: "Keys",
      role: "chords",
      notes: options.keys === false ? [] : [0, 4, 7].map((step) => ({ pitch: root + 24 + step, start: 0, duration: 3.9, velocity: 70, held: false })),
    },
  ],
});

const ROOTS = [45, 41, 48, 43];
const loop = (count: number, options: { busy?: boolean; keys?: boolean } = {}) =>
  Array.from({ length: count }, (_, i) => bar(i + 1, ROOTS[i % 4], options));
const context = { instrument: "drums" as const, direction: "", targetBar: 0 };

describe("fingerprint", () => {
  test("a repeating loop reads the same from one bar to the next", () => {
    const at = (count: number) => fingerprint(analyzeBand(loop(count)), initialTransport, { ...context, targetBar: count + 1 });
    expect(at(11).band).toBe(at(10).band);
    expect(at(12).band).toBe(at(11).band);
  });

  test("a part getting busier, or dropping out, is a change", () => {
    const steady = fingerprint(analyzeBand(loop(10)), initialTransport, { ...context, targetBar: 11 });
    const busier = fingerprint(analyzeBand([...loop(8), ...loop(2, { busy: true }).map((b, i) => ({ ...b, index: 9 + i }))]), initialTransport, {
      ...context,
      targetBar: 11,
    });
    const keysOut = fingerprint(analyzeBand([...loop(9), { ...bar(10, ROOTS[1], { keys: false }) }]), initialTransport, { ...context, targetBar: 11 });
    expect(busier.band).not.toBe(steady.band);
    expect(keysOut.band).not.toBe(steady.band);
  });

  test("the style direction, tempo and sound are the musician's setup", () => {
    const analysis = analyzeBand(loop(8));
    const base = fingerprint(analysis, initialTransport, context);
    expect(fingerprint(analysis, initialTransport, { ...context, direction: "laid back" }).setup).not.toBe(base.setup);
    expect(fingerprint(analysis, { ...initialTransport, tempo: 90 }, context).setup).not.toBe(base.setup);
    expect(fingerprint(analysis, initialTransport, { ...context, sound: "808 kit" }).setup).not.toBe(base.setup);
  });
});

describe("bandQuiet", () => {
  test("only when the last finished bar and the one in progress have nothing", () => {
    const silent = (index: number, partial = false): BarRecord => ({ index, beatsPerBar: 4, partial, inputs: [{ deviceId: 1, trackName: "Bass", role: "bass", notes: [] }] });
    expect(bandQuiet(analyzeBand([...loop(4), silent(5), silent(6, true)]))).toBe(true);
    expect(bandQuiet(analyzeBand([...loop(4), silent(5), bar(6, 45, { partial: true })]))).toBe(false);
    expect(bandQuiet(analyzeBand([...loop(5), silent(6, true)]))).toBe(false);
  });
});

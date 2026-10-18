import { describe, expect, test } from "bun:test";
import { Note } from "tonal";
import { initialTransport } from "common";
import { BarRecord, analyzeBand } from "./analyze";
import { defaultConfig } from "./config";
import { ClipSlotInfo, ClipSpec, LiveOps } from "./ops";
import { Player, PlayerSettings, Timing, msUntilBar } from "./player";
import { DecisionProvider, localProvider } from "./providers";

const settings: PlayerSettings = {
  deviceId: 50,
  trackId: 40,
  trackName: "Session Player",
  color: 0xff8800,
  instrument: "bass",
  active: true,
  lookahead: 1,
  length: 1,
  join: 1,
  energy: "auto",
};

/** The keys holding a root-position chord for the bar. */
const bandBar = (index: number, chord: string[], partial = false): BarRecord => {
  const root = Note.midi(`${chord[0]}3`)!;
  const pitches = chord.map((name) => root + ((Note.chroma(name)! - (root % 12) + 12) % 12));
  return {
    index,
    beatsPerBar: 4,
    partial,
    inputs: [
      {
        deviceId: 2,
        trackName: "Keys",
        role: "chords",
        notes: pitches.map((pitch) => ({ pitch, start: 0, duration: 3.9, velocity: 70, held: false })),
      },
    ],
  };
};

const LOOP = [["A", "C", "E", "G"], ["F", "A", "C", "E"], ["C", "E", "G"], ["G", "B", "D"]];

/** Live as the player sees it: a clock that the test advances, and clip slots that record what happens. */
class FakeLive implements LiveOps {
  clock: Timing = { playing: true, bar: 1, beatInBar: 0, beatsPerBar: 4, msPerBeat: 500 };
  slots: ClipSlotInfo[] = Array.from({ length: 8 }, (_, index) => ({ id: 100 + index, index, hasClip: false }));
  writes: { slot: number; spec: ClipSpec; bar: number; beat: number }[] = [];
  fires: { clipId: number; bar: number; beat: number; msBefore: number; target: number }[] = [];
  stops = 0;
  /** Beats of song time that pass while a clip is written. */
  writeBeats = 0;
  private lastTarget = 0;

  advance = (beats: number) => {
    this.clock.beatInBar += beats;
    while (this.clock.beatInBar >= this.clock.beatsPerBar) {
      this.clock.beatInBar -= this.clock.beatsPerBar;
      this.clock.bar++;
    }
  };

  clipSlots = async () => this.slots;
  playingSlotIndex = async () => -1;
  writeClip = async (slot: ClipSlotInfo, spec: ClipSpec) => {
    this.advance(this.writeBeats);
    this.lastTarget = Number(spec.name.split(" ")[1]);
    this.writes.push({ slot: slot.index, spec, bar: this.clock.bar, beat: this.clock.beatInBar });
    return 1000 + slot.index;
  };
  fireClip = async (clipId: number) => {
    const target = this.lastTarget;
    this.fires.push({ clipId, bar: this.clock.bar, beat: this.clock.beatInBar, msBefore: msUntilBar(target, this.clock), target });
  };
  stopTrack = async () => {
    this.stops++;
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const setup = (options: { provider?: DecisionProvider; chords?: (bar: number) => string[] } = {}) => {
  const live = new FakeLive();
  const chords = options.chords ?? ((bar: number) => LOOP[(bar - 1) % 4]);
  const player = new Player(settings, {
    config: defaultConfig,
    provider: options.provider ?? localProvider,
    ops: () => live,
    // Finished bars plus the one in progress, as the engine provides.
    analyze: () =>
      analyzeBand([
        ...Array.from({ length: live.clock.bar - 1 }, (_, i) => bandBar(i + 1, chords(i + 1))),
        bandBar(live.clock.bar, chords(live.clock.bar), true),
      ]),
    transport: () => ({ ...initialTransport, isPlaying: live.clock.playing }),
    timing: () => live.clock,
    onChange: () => {},
  });
  player.start();
  /** Plays until `bar` starts, ticking every 15 ms of song time like the engine. */
  const playUntil = async (bar: number) => {
    while (live.clock.bar < bar) {
      live.advance(15 / live.clock.msPerBeat);
      player.tick();
      await flush();
    }
  };
  return { live, player, playUntil };
};

describe("Player", () => {
  test("listens for a bar, then fires a clip for every bar before it starts", async () => {
    const { live, player, playUntil } = setup();
    await playUntil(7);

    expect(live.fires.map((fire) => fire.target)).toEqual([2, 3, 4, 5, 6, 7]);
    for (const fire of live.fires) {
      // Fired during the bar before its own, with the safety margin to spare.
      expect(fire.bar).toBe(fire.target - 1);
      expect(fire.msBefore).toBeGreaterThanOrEqual(defaultConfig.timing.fireMarginMs);
    }
    expect(player.state()).toMatchObject({ status: "playing", stats: { misses: 0 } });
  });

  test("decides late in the bar for the most context", async () => {
    const { live, playUntil } = setup();
    await playUntil(4);
    // Local decisions take ~0 ms, so they happen in the last quarter of the bar.
    live.writes.forEach((write) => expect(write.beat).toBeGreaterThan(2.5));
  });

  test("renders each clip for the coming bar's chord once the chords repeat", async () => {
    const { live, playUntil } = setup();
    await playUntil(10);
    const chordFor = (bar: number) => live.writes.find((write) => write.spec.name.startsWith(`SP ${bar} `))?.spec.name.split(" ")[3];
    // The loop Am7 Fmaj7 C G: from bar 6 on, the player has heard it come round
    // again and predicts each next chord.
    expect([6, 7, 8, 9].map(chordFor)).toEqual(["Fmaj7", "C", "G", "Am7"]);
  });

  test("never writes into the slot that is playing", async () => {
    const { live, playUntil } = setup();
    await playUntil(9);
    for (let i = 1; i < live.writes.length; i++) expect(live.writes[i].slot).not.toBe(live.writes[i - 1].slot);
    live.writes.forEach((write) => expect(write.slot).toBeGreaterThanOrEqual(4)); // the last 4 slots
  });

  test("keeps a looping clip instead of rewriting identical bars", async () => {
    const { live, player, playUntil } = setup({ chords: () => LOOP[0] });
    await playUntil(9);
    // 7 bars played (2–8); fills at phrase ends still need new clips.
    expect(live.writes.length).toBeLessThan(7);
    expect(player.state().recent.some((log) => log.outcome === "kept")).toBe(true);
  });

  test("does nothing while the transport is stopped", async () => {
    const { live, player } = setup();
    live.clock.playing = false;
    for (let i = 0; i < 400; i++) {
      live.advance(0.03);
      player.tick();
      await flush();
    }
    expect(live.fires).toHaveLength(0);
    expect(player.state().status).toBe("waiting");
  });

  test("a slow decision model is cut off in time and local rules answer", async () => {
    const never: DecisionProvider = { name: "slow", decide: () => new Promise(() => {}) };
    const { live, player, playUntil } = setup({ provider: never });
    // Run to the decision point, then wait out the time budget in real time.
    while (!player.state().recent.length && live.clock.bar < 2) {
      live.advance(15 / live.clock.msPerBeat);
      player.tick();
      await flush();
      if (msUntilBar(2, live.clock) < 700) await Bun.sleep(600);
    }
    await playUntil(2);
    expect(live.fires[0]?.target).toBe(2);
    expect(player.state().recent[0]).toMatchObject({ outcome: "fired", provider: "local" });
    expect(player.state().recent[0].fallbackReason).toContain("took longer");
  });

  test("a clip that can't be ready in time isn't fired late, and the choice moves to the next bar", async () => {
    const { live, player, playUntil } = setup();
    live.writeBeats = 2; // writing takes half a bar
    await playUntil(3);
    live.writeBeats = 0;
    await playUntil(5);
    const outcomes = player.state().recent.map((log) => `${log.bar}:${log.outcome}`).reverse();
    expect(outcomes[0]).toBe("2:missed");
    expect(live.fires.every((fire) => fire.msBefore > 0)).toBe(true);
    expect(live.fires.map((fire) => fire.target)).toContain(4);
  });

  test("switching the device off stops its clips", async () => {
    const { live, player, playUntil } = setup();
    await playUntil(3);
    player.update({ ...settings, active: false });
    await flush();
    expect(live.stops).toBe(1);
    expect(player.state().status).toBe("playing");
    player.tick();
    expect(player.state().status).toBe("off");
  });
});

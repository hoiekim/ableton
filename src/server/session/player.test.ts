import { describe, expect, test } from "bun:test";
import { Note } from "tonal";
import { SpeechState, initialTransport } from "common";
import { BarRecord, UpcomingNotes, analyzeBand } from "./analyze";
import { defaultConfig } from "./config";
import { ClipSlotInfo, ClipSpec, LiveOps } from "./ops";
import { Player, PlayerSettings, Timing, msUntilBar } from "./player";
import { DecisionProvider, decideLocally, localProvider } from "./providers";

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
  instrument = async () => undefined;
  setSessionParam = async () => {};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A decision model that answers at once: the local choice, with its own say on fills. */
const fakeModel = (fill?: boolean, join = true): DecisionProvider => ({
  name: "model",
  decide: async (request) => ({
    ...decideLocally(request),
    ...(fill !== undefined && { fill }),
    ...(request.joinBar !== undefined && { join }),
    provider: "model",
  }),
});

const setup = (
  options: {
    provider?: DecisionProvider;
    chords?: (bar: number) => string[];
    clips?: boolean;
    settings?: Partial<PlayerSettings>;
    speech?: SpeechState[];
  } = {}
) => {
  const live = new FakeLive();
  const speech = options.speech ?? [];
  const chords = options.chords ?? ((bar: number) => LOOP[(bar - 1) % 4]);
  // With clips, the band's Keys clip says what every bar will play.
  const upcoming: UpcomingNotes | undefined = options.clips ? (bar) => bandBar(bar, chords(bar)).inputs : undefined;
  const player = new Player({ ...settings, ...options.settings }, {
    config: defaultConfig,
    provider: options.provider ?? localProvider,
    ops: () => live,
    // Finished bars plus the one in progress, as the engine provides.
    analyze: () =>
      analyzeBand([
        ...Array.from({ length: live.clock.bar - 1 }, (_, i) => bandBar(i + 1, chords(i + 1))),
        bandBar(live.clock.bar, chords(live.clock.bar), true),
      ], upcoming),
    transport: () => ({ ...initialTransport, isPlaying: live.clock.playing }),
    timing: () => live.clock,
    direction: () => "",
    speech: () => speech,
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
  /** Someone says something on the Vocals track now. */
  const say = (text: string) => speech.unshift({ text, trackName: "Vocals", bar: live.clock.bar, at: Date.now() });
  return { live, player, playUntil, say };
};

const firedBars = (live: FakeLive) => live.fires.map((fire) => fire.target);
const fillBars = (live: FakeLive) => live.writes.filter((write) => write.spec.name.endsWith(" fill")).map((write) => Number(write.spec.name.split(" ")[1]));

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

  test("with the band playing clips, renders the coming bar's chord from the first bar it plays", async () => {
    const { live, playUntil } = setup({ clips: true });
    await playUntil(7);
    const chordFor = (bar: number) => live.writes.find((write) => write.spec.name.startsWith(`SP ${bar} `))?.spec.name.split(" ")[3];
    expect([2, 3, 4, 5, 6].map(chordFor)).toEqual(["Fmaj7", "C", "G", "Am7", "Fmaj7"]);
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

  test("speech while waiting to join brings the player in early, for the decision model to answer", async () => {
    const { live, player, playUntil, say } = setup({ provider: fakeModel(), settings: { join: 4 } });
    await playUntil(2);
    expect(live.fires).toHaveLength(0);
    say("ok let's go, give me a cue");
    await playUntil(5);
    // It would have joined at bar 5; the next bar a decision could still make was 3.
    expect(firedBars(live)[0]).toBe(3);
    expect(player.detail(3)!.sent.state).toContain('Heard on Vocals this bar: "ok let\'s go, give me a cue"');
  });

  test("asked early, the decision model may choose to wait for the Join bar", async () => {
    const { live, player, playUntil, say } = setup({ provider: fakeModel(undefined, false), settings: { join: 4 } });
    await playUntil(2);
    say("are you ready?");
    await playUntil(6);
    expect(firedBars(live)[0]).toBe(5);
    expect(player.state().recent.at(-1)).toMatchObject({ bar: 3, outcome: "waited" });
  });

  test("without the decision model's answer on coming in early, it asks again for the next bar", async () => {
    let calls = 0;
    // Its first early answer comes too late; local rules can't answer for it.
    const flaky: DecisionProvider = {
      name: "model",
      decide: async (request) => {
        if (request.joinBar !== undefined && calls++ === 0) throw new Error("timed out");
        return { ...decideLocally(request), ...(request.joinBar !== undefined && { join: true }), provider: "model" };
      },
    };
    const { live, player, playUntil, say } = setup({ provider: flaky, settings: { join: 4 } });
    await playUntil(2);
    say("ok let's go");
    await playUntil(6);
    expect(firedBars(live)[0]).toBe(4);
    expect(player.state().recent.at(-1)).toMatchObject({ bar: 3, outcome: "waited" });
    expect(player.state().recent.at(-1)!.fallbackReason).toContain("No answer on coming in early");
  });

  test("local rules don't read speech, so the player joins as set", async () => {
    const { live, playUntil, say } = setup({ settings: { join: 4 } });
    await playUntil(2);
    say("ok let's go");
    await playUntil(6);
    expect(firedBars(live)[0]).toBe(5);
  });

  test("fills wait for a phrase's last bar, unless someone just asked for one", async () => {
    const plain = setup({ provider: fakeModel(true) });
    await plain.playUntil(10);
    expect(fillBars(plain.live)).toEqual([4, 8]);

    const cued = setup({ provider: fakeModel(true) });
    await cued.playUntil(5);
    cued.say("give me a fill");
    await cued.playUntil(10);
    // One cued fill straight away, then back to the phrase ends.
    expect(fillBars(cued.live)).toEqual([4, 6, 8]);
  });

  test("keeps what each decision was sent and got back, and the notes it wrote", async () => {
    const { live, player, playUntil } = setup();
    let pendingSeen = false;
    while (live.clock.bar < 4) {
      live.advance(15 / live.clock.msPerBeat);
      player.tick();
      if (player.state().pending.length) pendingSeen = true;
      await flush();
    }
    expect(pendingSeen).toBe(true);
    const fired = player.state().recent.find((log) => log.bar === 3)!;
    expect(fired).toMatchObject({ outcome: "fired", length: 1 });
    expect(fired.notes!.length).toBeGreaterThan(0);
    fired.notes!.forEach(([pitch, start, duration, velocity]) => {
      expect(pitch).toBeGreaterThan(0);
      expect(start + duration).toBeLessThanOrEqual(4);
      expect(velocity).toBeGreaterThan(0);
    });
    const detail = player.detail(3)!;
    expect(detail.sent.state).toContain("You play bass.");
    // Only the latest decision carries its state text to the web page.
    expect(player.state().recent[0].state).toBe(player.detail(player.state().recent[0].bar)!.sent.state);
    expect(fired.state).toBeUndefined();
    expect(detail.sent.options.map((option) => option.id)).toContain(fired.pattern);
    expect(detail.ranking![0].pattern).toBe(fired.pattern);
    expect(player.detail(99)).toBeUndefined();
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

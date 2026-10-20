import { describe, expect, test } from "bun:test";
import { Note } from "tonal";
import { SpeechState, initialTransport } from "common";
import { BarRecord, UpcomingNotes, analyzeBand } from "./analyze";
import { SessionConfig, defaultConfig } from "./config";
import { BandPlan } from "./plan";
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
  copyDevice = async () => 0;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A decision model that answers at once: the local choice, with its own say on fills. */
const fakeModel = (fill?: boolean, join = true): DecisionProvider => ({
  name: "model",
  decide: async (request) => {
    const local = decideLocally(request);
    // With concrete bars, a fill is an option of its own: take it when offered.
    const wanted = fill !== undefined && request.candidates?.find((c) => c.fill === fill && c.pattern === local.pattern && c.variant === local.variant);
    const chosen = wanted ? { ...local, fill: wanted.fill, notes: wanted.notes, candidateId: wanted.id } : { ...local, ...(fill !== undefined && !request.candidates && { fill }) };
    return { ...chosen, ...(request.joinBar !== undefined && { join }), provider: "model" };
  },
});

const setup = (
  options: {
    provider?: DecisionProvider;
    chords?: (bar: number) => string[];
    clips?: boolean;
    settings?: Partial<PlayerSettings>;
    speech?: SpeechState[];
    /** Bars in which the band plays nothing. */
    silent?: (bar: number) => boolean;
    config?: SessionConfig;
    plan?: BandPlan;
  } = {}
) => {
  const live = new FakeLive();
  const speech = options.speech ?? [];
  const chords = options.chords ?? ((bar: number) => LOOP[(bar - 1) % 4]);
  // With clips, the band's Keys clip says what every bar will play.
  const upcoming: UpcomingNotes | undefined = options.clips ? (bar) => bandBar(bar, chords(bar)).inputs : undefined;
  const heard = (bar: number, partial = false): BarRecord =>
    options.silent?.(bar)
      ? { index: bar, beatsPerBar: 4, partial, inputs: [{ deviceId: 2, trackName: "Keys", role: "chords", notes: [] }] }
      : bandBar(bar, chords(bar), partial);
  const player = new Player({ ...settings, ...options.settings }, {
    config: options.config ?? defaultConfig,
    provider: options.provider ?? localProvider,
    ops: () => live,
    // Finished bars plus the one in progress, as the engine provides.
    analyze: () =>
      analyzeBand([...Array.from({ length: live.clock.bar - 1 }, (_, i) => heard(i + 1)), heard(live.clock.bar, true)], upcoming),
    transport: () => ({ ...initialTransport, isPlaying: live.clock.playing }),
    timing: () => live.clock,
    direction: () => "",
    speech: () => speech,
    plan: () => options.plan,
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

/** A decision model that answers at once with the local choice, and notes each bar it's asked about. */
const countingModel = () => {
  const asked: number[] = [];
  const provider: DecisionProvider = {
    name: "model",
    decide: async (request) => {
      asked.push(request.targetBar);
      return { ...decideLocally(request), ...(request.joinBar !== undefined && { join: true }), provider: "model" };
    },
  };
  return { asked, provider };
};

const reusedBars = (player: Player) =>
  player
    .state()
    .recent.filter((log) => log.reused)
    .map((log) => log.bar)
    .sort((a, b) => a - b);
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

  test("plays exactly the concrete bar chosen, offered with its facts", async () => {
    const { live, player, playUntil } = setup();
    await playUntil(5);
    const log = player.state().recent.find((l) => l.bar === 4 && l.outcome === "fired")!;
    const detail = player.detail(4)!;
    const chosen = detail.sent.options.find((o) => o.id === (log.variant ? `${log.pattern}~${log.variant}` : log.pattern) || o.id.startsWith(log.pattern))!;
    expect(chosen.description).toContain("Energy");
    expect(detail.sent.options.length).toBeGreaterThan(10);
    const written = live.writes.find((w) => w.spec.name.startsWith("SP 4 "))!;
    expect(written.spec.notes.length).toBe(log.notes!.length);
  });

  test("with concrete bars off, the named patterns are offered as before", async () => {
    const config = { ...defaultConfig, jev: { ...defaultConfig.jev, candidates: false as const } };
    const { player, playUntil } = setup({ config });
    await playUntil(5);
    const detail = player.detail(4)!;
    expect(detail.sent.options.map((o) => o.id)).toEqual(expect.arrayContaining(["root-eighths", "walking"]));
    expect(detail.sent.options.some((o) => o.id.includes("~"))).toBe(false);
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

  describe("reusing the decision model's answer", () => {
    test("a steady band: phrase edges are always asked, unchanged mid-phrase bars reuse the last answer", async () => {
      const model = countingModel();
      const { live, player, playUntil } = setup({ provider: model.provider });
      await playUntil(17);
      // Every bar is played, none missed, but not every one cost a call.
      expect(firedBars(live).length + player.state().recent.filter((log) => log.outcome === "kept").length).toBeGreaterThanOrEqual(15);
      expect(player.state().stats.misses).toBe(0);
      for (const edge of [4, 5, 8, 9, 12, 13, 16]) expect(model.asked).toContain(edge);
      expect(reusedBars(player)).toEqual(expect.arrayContaining([10, 11, 14, 15]));
      expect(player.state().stats).toMatchObject({ calls: model.asked.length, reused: reusedBars(player).length });
      // A reused answer is the last call's, and says so.
      const reused = player.state().recent.find((log) => log.bar === 11)!;
      expect(reused.reused).toEqual({ from: 9, reason: "mid-phrase, nothing changed" });
      expect(reused.fill).toBe(false);
    });

    test("a reused decision waits for the last moment, for the most context", async () => {
      const model = countingModel();
      const { live, player, playUntil } = setup({ provider: model.provider });
      await playUntil(13);
      const written = (bar: number) => live.writes.find((write) => write.spec.name.startsWith(`SP ${bar} `))!;
      expect(reusedBars(player)).toContain(10);
      // Asked bars allow for the decision model's time (450 ms until it has been timed);
      // a reused one is decided in the last ~250 ms before its bar (500 ms a beat here).
      expect(written(4).beat).toBeLessThan(3);
      expect(written(10).beat).toBeGreaterThan(3.45);
    });

    test("a band gone silent is asked about twice, then the answer holds until it plays again", async () => {
      const model = countingModel();
      const { player, playUntil } = setup({ provider: model.provider, silent: (bar) => bar >= 6 && bar <= 12 });
      await playUntil(16);
      // Bars 8 and 9 are decided once bars 6 and 7 were silent; then it holds.
      expect(model.asked).toEqual(expect.arrayContaining([8, 9]));
      for (const held of [10, 11, 12, 13]) expect(model.asked).not.toContain(held);
      expect(player.state().recent.find((log) => log.bar === 12)!.reused?.reason).toBe("the band is silent");
      // Notes in bar 13: the next decision asks again.
      expect(model.asked).toContain(14);
    });

    test("something said in the last bars is always asked about", async () => {
      const model = countingModel();
      const { playUntil, say } = setup({ provider: model.provider });
      await playUntil(9);
      say("take it down");
      await playUntil(13);
      expect(model.asked).toEqual(expect.arrayContaining([10, 11, 12]));
    });

    test("turned off, every decision is asked", async () => {
      const model = countingModel();
      const { player, playUntil } = setup({ provider: model.provider, config: { ...defaultConfig, jev: { ...defaultConfig.jev, reuse: false } } });
      await playUntil(13);
      expect(reusedBars(player)).toEqual([]);
      expect(model.asked).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    });

    test("a reused answer plays the same bar again, on the new chord", async () => {
      const model = countingModel();
      const { player, playUntil } = setup({ provider: model.provider });
      await playUntil(13);
      const reused = player.state().recent.find((log) => log.reused)!;
      const asked = player.detail(reused.reused!.from)!.log;
      expect([reused.pattern, reused.variant, reused.energy]).toEqual([asked.pattern, asked.variant, asked.energy]);
    });

    test("local rules are never reused: they cost nothing", async () => {
      const { player, playUntil } = setup();
      await playUntil(13);
      expect(reusedBars(player)).toEqual([]);
      expect(player.state().stats.calls).toBe(0);
    });
  });

  describe("following the band plan", () => {
    const plan: BandPlan = {
      decidedAt: 4,
      intensity: 5,
      provider: "model",
      phrases: [
        { start: 5, section: "build", ending: "big-fill" },
        { start: 9, section: "climax", ending: "stop" },
        { start: 13, section: "break", ending: "fill" },
        { start: 17, section: "groove", ending: "none" },
      ],
    };
    const run = async () => {
      const { live, player, playUntil } = setup({ plan, settings: { instrument: "drums" } });
      await playUntil(20);
      const log = (bar: number) => player.state().recent.find((l) => l.bar === bar)!;
      const written = (bar: number) => live.writes.find((w) => w.spec.name.startsWith(`SP ${bar} `));
      return { log, written, player };
    };

    test("a build rises bar by bar and ends with its big fill", async () => {
      const { log } = await run();
      expect([5, 6, 7, 8].map((bar) => log(bar).energy)).toEqual([4, 5, 6, 7]);
      expect([5, 6, 7].map((bar) => log(bar).fill)).toEqual([false, false, false]);
      expect(log(8).fill).toBe(true);
    });

    test("a stop plays only beat 1 of the phrase's last bar", async () => {
      const { log, written } = await run();
      expect(log(10).energy).toBe(8);
      const stop = written(12)!.spec.notes;
      expect(stop.length).toBeGreaterThan(0);
      expect(stop.every((n) => n.start === 0)).toBe(true);
    });

    test("a break rests, then picks up into the next phrase", async () => {
      const { log, written } = await run();
      expect([13, 14, 15].map((bar) => log(bar).pattern)).toEqual(["rest", "rest", "rest"]);
      const pickup = written(16)!.spec.notes;
      expect(log(16).fill).toBe(true);
      expect(pickup.every((n) => n.start >= 3)).toBe(true);
    });

    test("each bar's decision reads the plan", async () => {
      const { player } = await run();
      expect(player.detail(7)!.sent.state).toContain("Band plan (made in bar 4): this phrase is a BUILD, bar 3 of 4, aim for energy 6; it ends with a big fill.");
    });
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

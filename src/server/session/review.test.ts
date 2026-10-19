import { describe, expect, test } from "bun:test";
import { PatternReview, TransportState, initialTransport } from "common";
import { analyzeBand } from "./analyze";
import { defaultConfig } from "./config";
import { RawInstrument, profileInstrument } from "./instrument";
import { ClipSlotInfo, ClipSpec, LiveOps } from "./ops";
import { Player, PlayerSettings } from "./player";
import { localProvider } from "./providers";
import { AuditionError, ReviewRequest, auditionPattern, auditionSlot, parseReviewRequest, reviewPatterns } from "./review";

/** The mock's AI Drums kit: its pads are off the General MIDI notes. */
const KIT_808: Record<number, string> = {
  48: "Kick 808",
  50: "Snare Tight",
  51: "Clap 909",
  52: "Tom Lo",
  54: "Hat Closed",
  55: "Tom Hi",
  58: "Hat Open",
  60: "Shaker",
  61: "Crash",
  62: "Conga Hi",
};

const drumRack: RawInstrument = {
  id: 11,
  name: "808 Core Kit",
  className: "DrumGroupDevice",
  displayName: "Drum Rack",
  pads: Object.entries(KIT_808).map(([note, name]) => ({ note: Number(note), name })),
};

/** A nylon guitar sample that dies away quickly (the mock's decays too slowly to count as plucky). */
const nylonGuitar: RawInstrument = {
  id: 12,
  name: "Nylon Guitar",
  className: "InstrumentGroupDevice",
  displayName: "Instrument Rack",
  chains: [
    {
      name: "Nylon Guitar",
      instruments: [
        {
          id: 13,
          name: "Nylon Guitar",
          className: "OriginalSimpler",
          displayName: "Simpler",
          samples: ["Nylon Guitar C3.wav"],
          envelope: [
            { name: "Ve Attack", value: 1, min: 0.1, max: 20000 },
            { name: "Ve Decay", value: 400, min: 1, max: 60000 },
            { name: "Ve Sustain", value: 0.05, min: 0, max: 1 },
            { name: "Ve Release", value: 300, min: 1, max: 60000 },
          ],
        },
      ],
    },
  ],
};

const settings = (trackName: string, deviceId: number): PlayerSettings => ({
  deviceId,
  trackId: deviceId + 100,
  trackName,
  color: 0xc792ff,
  instrument: "auto",
  active: true,
  lookahead: 1,
  length: 1,
  join: 1,
  energy: "auto",
});

/** A player on Auto with an instrument loaded after it, as the engine sets one up. */
const playerWith = (trackName: string, deviceId: number, raw?: RawInstrument) => {
  const player = new Player(settings(trackName, deviceId), {
    config: defaultConfig,
    provider: localProvider,
    ops: () => undefined,
    analyze: () => analyzeBand([]),
    transport: () => initialTransport,
    timing: () => ({ playing: false, bar: 0, beatInBar: 0, beatsPerBar: 4, msPerBeat: 500 }),
    direction: () => "",
    speech: () => [],
    onChange: () => {},
  });
  if (raw) player.setInstrument(profileInstrument(raw));
  return player;
};

const request = (query = ""): ReviewRequest => {
  const parsed = parseReviewRequest(new URLSearchParams(query));
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
};

/** The page gets the review as JSON. */
const review = (player: Player, query = "", transport: TransportState = initialTransport): PatternReview => {
  return JSON.parse(JSON.stringify(reviewPatterns(player.patternSource(), transport, request(query))));
};

const notesOf = (result: PatternReview, id: string) => result.patterns.find((pattern) => pattern.id === id)!.notes;

describe("parseReviewRequest", () => {
  test("defaults to energy 6, no fill, over Am7 Fmaj7 C G", () => {
    const parsed = request();
    expect(parsed.energy).toBe(6);
    expect(parsed.fill).toBe(false);
    expect(parsed.chords.map((chord) => chord.symbol)).toEqual(["Am7", "Fmaj7", "C", "G"]);
  });

  test("reads energy, fill and chords, keeping energy within 1–10", () => {
    const parsed = request("energy=9&fill=1&chords=Dm7,G7,Cmaj7");
    expect(parsed).toMatchObject({ energy: 9, fill: true });
    expect(parsed.chords.map((chord) => chord.symbol)).toEqual(["Dm7", "G7", "Cmaj7"]);
    expect(request("energy=0").energy).toBe(1);
    expect(request("energy=15").energy).toBe(10);
  });

  test("says what's wrong with a bad request", () => {
    expect(parseReviewRequest(new URLSearchParams("energy=loud"))).toContain("Energy");
    expect(parseReviewRequest(new URLSearchParams("fill=maybe"))).toContain("Fill");
    expect(parseReviewRequest(new URLSearchParams("chords=Am7,Hmaj9"))).toBe('Unknown chord "Hmaj9"');
    expect(parseReviewRequest(new URLSearchParams(`chords=${Array(9).fill("C").join(",")}`))).toContain("At most");
  });
});

describe("drum patterns for the 808 Core Kit", () => {
  const drums = playerWith("AI Drums", 1, drumRack);
  const result = review(drums);

  test("offers all 10 drum patterns, described as the decision model reads them", () => {
    expect(result.instrument).toBe("drums");
    expect(result.sound?.name).toBe("808 Core Kit");
    expect(result.patterns).toHaveLength(10);
    const backbeat = result.patterns.find((pattern) => pattern.id === "backbeat")!;
    expect(backbeat.description).toContain('kick "Kick 808" C2');
    expect(backbeat.description).toBe(drums.patternSource().options.find((o) => o.id === "backbeat")!.description);
    expect(backbeat.energy).toEqual([4, 7]);
  });

  test("plays only the kit's pads, named as in the kit", () => {
    const pitches = new Set(result.patterns.flatMap((pattern) => pattern.notes.map(([pitch]) => pitch)));
    pitches.forEach((pitch) => expect(KIT_808[pitch]).toBeDefined());
    expect(pitches.has(36)).toBe(false);
    expect(result.sounds!.map((sound) => sound.pitch)).toEqual([...pitches].sort((a, b) => a - b));
    for (const sound of result.sounds!) expect(sound.name).toBe(KIT_808[sound.pitch]);
    expect(result.sounds!.find((sound) => sound.pitch === 48)!.roles).toEqual(["kick"]);
    // Stand-ins show: this kit has no rim or ride, so they land on the snare and the closed hat.
    expect(result.sounds!.find((sound) => sound.pitch === 50)!.roles).toContain("rim");
  });

  test("notes are compact and inside the 4 bars", () => {
    expect(result.chords).toEqual(["Am7", "Fmaj7", "C", "G"]);
    expect(result.beatsPerBar).toBe(4);
    for (const pattern of result.patterns) {
      for (const [pitch, start, duration, velocity, held] of pattern.notes) {
        expect(Number.isInteger(pitch)).toBe(true);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(start).toBeLessThan(16);
        expect(duration).toBeGreaterThan(0);
        expect(velocity).toBeGreaterThanOrEqual(1);
        expect(velocity).toBeLessThanOrEqual(127);
        expect(Math.round(start * 1000)).toBeCloseTo(start * 1000, 6);
        expect(held).toBeUndefined();
      }
    }
  });

  test("the same request renders the same notes", () => {
    expect(review(drums, "energy=8&fill=1")).toEqual(review(drums, "energy=8&fill=1"));
  });

  test("a fill changes the last beat and nothing before it", () => {
    const withFill = review(drums, "fill=1");
    expect(withFill.fill).toBe(true);
    for (const { id, notes } of result.patterns.filter((pattern) => pattern.id !== "rest")) {
      const filled = notesOf(withFill, id);
      expect(filled.filter(([, start]) => start >= 15)).not.toEqual(notes.filter(([, start]) => start >= 15));
      expect(filled.filter(([, start]) => start < 15)).toEqual(notes.filter(([, start]) => start < 15));
    }
  });

  test("energy makes it louder", () => {
    const loudness = (energy: number) => {
      const velocities = notesOf(review(drums, `energy=${energy}`), "backbeat").map(([, , , velocity]) => velocity);
      return velocities.reduce((sum, v) => sum + v, 0) / velocities.length;
    };
    expect(loudness(9)).toBeGreaterThan(loudness(3));
  });

  test("follows the time signature", () => {
    const sixEight = review(drums, "", { ...initialTransport, signatureNumerator: 6, signatureDenominator: 8 });
    expect(sixEight.beatsPerBar).toBe(3);
    sixEight.patterns.forEach((pattern) => pattern.notes.forEach(([, start]) => expect(start).toBeLessThan(12)));
  });

  test("a kit missing sounds is offered fewer patterns", () => {
    const small = playerWith("Small Kit", 3, { ...drumRack, pads: [{ note: 36, name: "Kick" }, { note: 38, name: "Snare" }, { note: 42, name: "Hat" }] });
    expect(review(small).patterns.length).toBeLessThan(10);
  });
});

describe("guitar patterns for a nylon guitar", () => {
  const guitar = playerWith("AI Guitar", 2, nylonGuitar);
  const result = review(guitar);

  test("offers the guitar patterns over the progression, without drum sounds", () => {
    expect(result.instrument).toBe("guitar");
    expect(result.patterns.map((pattern) => pattern.id)).toEqual([
      "ballad-strum",
      "strum-quarters",
      "strum-eighths",
      "power-eighths",
      "funk-chops",
      "picking",
      "rest",
    ]);
    expect(result.sounds).toBeUndefined();
    expect(notesOf(result, "rest")).toEqual([]);
  });

  test("says how each pattern suits the plucky sound", () => {
    const ballad = result.patterns.find((pattern) => pattern.id === "ballad-strum")!;
    expect(ballad.articulation).toBe("sustained");
    expect(ballad.fit).toBeLessThan(0);
    expect(ballad.description).toContain("Poor fit");
    expect(result.patterns.find((pattern) => pattern.id === "picking")!.fit).toBeGreaterThan(0);
  });

  test("plays each bar's chord", () => {
    const pcs = (root: number, intervals: number[]) => new Set(intervals.map((i) => (root + i) % 12));
    const bars = [pcs(9, [0, 3, 7, 10]), pcs(5, [0, 4, 7, 11]), pcs(0, [0, 4, 7]), pcs(7, [0, 4, 7])];
    for (const [pitch, start] of notesOf(result, "strum-quarters")) {
      expect(bars[Math.floor(start / 4)].has(pitch % 12)).toBe(true);
    }
  });

  test("a player with no instrument read yet is offered the keys patterns, unadapted", () => {
    const unknown = review(playerWith("New Player", 4));
    expect(unknown.instrument).toBe("keys");
    expect(unknown.sound).toBeUndefined();
    unknown.patterns.forEach((pattern) => expect(pattern.fit).toBe(0));
  });
});

/** Live's clip slots, recording what's written; the player's ring is the last 4 of 8. */
class FakeOps implements LiveOps {
  slots: ClipSlotInfo[] = Array.from({ length: 8 }, (_, index) => ({ id: 200 + index, index, hasClip: false }));
  writes: { slot: number; spec: ClipSpec }[] = [];
  fires = 0;
  clipSlots = async () => this.slots;
  playingSlotIndex = async () => -1;
  writeClip = async (slot: ClipSlotInfo, spec: ClipSpec) => {
    this.writes.push({ slot: slot.index, spec });
    this.slots[slot.index] = { ...slot, hasClip: true };
    return 1000 + slot.index;
  };
  fireClip = async () => {
    this.fires++;
  };
  stopTrack = async () => {};
  setSessionParam = async () => {};
  instrument = async () => undefined;
}

describe("auditions", () => {
  const drums = playerWith("AI Drums", 1, drumRack);

  test("go into the empty slot just above the player's ring, never into it", () => {
    const slots = new FakeOps().slots;
    expect(auditionSlot(slots, 4)?.index).toBe(3);
    slots[3] = { ...slots[3], hasClip: true };
    expect(auditionSlot(slots, 4)?.index).toBe(2);
    expect(auditionSlot(slots.slice(0, 4), 4)).toBeUndefined();
  });

  test("write what the page shows, without launching it, and reuse their slot", async () => {
    const ops = new FakeOps();
    const shown = notesOf(review(drums, "energy=9&fill=1"), "backbeat");
    const first = await auditionPattern(drums.patternSource(), ops, initialTransport, request("energy=9&fill=1"), "backbeat", 4);
    expect(first).toMatchObject({ trackName: "AI Drums", slot: 3, clipName: "Audition backbeat e9 fill", slotId: 203 });
    const [write] = ops.writes;
    expect(write.spec).toMatchObject({ name: "Audition backbeat e9 fill", color: 0xc792ff, length: 16 });
    expect(write.spec.notes.map((n) => [n.pitch, n.start, n.duration, n.velocity])).toEqual(shown.map(([p, s, d, v]) => [p, s, d, v]));
    expect(ops.fires).toBe(0);

    const second = await auditionPattern(drums.patternSource(), ops, initialTransport, request(), "four-on-floor", 4, first.slotId);
    expect(second.slot).toBe(3);
  });

  test("say why they can't be done", async () => {
    const ops = new FakeOps();
    const audition = (patternId: string) => auditionPattern(drums.patternSource(), ops, initialTransport, request(), patternId, 4);
    await expect(audition("polka")).rejects.toMatchObject({ status: 404 });
    ops.slots = ops.slots.map((slot) => ({ ...slot, hasClip: true }));
    const error = await audition("backbeat").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuditionError);
    expect(error).toMatchObject({ status: 409 });
    expect(ops.writes).toHaveLength(0);
  });
});

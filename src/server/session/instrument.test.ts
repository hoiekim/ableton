import { describe, expect, test } from "bun:test";
import { RawInstrument, STANDARD_KIT, buildKit, drumRole, profileInstrument, readEnvelope } from "./instrument";
import { chordFromSymbol, seededRandom } from "./music";
import { optionsFor } from "./patterns";

const drumRack = (pads: Record<number, string>, name = "808 Core Kit"): RawInstrument => ({
  id: 1,
  name,
  className: "DrumGroupDevice",
  displayName: "Drum Rack",
  pads: Object.entries(pads).map(([note, padName]) => ({ note: Number(note), name: padName })),
});

const synth = (name: string, className: string, displayName: string, extra: Partial<RawInstrument> = {}): RawInstrument => ({
  id: 2,
  name,
  className,
  displayName,
  ...extra,
});

const KIT = { 48: "Kick 808", 50: "Snare Tight", 51: "Clap 909", 52: "Tom Lo", 54: "Hat Closed", 55: "Tom Hi", 58: "Hat Open", 60: "Shaker", 62: "Conga Hi" };

describe("drumRole", () => {
  test.each([
    ["Kick 808", "kick"],
    ["BD_Deep", "kick"],
    ["Snare Tight", "snare"],
    ["SD 909", "snare"],
    ["Clap 909", "clap"],
    ["Hat Closed", "closed-hat"],
    ["HH 909", "closed-hat"],
    ["Hat Open", "open-hat"],
    ["OH Long", "open-hat"],
    ["Ride Bell", "ride"],
    ["Crash 1", "crash"],
    ["Tom Lo", "tom"],
    ["Shaker", "shaker"],
    ["Conga Hi", "conga"],
    ["Rimshot", "rim"],
    ["Cowbell", "cowbell"],
    ["Vox Chop", "fx"],
  ])("%s is a %s", (name, role) => {
    expect(drumRole(name, -1)).toBe(role as ReturnType<typeof drumRole>);
  });

  test("falls back to the General MIDI note when the name says nothing", () => {
    expect(drumRole("Sample 01", 36)).toBe("kick");
    expect(drumRole("Untitled", 42)).toBe("closed-hat");
    expect(drumRole("xyz", 100)).toBe("other");
  });
});

describe("drum kits", () => {
  test("patterns play the rack's own notes, not General MIDI", () => {
    const profile = profileInstrument(drumRack(KIT));
    expect(profile).toMatchObject({ kind: "drums", suggestedRole: "drums", notesAssumed: false });
    expect(profile.kit).toMatchObject({ kick: 48, snare: 50, clap: 51, "closed-hat": 54, "open-hat": 58, shaker: 60 });
    expect([profile.kit["tom-low"], profile.kit["tom-high"]]).toEqual([52, 55]);
  });

  test("missing sounds use stand-ins", () => {
    const { kit, substituted } = buildKit(profileInstrument(drumRack({ 36: "Kick", 38: "Snare", 42: "Hat" })).sounds);
    expect(kit.clap).toBe(38);
    expect(kit.ride).toBe(42);
    expect(substituted).toMatchObject({ clap: "snare", ride: "closed-hat" });
  });

  test("a kit without a kick puts it on the lowest sound", () => {
    const { kit } = buildKit(profileInstrument(drumRack({ 60: "Shaker", 64: "Snap" })).sounds);
    expect(kit.kick).toBe(60);
  });

  test("a nested Drum Rack names its sounds but assumes the standard notes", () => {
    const rack: RawInstrument = {
      id: 3,
      name: "My Drums",
      className: "InstrumentGroupDevice",
      displayName: "Instrument Rack",
      chains: [{ name: "Drums", instruments: [{ id: 4, name: "Kit", className: "DrumGroupDevice", displayName: "Drum Rack", drumChains: ["Kick", "Snare", "Hat"] }] }],
    };
    const profile = profileInstrument(rack);
    expect(profile).toMatchObject({ kind: "drums", notesAssumed: true, suggestedRole: "drums" });
    expect(profile.kit.kick).toBe(STANDARD_KIT.kick);
    expect(profile.summary).toContain("notes assumed");
  });

  test("Impulse plays its slots on C3 to C4", () => {
    const profile = profileInstrument(synth("Impulse", "InstrumentImpulse", "Impulse"));
    expect(profile).toMatchObject({ kind: "drums", suggestedRole: "drums", notesAssumed: false });
    expect(profile.kit).toMatchObject({ kick: 60, snare: 62, "closed-hat": 65, "tom-low": 69, "tom-high": 71 });
    expect(profile.summary).toContain("C3–C4");
  });

  test("the summary lists the pads with their notes", () => {
    expect(profileInstrument(drumRack(KIT)).summary).toContain('kick "Kick 808" C2');
  });

  test("rendered drums use only the kit's notes", () => {
    const profile = profileInstrument(drumRack(KIT));
    const notes = new Set(Object.keys(KIT).map(Number));
    for (const option of optionsFor("drums", profile)) {
      const rendered = option.render({
        chords: [chordFromSymbol("Am")!],
        beatsPerBar: 4,
        beatLength: 1,
        energy: 8,
        fill: true,
        accent: false,
        kit: profile.kit,
        random: seededRandom(1),
      });
      // The kit has no crash, rim or ride of its own; those use stand-ins that are kit notes too.
      rendered.forEach((n) => expect(notes.has(n.pitch)).toBe(true));
    }
  });
});

describe("drum options", () => {
  test("patterns that need sounds the kit lacks aren't offered", () => {
    const basic = optionsFor("drums", profileInstrument(drumRack({ 36: "Kick", 38: "Snare", 42: "Hat" }))).map((o) => o.id);
    expect(basic).not.toContain("percussion-groove");
    expect(basic).not.toContain("tom-groove");
    const full = optionsFor("drums", profileInstrument(drumRack(KIT))).map((o) => o.id);
    expect(full).toContain("percussion-groove");
    expect(full).toContain("tom-groove");
  });

  test("descriptions name the pads each pattern plays", () => {
    const backbeat = optionsFor("drums", profileInstrument(drumRack(KIT))).find((o) => o.id === "backbeat")!;
    expect(backbeat.description).toContain('kick "Kick 808" C2');
    expect(backbeat.description).toContain('closed hat "Hat Closed" F#2');
    const sparse = optionsFor("drums", profileInstrument(drumRack(KIT))).find((o) => o.id === "sparse")!;
    expect(sparse.description).toContain('rim on "Snare Tight"');
  });
});

describe("melodic sounds", () => {
  test("names say what the sound is, and Auto picks the role", () => {
    expect(profileInstrument(synth("Basic Sub Bass", "Operator", "Operator"))).toMatchObject({ suggestedRole: "bass" });
    expect(profileInstrument(synth("Warm Pad", "InstrumentVector", "Wavetable")).tags).toContain("pad");
    const guitar: RawInstrument = {
      id: 5,
      name: "Instrument Rack",
      className: "InstrumentGroupDevice",
      displayName: "Instrument Rack",
      chains: [{ name: "Chain", instruments: [synth("Simpler", "OriginalSimpler", "Simpler", { samples: ["Nylon Guitar C3.wav"] })] }],
    };
    expect(profileInstrument(guitar)).toMatchObject({ kind: "melodic", suggestedRole: "guitar" });
    expect(profileInstrument(synth("Grand Piano", "MultiSampler", "Sampler"))).toMatchObject({ suggestedRole: "keys" });
  });

  test("native instruments without telling names get their character", () => {
    expect(profileInstrument(synth("Electric", "LoungeLizard", "Electric")).tags).toEqual(["electric piano"]);
  });

  test("the envelope tells slow pads from plucks, in milliseconds or in position", () => {
    expect(readEnvelope([
      { name: "Amp Attack", value: 900, min: 0.1, max: 20000 },
      { name: "Amp Release", value: 3000, min: 1, max: 60000 },
    ])).toEqual({ attack: "slow", release: "long" });
    expect(readEnvelope([
      { name: "Ve Attack", value: 0.02, min: 0, max: 1 },
      { name: "Ve Decay", value: 0.2, min: 0, max: 1 },
      { name: "Ve Sustain", value: 0.05, min: 0, max: 1 },
    ])).toEqual({ attack: "fast", plucky: true });
    const pad = profileInstrument(
      synth("Init", "InstrumentVector", "Wavetable", {
        envelope: [
          { name: "Amp Attack", value: 900, min: 0.1, max: 20000 },
          { name: "Amp Release", value: 3000, min: 1, max: 60000 },
        ],
      })
    );
    expect(pad.tags).toContain("pad");
    expect(pad.summary).toContain("slow attack");
  });

  test("a piano's natural decay doesn't make held chords a poor fit", () => {
    const piano = profileInstrument(
      synth("Grand Piano", "MultiSampler", "Sampler", {
        envelope: [
          { name: "Ve Decay", value: 300, min: 1, max: 60000 },
          { name: "Ve Sustain", value: 0.05, min: 0, max: 1 },
        ],
      })
    );
    expect(optionsFor("keys", piano).find((o) => o.id === "half-notes")!.fit).toBeGreaterThanOrEqual(0);
  });

  test("options say which patterns suit the sound", () => {
    const pad = profileInstrument(synth("Warm Pad", "InstrumentVector", "Wavetable", { envelope: [{ name: "Amp Attack", value: 900, min: 0.1, max: 20000 }] }));
    const options = optionsFor("keys", pad);
    const sustained = options.find((o) => o.id === "pad")!;
    const busy = options.find((o) => o.id === "broken-chord")!;
    expect(sustained.fit).toBeGreaterThan(0);
    expect(busy.fit).toBeLessThan(0);
    expect(busy.description).toContain("slow-attack");
  });
});

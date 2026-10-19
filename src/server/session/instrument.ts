import { Instrument } from "common";
import { liveNoteName } from "./music";

/**
 * What the server reads about the instrument after a Session Player (see
 * readInstrument in live.ts). Only what Live 11's API exposes: a top-level
 * Drum Rack's pads, a nested Drum Rack's chain names (without notes), the
 * devices inside an Instrument Rack, Simpler's sample, and a synth's amp
 * envelope.
 */
export interface RawInstrument {
  id: number;
  /** The device's title: a preset or rack name when one is loaded. */
  name: string;
  className: string;
  displayName: string;
  /** Top-level Drum Rack: the pads that have something on them. */
  pads?: { note: number; name: string }[];
  /** Nested Drum Rack: its chains' names. Live 11 doesn't say which note plays them. */
  drumChains?: string[];
  /** File names of samples loaded in Simpler. */
  samples?: string[];
  /** Amp envelope parameters, when the device has recognizable ones. */
  envelope?: { name: string; value: number; min: number; max: number }[];
  /** Instrument Rack: each chain's name and the instruments in it. */
  chains?: { name: string; instruments: RawInstrument[] }[];
}

export type DrumRole =
  | "kick"
  | "snare"
  | "clap"
  | "rim"
  | "closed-hat"
  | "open-hat"
  | "ride"
  | "crash"
  | "tom"
  | "shaker"
  | "tambourine"
  | "cowbell"
  | "conga"
  | "perc"
  | "fx"
  | "other";

/** The sounds the drum patterns play, each resolved to a note of the loaded kit. */
export const kitRoles = [
  "kick",
  "snare",
  "clap",
  "rim",
  "closed-hat",
  "open-hat",
  "ride",
  "crash",
  "tom-low",
  "tom-mid",
  "tom-high",
  "shaker",
  "perc",
] as const;

export type KitRole = (typeof kitRoles)[number];

export type Kit = Record<KitRole, number>;

export interface DrumSound {
  note: number;
  name: string;
  role: DrumRole;
}

export type SoundTag =
  | "bass"
  | "pad"
  | "pluck"
  | "piano"
  | "electric piano"
  | "organ"
  | "bell"
  | "lead"
  | "strings"
  | "brass"
  | "guitar"
  | "synth"
  | "mallet";

export interface Envelope {
  attack?: "fast" | "slow";
  release?: "short" | "long";
  /** Dies away on its own (low sustain, short decay). */
  plucky?: boolean;
}

export interface InstrumentProfile {
  deviceId: number;
  name: string;
  displayName: string;
  kind: "drums" | "melodic";
  /** Drums: the loaded sounds, by note. */
  sounds: DrumSound[];
  /** Drums: the note each pattern sound plays, with stand-ins for missing ones. */
  kit: Kit;
  /** Drums: kit sounds that are stand-ins, e.g. clap played on the snare. */
  substituted: Partial<Record<KitRole, KitRole>>;
  /** True when notes come from the standard layout rather than the rack (nested Drum Racks, Impulse). */
  notesAssumed: boolean;
  /** Melodic: what it sounds like, from names first and the envelope second. */
  tags: SoundTag[];
  envelope: Envelope;
  /** One line for the web page and the decision model. */
  summary: string;
  /** What a Session Player set to Auto plays with this instrument. */
  suggestedRole: Instrument;
}

/**
 * Impulse's eight slots answer C3 to C4 (white keys). Their sounds can't be
 * read, so they're taken in the usual order: kick, snare, clap, hats, toms.
 */
const IMPULSE_SLOTS: DrumSound[] = [
  { note: 60, name: "Slot 1", role: "kick" },
  { note: 62, name: "Slot 2", role: "snare" },
  { note: 64, name: "Slot 3", role: "clap" },
  { note: 65, name: "Slot 4", role: "closed-hat" },
  { note: 67, name: "Slot 5", role: "open-hat" },
  { note: 69, name: "Slot 6", role: "tom" },
  { note: 71, name: "Slot 7", role: "tom" },
  { note: 72, name: "Slot 8", role: "perc" },
];

/** General MIDI drum notes, which Live's kits mostly follow (C1 = kick). */
export const STANDARD_KIT: Kit = {
  kick: 36,
  snare: 38,
  clap: 39,
  rim: 37,
  "closed-hat": 42,
  "open-hat": 46,
  ride: 51,
  crash: 49,
  "tom-low": 45,
  "tom-mid": 47,
  "tom-high": 50,
  shaker: 70,
  perc: 63,
};

const GM_ROLES: Record<number, DrumRole> = {
  35: "kick",
  36: "kick",
  37: "rim",
  38: "snare",
  39: "clap",
  40: "snare",
  41: "tom",
  42: "closed-hat",
  43: "tom",
  44: "closed-hat",
  45: "tom",
  46: "open-hat",
  47: "tom",
  48: "tom",
  49: "crash",
  50: "tom",
  51: "ride",
  52: "crash",
  53: "ride",
  54: "tambourine",
  55: "crash",
  56: "cowbell",
  57: "crash",
  59: "ride",
  60: "conga",
  61: "conga",
  62: "conga",
  63: "conga",
  64: "conga",
  69: "shaker",
  70: "shaker",
  75: "perc",
  76: "perc",
  77: "perc",
};

// First match wins, so open hats come before hats in general.
const DRUM_WORDS: [DrumRole, RegExp][] = [
  ["open-hat", /\b(open|opn|ohh?)\b|\bhat\w* open|\bhh ?o\b/],
  ["closed-hat", /hi ?hat|\bhh\b|\bhats?\b|\bchh?\b|\bclosed\b|\bpedal\b/],
  ["kick", /kick|\bbd\b|bass ?drum|\bki?ck\b|\bkik\b/],
  ["snare", /snare|\bsd\b|\bsnr\b|\bsn\b/],
  ["clap", /clap|\bcp\b|\bclp\b|snap/],
  ["rim", /\brim|stick|\brs\b/],
  ["ride", /\bride\b/],
  ["crash", /crash|cymbal|\bcym\b|splash|china/],
  ["tom", /\btoms?\b|\btm\b/],
  ["shaker", /shak|maraca|cabasa|\begg\b/],
  ["tambourine", /tamb/],
  ["cowbell", /cow ?bell|\bcb\b/],
  ["conga", /conga|bongo|timbal|djembe|tabla/],
  ["perc", /perc|clave|wood|block|agogo|triangle|guiro|\btick\b|\bclick\b/],
  ["fx", /\bfx\b|noise|sweep|riser|\bzap\b|\bvox\b|vocal|chant|impact/],
];

const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/\.(wav|aif+|mp3|flac|ogg)$/, "")
    .replace(/[_\-.()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A pad's role from its name, else from General MIDI by its note. */
export const drumRole = (name: string, note: number): DrumRole => {
  const text = normalize(name);
  for (const [role, pattern] of DRUM_WORDS) if (pattern.test(text)) return role;
  return GM_ROLES[note] ?? "other";
};

/** Where a pattern sound goes when the kit doesn't have it, in order of preference. */
const STAND_INS: Record<KitRole, DrumRole[]> = {
  kick: ["kick", "tom", "conga"],
  snare: ["snare", "clap", "rim"],
  clap: ["clap", "snare", "rim"],
  rim: ["rim", "snare", "clap", "perc"],
  "closed-hat": ["closed-hat", "shaker", "tambourine", "ride", "open-hat", "perc"],
  "open-hat": ["open-hat", "closed-hat", "ride", "crash"],
  ride: ["ride", "closed-hat", "open-hat"],
  crash: ["crash", "ride", "open-hat"],
  "tom-low": ["tom", "conga", "perc", "snare"],
  "tom-mid": ["tom", "conga", "perc", "snare"],
  "tom-high": ["tom", "conga", "perc", "snare"],
  shaker: ["shaker", "tambourine", "closed-hat"],
  perc: ["perc", "conga", "cowbell", "rim", "closed-hat"],
};

const ROLE_OF_KIT: Record<KitRole, DrumRole> = {
  kick: "kick",
  snare: "snare",
  clap: "clap",
  rim: "rim",
  "closed-hat": "closed-hat",
  "open-hat": "open-hat",
  ride: "ride",
  crash: "crash",
  "tom-low": "tom",
  "tom-mid": "tom",
  "tom-high": "tom",
  shaker: "shaker",
  perc: "perc",
};

/** Resolves every pattern sound to a note in the kit, using stand-ins for missing ones. */
export const buildKit = (sounds: DrumSound[]) => {
  const kit = { ...STANDARD_KIT };
  const substituted: Partial<Record<KitRole, KitRole>> = {};
  if (!sounds.length) return { kit, substituted };
  const byRole = (role: DrumRole) => sounds.filter((sound) => sound.role === role).sort((a, b) => a.note - b.note);
  const toms = byRole("tom");
  for (const kitRole of kitRoles) {
    let found = false;
    for (const role of STAND_INS[kitRole]) {
      const candidates = byRole(role);
      if (!candidates.length) continue;
      found = true;
      // Toms spread low to high over whatever toms there are.
      let sound = candidates[0];
      if (role === "tom" && toms.length) {
        const index = kitRole === "tom-low" ? 0 : kitRole === "tom-mid" ? Math.floor((toms.length - 1) / 2) : toms.length - 1;
        sound = toms[index];
      }
      kit[kitRole] = sound.note;
      if (role !== ROLE_OF_KIT[kitRole]) substituted[kitRole] = kitRoleFor(role);
      break;
    }
    // No kick or anything like one: the lowest sound carries the kick.
    // Other missing sounds stay on the standard note, which may simply be silent.
    if (!found && kitRole === "kick") kit.kick = Math.min(...sounds.map((sound) => sound.note));
  }
  return { kit, substituted };
};

const kitRoleFor = (role: DrumRole): KitRole => (role === "tom" ? "tom-mid" : (kitRoles as readonly string[]).includes(role) ? (role as KitRole) : "perc");

// Melodic sound words, checked against preset, rack, chain and sample names.
const SOUND_WORDS: [SoundTag, RegExp][] = [
  ["bass", /\bbass|\bsub\b|\b808\b|reese/],
  ["pad", /\bpad|atmos|ambien|drone|swell|texture|warm|choir/],
  ["pluck", /pluck|pizz|harp|kalimba|\bstab/],
  ["electric piano", /rhodes|wurli|\bep\b|electric piano|e piano|epiano/],
  ["piano", /piano|grand|upright|\bkeys\b/],
  ["organ", /organ|hammond|\bb3\b|church/],
  ["bell", /bell|glock|celest|vibra|chime|music box/],
  ["mallet", /marimba|xylo|mallet/],
  ["lead", /\blead|\bsolo\b|\bmono\b|\bsaw lead/],
  ["strings", /string|violin|viola|cello|ensemble|orchestra/],
  ["brass", /brass|horn|trumpet|trombone|\bsax/],
  ["guitar", /guitar|\bgtr\b|nylon|steel string|acoustic g/],
];

/** Native instruments' character when their names don't say. */
const CLASS_TAGS: Record<string, SoundTag[]> = {
  LoungeLizard: ["electric piano"],
  StringStudio: ["guitar"],
  Collision: ["mallet"],
  Operator: ["synth"],
  UltraAnalog: ["synth"],
  InstrumentVector: ["synth"],
  Drift: ["synth"],
};

const ENVELOPE_PARAM = /^(amp|aeg1|ae|ve|env ?1)\b.*\b(attack|decay|sustain|rel(ease)?)$/i;

export const isEnvelopeParam = (name: string) => ENVELOPE_PARAM.test(name.trim());

/**
 * Reads the amp envelope, whatever its units: times in milliseconds when the
 * range is that large, else as a position within the range. Approximate, so
 * name keywords always win over it.
 */
export const readEnvelope = (params: RawInstrument["envelope"] = []): Envelope => {
  const find = (stage: RegExp) => params.find((param) => stage.test(param.name));
  const position = (param: { value: number; min: number; max: number }) =>
    param.max > param.min ? (param.value - param.min) / (param.max - param.min) : 0;
  const isSlow = (param: { value: number; min: number; max: number }, ms: number, share: number) =>
    param.max >= 1000 ? param.value >= ms : position(param) >= share;

  const attack = find(/attack$/i);
  const decay = find(/decay$/i);
  const sustain = find(/sustain$/i);
  const release = find(/rel(ease)?$/i);
  const envelope: Envelope = {};
  if (attack) envelope.attack = isSlow(attack, 80, 0.3) ? "slow" : "fast";
  if (release) envelope.release = isSlow(release, 600, 0.5) ? "long" : "short";
  if (sustain && decay) envelope.plucky = position(sustain) < 0.2 && !isSlow(decay, 800, 0.5);
  return envelope;
};

/** Every instrument in a rack, depth first. */
const flatten = (raw: RawInstrument): RawInstrument[] => [
  raw,
  ...(raw.chains ?? []).flatMap((chain) => chain.instruments.flatMap(flatten)),
];

const names = (raw: RawInstrument): string[] => [
  raw.name,
  ...(raw.samples ?? []),
  ...(raw.chains ?? []).flatMap((chain) => [chain.name, ...chain.instruments.flatMap(names)]),
];

const ROLE_LABELS: Partial<Record<DrumRole, string>> = {
  "closed-hat": "closed hat",
  "open-hat": "open hat",
};

const listSounds = (sounds: DrumSound[], withNotes: boolean) => {
  const shown = sounds.slice(0, 16).map((sound) => {
    const label = ROLE_LABELS[sound.role] ?? sound.role;
    const note = withNotes ? ` ${liveNoteName(sound.note)}` : "";
    return sound.role === "other" ? `"${sound.name}"${note}` : `${label} "${sound.name}"${note}`;
  });
  const more = sounds.length > 16 ? `, and ${sounds.length - 16} more` : "";
  return shown.join(", ") + more;
};

const title = (raw: RawInstrument) => (raw.name && raw.name !== raw.displayName ? `${raw.displayName} "${raw.name}"` : raw.displayName);

/** Turns what was read from Live into what the player and the decision model use. */
export const profileInstrument = (raw: RawInstrument): InstrumentProfile => {
  const all = flatten(raw);
  const drumRack = all.find((device) => device.className === "DrumGroupDevice");
  const impulse = all.find((device) => device.className === "InstrumentImpulse");

  if (drumRack || impulse) {
    let sounds: DrumSound[] = [];
    let notesAssumed = false;
    if (!drumRack && impulse) {
      const { kit, substituted } = buildKit(IMPULSE_SLOTS);
      return {
        deviceId: raw.id,
        name: raw.name,
        displayName: raw.displayName,
        kind: "drums",
        sounds: IMPULSE_SLOTS,
        kit,
        substituted,
        notesAssumed: false,
        tags: [],
        envelope: {},
        summary: `${title(raw)}: 8 slots on C3–C4 whose sounds can't be read; taken as kick, snare, clap, closed hat, open hat, two toms and percussion`,
        suggestedRole: "drums",
      };
    }
    if (drumRack?.pads?.length) {
      sounds = drumRack.pads.map((pad) => ({ ...pad, role: drumRole(pad.name, pad.note) }));
    } else if (drumRack?.drumChains?.length) {
      // No notes for a nested Drum Rack's chains in Live 11: name the sounds,
      // and play them where the standard layout puts their role.
      notesAssumed = true;
      sounds = drumRack.drumChains.map((name) => {
        const role = drumRole(name, -1);
        const note = role === "tom" ? STANDARD_KIT["tom-mid"] : (STANDARD_KIT as Record<string, number>)[role] ?? STANDARD_KIT.perc;
        return { note, name, role };
      });
    } else {
      notesAssumed = true;
    }
    const { kit, substituted } = buildKit(sounds);
    const where = notesAssumed ? " (notes assumed: standard layout)" : "";
    const inventory = sounds.length ? `: ${listSounds(sounds, !notesAssumed)}` : "";
    return {
      deviceId: raw.id,
      name: raw.name,
      displayName: raw.displayName,
      kind: "drums",
      sounds,
      kit,
      substituted,
      notesAssumed,
      tags: [],
      envelope: {},
      summary: `${title(raw)}${inventory}${where}`,
      suggestedRole: "drums",
    };
  }

  const text = normalize(names(raw).join(" "));
  const tags = new Set<SoundTag>();
  for (const [tag, pattern] of SOUND_WORDS) if (pattern.test(text)) tags.add(tag);
  if (!tags.size) all.forEach((device) => CLASS_TAGS[device.className]?.forEach((tag) => tags.add(tag)));
  const envelope = readEnvelope(all.find((device) => device.envelope?.length)?.envelope);
  if (!tags.has("pad") && envelope.attack === "slow" && envelope.release === "long") tags.add("pad");
  if (!tags.has("pluck") && envelope.plucky && !tags.has("piano") && !tags.has("electric piano")) tags.add("pluck");

  const sample = all.flatMap((device) => device.samples ?? [])[0];
  const feel = [
    envelope.attack === "slow" && "slow attack",
    envelope.release === "long" && "long release",
    envelope.plucky && "dies away quickly",
  ].filter(Boolean);
  const describedTags = [...tags].filter((tag) => tag !== "synth");
  const what = describedTags.length ? describedTags.join(", ") : tags.has("synth") ? "synth" : "sound unknown";
  const details = [feel.length ? `${feel.join(", ")} (from its envelope)` : "", sample ? `sample "${sample}"` : ""].filter(Boolean);

  const suggestedRole: Instrument = tags.has("bass") ? "bass" : tags.has("guitar") ? "guitar" : "keys";
  return {
    deviceId: raw.id,
    name: raw.name,
    displayName: raw.displayName,
    kind: "melodic",
    sounds: [],
    kit: { ...STANDARD_KIT },
    substituted: {},
    notesAssumed: false,
    tags: [...tags],
    envelope,
    summary: `${title(raw)}: ${what}${details.length ? `; ${details.join("; ")}` : ""}`,
    suggestedRole,
  };
};

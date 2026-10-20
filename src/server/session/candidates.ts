/**
 * Concrete bars for the decision model to choose from. Each candidate is a
 * recipe (a pattern, a variation of it, an energy) rendered into the notes it
 * would play over the coming chords, and described in a few words: what it
 * plays, then facts worked out here about how it sits with the band (how many
 * hits land with the bass, how busy it is next to the band, how much it
 * changes from the last bar). Jev picks well among such descriptions, but not
 * among bare note positions: it doesn't count.
 */
import { Instrument } from "common";
import { PartFeatures } from "./analyze";
import { Kit, KitRole } from "./instrument";
import { ChordInfo, ClipNote, clamp, fitNotes, hashString, liveNoteName, seededRandom } from "./music";
import { Option } from "./patterns";

export type Variant =
  | "base"
  /** Drums: kick on the bass's notes. Melodic: the rhythm of the part it locks with. */
  | "lock"
  /** Drums: ghost snares around the backbeats. */
  | "ghosts"
  /** Drums: hats on the beats only. */
  | "thin"
  /** Drums: sixteenth-note hats. */
  | "busy"
  /** Drums: an open hat on the last off-beat. */
  | "open"
  /** Melodic: only the notes on beats 1 and 3. */
  | "sparse"
  /** Melodic: notes on 2 and 4 pushed to the off-beat before. */
  | "syncopate"
  | "octave-up"
  | "octave-down"
  | "short"
  | "held"
  /** Chords: only where the melody rests, answering it. */
  | "answer";

/** What a candidate is made from; the same recipe plays the same notes on the same chords. */
export interface Recipe {
  pattern: string;
  variant: Variant;
  energy: number;
}

/**
 * How a bar ends: plainly, with a fill, a big (louder) fill, a stop (only
 * beat 1 of the last bar, then silence), or nothing but a pickup fill (the
 * end of a break).
 */
export type Ending = "none" | "fill" | "big-fill" | "stop" | "pickup";

export interface Candidate extends Recipe {
  id: string;
  /** Ends with a fill. */
  fill: boolean;
  ending: Ending;
  /** For the whole clip, in beats from its start. */
  notes: ClipNote[];
  description: string;
}

export interface BarContext {
  instrument: Instrument;
  /** The patterns on offer, described for the loaded instrument. */
  options: Option[];
  /** Chord for each bar of the clip. */
  chords: ChordInfo[];
  nextChord?: ChordInfo;
  beatsPerBar: number;
  beatLength: number;
  /** The energy to aim for, 1–10. */
  energy: number;
  /**
   * "offer": plain and fill versions of the leading candidates both; anything
   * else: every candidate ends that way (the band plan's ending).
   */
  ending: "offer" | Exclude<Ending, "pickup">;
  /** The band plan rests the players here: offer the rest, and pickups if it ends with a fill. */
  rest?: boolean;
  /** The bar before ended with a fill: open with an accent. */
  accent: boolean;
  kit: Kit;
  /** Keeps renderings apart from other players'. */
  trackId: number;
  /** What the player played last. */
  previous?: Recipe;
  /** The band's latest bar. */
  band: PartFeatures[];
  /** Most candidates offered. */
  max: number;
}

const DRUM_VARIANTS: Variant[] = ["lock", "ghosts", "thin", "busy", "open"];
const BASS_VARIANTS: Variant[] = ["lock", "sparse", "syncopate", "octave-up", "short", "held"];
const CHORD_VARIANTS: Variant[] = ["lock", "answer", "sparse", "syncopate", "octave-up", "octave-down", "short", "held"];
/** How many of the leading candidates also come as a fill when fills are offered. */
const FILL_OFFERS = 6;
const GHOST_VELOCITY = 34;

/** The 16 steps of a bar's grid ("x" where a note starts), as positions in beats. */
const gridPositions = (grid: string | undefined, beatsPerBar: number) =>
  [...(grid ?? "")].flatMap((c, i) => (c === "x" ? [(i * beatsPerBar) / 16] : []));

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/** "1", "2&", "3e", "4a": where in the bar a note starts. */
const countOf = (position: number, beatLength: number) => {
  const beat = Math.floor(position / beatLength + 1e-6);
  const sub = Math.round(((position - beat * beatLength) / beatLength) * 4);
  return `${beat + 1}${["", "e", "&", "a"][sub] ?? ""}`;
};

const listCounts = (positions: number[], beatLength: number) => [...new Set(positions.map((p) => countOf(p, beatLength)))].join(", ");

const sameRecipe = (a?: Recipe, b?: Recipe) => !!a && !!b && a.pattern === b.pattern && a.variant === b.variant && a.energy === b.energy;

const ENDING_SUFFIX: Record<Ending, string> = { none: "", fill: "+fill", "big-fill": "+big-fill", stop: "+stop", pickup: "+pickup" };

const recipeId = ({ pattern, variant, energy }: Recipe, target: number, ending: Ending) =>
  pattern === "rest" ? "rest" : `${pattern}${variant === "base" ? "" : `~${variant}`}${energy === target ? "" : `@${energy}`}${ENDING_SUFFIX[ending]}`;

/** The drum sound each note plays, from the kit (a sound standing in for another plays the first role it has). */
const roleOf = (kit: Kit) => {
  const order: KitRole[] = ["kick", "snare", "clap", "rim", "closed-hat", "open-hat", "ride", "crash", "tom-low", "tom-mid", "tom-high", "shaker", "perc"];
  const roles = new Map<number, KitRole>();
  for (const role of order) if (!roles.has(kit[role])) roles.set(kit[role], role);
  return (pitch: number) => roles.get(pitch);
};

const byBar = (notes: ClipNote[], beatsPerBar: number, bars: number, transform: (bar: ClipNote[], start: number) => ClipNote[]) =>
  Array.from({ length: bars }, (_, i) => {
    const start = i * beatsPerBar;
    const inBar = notes.filter((n) => n.start >= start - 1e-6 && n.start < start + beatsPerBar - 1e-6);
    return transform(inBar, start);
  }).flat();

/** Applies a variation; undefined when it doesn't apply or changes nothing. */
const vary = (variant: Variant, notes: ClipNote[], context: BarContext): ClipNote[] | undefined => {
  const { beatsPerBar, beatLength, kit } = context;
  const bars = context.chords.length;
  const role = roleOf(kit);
  const part = (name: PartFeatures["role"]) => context.band.find((p) => p.role === name);
  const isHat = (pitch: number) => role(pitch) === "closed-hat" || role(pitch) === "open-hat";
  if (context.instrument === "drums") {
    switch (variant) {
      case "lock": {
        const bass = gridPositions(part("bass")?.grid, beatsPerBar);
        if (!bass.length) return undefined;
        const loud = Math.max(...notes.filter((n) => n.pitch === kit.kick).map((n) => n.velocity), 90);
        return byBar(notes, beatsPerBar, bars, (bar, start) => [
          ...bar.filter((n) => n.pitch !== kit.kick),
          ...bass.map((p) => ({ pitch: kit.kick, start: start + p, duration: 0.1, velocity: loud })),
        ]);
      }
      case "ghosts":
        return byBar(notes, beatsPerBar, bars, (bar, start) => {
          const taken = new Set(bar.filter((n) => n.pitch === kit.snare).map((n) => Math.round((n.start - start) * 4)));
          const steps = [1.25, 1.75, 3.25, 3.75].map((b) => b * beatLength).filter((p) => p < beatsPerBar);
          const ghosts = steps.filter((p) => !taken.has(Math.round(p * 4))).map((p) => ({ pitch: kit.snare, start: start + p, duration: 0.1, velocity: GHOST_VELOCITY }));
          return [...bar, ...ghosts];
        });
      case "thin": {
        const kept = notes.filter((n) => !isHat(n.pitch) || near((n.start / beatLength) % 1, 0) || near((n.start / beatLength) % 1, 1));
        return kept.length < notes.length && kept.some(isHatNote(isHat)) ? kept : undefined;
      }
      case "busy": {
        const hats = notes.filter((n) => isHat(n.pitch));
        if (!hats.length) return undefined;
        const velocity = Math.round(hats.reduce((sum, n) => sum + n.velocity, 0) / hats.length);
        const at = new Set(hats.map((n) => Math.round(n.start * 4)));
        const extra = Array.from({ length: bars * beatsPerBar * 4 }, (_, i) => i / 4)
          .filter((p) => !at.has(Math.round(p * 4)))
          .map((p) => ({ pitch: kit["closed-hat"], start: p, duration: 0.1, velocity: Math.max(velocity - 15, 20) }));
        return extra.length ? [...notes, ...extra] : undefined;
      }
      case "open":
        return byBar(notes, beatsPerBar, bars, (bar, start) => {
          const at = start + beatsPerBar - beatLength / 2;
          return [...bar.filter((n) => !(isHat(n.pitch) && near(n.start, at))), { pitch: kit["open-hat"], start: at, duration: beatLength / 2, velocity: 88 }];
        });
      default:
        return undefined;
    }
  }

  const range = context.instrument === "bass" ? [28, 60] : [45, 88];
  const inRange = (shifted: ClipNote[]) => shifted.every((n) => n.pitch >= range[0] && n.pitch <= range[1]);
  switch (variant) {
    case "lock": {
      // Bass locks with the drums (or the chords), chords with the bass.
      const partner = context.instrument === "bass" ? (part("drums") ?? part("chords")) : part("bass");
      const positions = gridPositions(partner?.grid, beatsPerBar);
      if (!positions.length || !notes.length) return undefined;
      return byBar(notes, beatsPerBar, bars, (bar, start) => {
        if (!bar.length) return [];
        // The bar's notes grouped into what's struck together, then replayed on the partner's rhythm.
        const groups = [...new Set(bar.map((n) => n.start))].map((s) => bar.filter((n) => near(n.start, s)));
        return positions.flatMap((p, i) => {
          const next = positions[i + 1] ?? beatsPerBar;
          return groups[i % groups.length].map((n) => ({ ...n, start: start + p, duration: Math.max(next - p - 0.05, 0.1) }));
        });
      });
    }
    case "answer": {
      if (context.instrument === "bass") return undefined;
      const melody = gridPositions(part("melody")?.grid, beatsPerBar);
      if (!melody.length) return undefined;
      const kept = notes.filter((n) => !melody.some((p) => Math.abs(((n.start % beatsPerBar) + beatsPerBar) % beatsPerBar - p) <= beatsPerBar / 16 + 1e-6));
      return kept.length && kept.length < notes.length ? kept : undefined;
    }
    case "sparse": {
      const kept = notes.filter((n) => near((n.start % (2 * beatLength)) / (2 * beatLength), 0) || near((n.start % (2 * beatLength)) / (2 * beatLength), 1));
      return kept.length && kept.length < notes.length ? kept : undefined;
    }
    case "syncopate": {
      const onTwoOrFour = (n: ClipNote) => {
        const beat = (n.start % beatsPerBar) / beatLength;
        return near(beat, 1) || near(beat, 3);
      };
      const moved = notes.filter(onTwoOrFour).map((n) => ({ ...n, start: n.start - beatLength / 2, duration: n.duration + beatLength / 2 }));
      if (!moved.length) return undefined;
      // A pushed note replaces what was on that off-beat.
      const kept = notes.filter((n) => !onTwoOrFour(n) && !moved.some((m) => near(m.start, n.start)));
      return [...kept, ...moved];
    }
    case "octave-up":
    case "octave-down": {
      const shifted = notes.map((n) => ({ ...n, pitch: n.pitch + (variant === "octave-up" ? 12 : -12) }));
      return notes.length && inRange(shifted) ? shifted : undefined;
    }
    case "short": {
      const shortened = notes.map((n) => ({ ...n, duration: Math.min(n.duration, beatLength / 4) }));
      const cut = shortened.reduce((sum, n, i) => sum + notes[i].duration - n.duration, 0) / Math.max(notes.length, 1);
      return cut >= 0.15 * beatLength ? shortened : undefined;
    }
    case "held": {
      const starts = [...new Set(notes.map((n) => n.start))].sort((a, b) => a - b);
      const length = bars * beatsPerBar;
      const held = notes.map((n) => ({ ...n, duration: Math.max(n.duration, (starts.find((s) => s > n.start + 1e-6) ?? length) - n.start - 0.02) }));
      const added = held.reduce((sum, n, i) => sum + n.duration - notes[i].duration, 0) / Math.max(notes.length, 1);
      return added >= 0.2 * beatLength ? held : undefined;
    }
    default:
      return undefined;
  }
};

const isHatNote = (isHat: (pitch: number) => boolean) => (n: ClipNote) => isHat(n.pitch);

/**
 * The notes a recipe plays in this context with this ending, or undefined
 * when its variation doesn't apply. Fills are spliced in after the
 * variation, so a variation never erases one.
 */
export const renderRecipe = (recipe: Recipe, context: BarContext, ending: Ending): ClipNote[] | undefined => {
  const option = context.options.find((o) => o.id === recipe.pattern);
  if (!option) return undefined;
  const length = context.chords.length * context.beatsPerBar;
  const render = (withFill: boolean, energy = recipe.energy) =>
    option.render({
      chords: context.chords,
      nextChord: context.nextChord,
      beatsPerBar: context.beatsPerBar,
      beatLength: context.beatLength,
      energy,
      fill: withFill,
      accent: context.accent,
      kit: context.kit,
      random: seededRandom(hashString(`${context.trackId}:${recipe.pattern}:${energy}`)),
    });
  const plain = render(false);
  const varied = recipe.variant === "base" ? plain : vary(recipe.variant, plain, context);
  if (!varied) return undefined;
  const fillStart = length - context.beatLength;
  const lastBar = length - context.beatsPerBar;
  switch (ending) {
    case "none":
      return fitNotes(varied, length);
    case "stop":
      // Everyone hits beat 1 of the last bar, then silence.
      return fitNotes(
        varied
          .filter((n) => n.start < lastBar - 1e-6 || near(n.start, lastBar))
          .map((n) => (near(n.start, lastBar) ? { ...n, duration: Math.min(n.duration, context.beatLength / 2), velocity: Math.min(127, n.velocity + 10) } : n)),
        length
      );
    default: {
      const big = ending === "big-fill";
      const filled = render(true, big ? Math.min(recipe.energy + 2, 10) : recipe.energy).filter((n) => n.start >= fillStart - (big ? context.beatLength : 0) - 1e-6);
      // A big fill takes the last two beats; a pickup is the fill alone.
      const before = ending === "pickup" ? [] : varied.filter((n) => n.start < fillStart - (big ? context.beatLength : 0) - 1e-6);
      return fitNotes([...before, ...filled], length);
    }
  }
};

/** Notes off the sixteenth grid: a swung or triplet feel. */
const swung = (notes: ClipNote[], beatLength: number) =>
  notes.some((n) => {
    const sixteenths = (n.start / beatLength) * 4;
    return Math.abs(sixteenths - Math.round(sixteenths)) > 0.15;
  });

/** What a drum bar plays, in a few words: "Kick 1, 2&, 3; snare 2, 4 + 2 ghosts; 8th hats". */
const describeDrums = (notes: ClipNote[], context: BarContext) => {
  const { beatsPerBar, beatLength } = context;
  const role = roleOf(context.kit);
  const bar = notes.filter((n) => n.start < beatsPerBar - 1e-6);
  const feel = swung(bar, beatLength) ? "Swung: " : "";
  const at = (roles: KitRole[], loud = 0) => bar.filter((n) => roles.includes(role(n.pitch)!) && n.velocity >= loud).map((n) => n.start);
  const parts: string[] = [];
  const kick = at(["kick"]);
  if (kick.length) parts.push(`kick ${listCounts(kick, beatLength)}`);
  const snare = at(["snare", "clap", "rim"], GHOST_VELOCITY + 6);
  const ghosts = at(["snare", "clap", "rim"]).length - snare.length;
  if (snare.length || ghosts) parts.push(`snare ${listCounts(snare, beatLength) || "–"}${ghosts ? ` + ${ghosts} ghost${ghosts > 1 ? "s" : ""}` : ""}`);
  const hats = at(["closed-hat", "ride"]);
  const steps = beatsPerBar * 4;
  if (hats.length >= steps - 1) parts.push("16th hats");
  else if (hats.length >= steps / 2 - 1) parts.push("8th hats");
  else if (hats.length >= beatsPerBar / beatLength - 1 && hats.length <= beatsPerBar / beatLength) parts.push("hats on the beats");
  else if (hats.length) parts.push(`hats ${listCounts(hats, beatLength)}`);
  const open = at(["open-hat"]);
  if (open.length) parts.push(`open hat ${listCounts(open, beatLength)}`);
  const toms = at(["tom-low", "tom-mid", "tom-high"]);
  if (toms.length) parts.push(`toms ${listCounts(toms, beatLength)}`);
  const perc = at(["shaker", "perc"]);
  if (perc.length) parts.push(`${perc.length} percussion hits`);
  if (at(["crash"]).length) parts.push("crash");
  return parts.length ? `${feel}${parts.join("; ")}.` : "Rests.";
};

/** What a melodic bar plays: "A1 1, E2 2&, A1 3 (short)" or "C3–E4 chord on 1, 3 (held)". */
const describeMelodic = (notes: ClipNote[], context: BarContext) => {
  const { beatsPerBar, beatLength } = context;
  const bar = notes.filter((n) => n.start < beatsPerBar - 1e-6);
  if (!bar.length) return "Rests.";
  const starts = [...new Set(bar.map((n) => n.start))].sort((a, b) => a - b);
  const average = bar.reduce((sum, n) => sum + n.duration, 0) / bar.length;
  const feel = average <= beatLength / 3 ? "short" : average >= beatLength * 1.5 ? "held" : "medium length";
  const chordal = starts.some((s) => bar.filter((n) => near(n.start, s)).length >= 2);
  const swing = swung(bar, beatLength) ? ", swung" : "";
  if (chordal) {
    const low = Math.min(...bar.map((n) => n.pitch));
    const high = Math.max(...bar.map((n) => n.pitch));
    return `Chords (${liveNoteName(low)}–${liveNoteName(high)}) on ${listCounts(starts, beatLength)}, ${feel}${swing}.`;
  }
  const line = starts.slice(0, 8).map((s) => `${liveNoteName(bar.find((n) => near(n.start, s))!.pitch)} ${countOf(s, beatLength)}`);
  return `${line.join(", ")}${starts.length > 8 ? ", …" : ""}, ${feel}${swing}.`;
};

/** Where in the bar notes start, to compare with the band (16 steps). */
const stepsOf = (notes: ClipNote[], beatsPerBar: number, pick: (n: ClipNote) => boolean = () => true) =>
  new Set(notes.filter((n) => n.start < beatsPerBar - 1e-6 && pick(n)).map((n) => Math.round((n.start / beatsPerBar) * 16)));

/** What each variation is for, said first so options made from the same pattern read apart. */
const PURPOSE: Partial<Record<Variant, string>> = {
  lock: "Locked to the band",
  ghosts: "With ghost notes",
  thin: "Lighter",
  busy: "Busier",
  open: "Opens up at the end",
  sparse: "Sparser",
  syncopate: "Syncopated",
  "octave-up": "An octave up",
  "octave-down": "An octave down",
  short: "Short notes",
  held: "Held notes",
  answer: "Answers the melody",
};

const purposeOf = (candidate: Candidate, target: number) => {
  const parts = [PURPOSE[candidate.variant]];
  if (candidate.pattern !== "rest" && candidate.energy > target) parts.push("a notch harder");
  if (candidate.pattern !== "rest" && candidate.energy < target) parts.push("a notch softer");
  const purpose = parts.filter(Boolean).join(", ");
  return purpose ? `${purpose.charAt(0).toUpperCase()}${purpose.slice(1)}: ` : "";
};

/** Facts about how a bar sits with the band, worked out here so the decision model only has to read. */
const describeFit = (candidate: Candidate, context: BarContext, previousNotes?: ClipNote[]) => {
  const { beatsPerBar, kit } = context;
  if (candidate.pattern === "rest") return "Drops out for now";
  const facts: string[] = [`Energy ${candidate.energy}`];
  const part = (name: PartFeatures["role"]) => context.band.find((p) => p.role === name);
  const gridSteps = (p?: PartFeatures) => new Set([...(p?.grid ?? "")].flatMap((c, i) => (c === "x" ? [i] : [])));
  const lockWith = context.instrument === "bass" ? (part("drums") ?? part("chords")) : part("bass");
  const partner = gridSteps(lockWith);
  if (partner.size && candidate.notes.length) {
    const mine = stepsOf(candidate.notes, beatsPerBar, context.instrument === "drums" ? (n) => n.pitch === kit.kick : undefined);
    const shared = [...partner].filter((s) => mine.has(s)).length;
    const what = context.instrument === "drums" ? "kick lands" : "notes land";
    facts.push(`${what} with ${shared} of the ${partner.size} ${lockWith!.trackName} notes${shared === partner.size ? " (locked)" : ""}`);
  }
  const melody = gridSteps(part("melody"));
  if (melody.size && context.instrument !== "drums" && context.instrument !== "bass" && candidate.notes.length) {
    const mine = stepsOf(candidate.notes, beatsPerBar);
    const inRests = [...mine].filter((s) => !melody.has(s)).length;
    facts.push(`${inRests} of its ${mine.size} hit${mine.size === 1 ? "" : "s"} in the melody's rests`);
  }
  const onsets = stepsOf(candidate.notes, beatsPerBar).size;
  const parts = context.band.filter((p) => p.onsets);
  if (parts.length) {
    const typical = parts.reduce((sum, p) => sum + new Set(gridSteps(p)).size, 0) / parts.length;
    facts.push(onsets > typical * 1.4 ? "busier than the band" : onsets < typical * 0.6 ? "sparser than the band" : "about as busy as the band");
  }
  if (previousNotes) {
    // Drums by sound; melodic parts by note and how long it's held.
    const key = (n: ClipNote) =>
      `${Math.round((n.start / beatsPerBar) * 16)}:${n.pitch}${context.instrument === "drums" ? "" : `:${Math.round(n.duration * 4)}`}`;
    const mine = new Set(candidate.notes.filter((n) => n.start < beatsPerBar - 1e-6).map(key));
    const theirs = new Set(previousNotes.filter((n) => n.start < beatsPerBar - 1e-6).map(key));
    const changed = [...mine].filter((k) => !theirs.has(k)).length + [...theirs].filter((k) => !mine.has(k)).length;
    facts.push(changed === 0 ? "same as your last bar" : changed <= 6 ? `${changed} notes differ from your last bar` : "new part");
    if (changed) {
      const before = stepsOf(previousNotes, beatsPerBar).size;
      facts.push(onsets > before * 1.25 ? "busier than your last bar" : onsets < before * 0.8 ? "lighter than your last bar" : "as busy as your last bar");
    }
  }
  const endings: Record<Ending, string> = {
    none: "",
    fill: "ends with a fill",
    "big-fill": "ends with a big fill",
    stop: "stops after beat 1 of its last bar",
    pickup: "only a fill leading into the next phrase",
  };
  if (endings[candidate.ending]) facts.push(endings[candidate.ending]);
  return facts.join("; ");
};

/**
 * The bars to offer: what the player played last (on the new chords), every
 * pattern near the target energy, and variations of the leading ones (locked
 * to the band, thinned, syncopated...), a notch harder and softer, and with a
 * fill when fills are offered. Identical renderings are offered once.
 */
export const generateCandidates = (context: BarContext): Candidate[] => {
  const target = clamp(Math.round(context.energy), 1, 10);
  const distance = (o: Option) => (target < o.energy[0] ? o.energy[0] - target : target > o.energy[1] ? target - o.energy[1] : 0);
  const ranked = context.options.filter((o) => o.id !== "rest").sort((a, b) => distance(a) - distance(b) || b.fit - a.fit);
  const recipes: Recipe[] = [];
  const add = (recipe: Recipe) => {
    if (context.options.some((o) => o.id === recipe.pattern) && !recipes.some((r) => sameRecipe(r, recipe))) recipes.push(recipe);
  };
  if (context.previous) add(context.previous);
  ranked.filter((o) => distance(o) <= 2).forEach((o) => add({ pattern: o.id, variant: "base", energy: target }));
  const leaders = [...new Set([context.previous?.pattern, ranked[0]?.id, ranked[1]?.id].filter((id): id is string => !!id && id !== "rest"))];
  const variants = context.instrument === "drums" ? DRUM_VARIANTS : context.instrument === "bass" ? BASS_VARIANTS : CHORD_VARIANTS;
  for (const pattern of leaders) variants.forEach((variant) => add({ pattern, variant, energy: target }));
  for (const pattern of leaders.slice(0, 2)) {
    [target + 1, target - 1].filter((e) => e >= 1 && e <= 10).forEach((energy) => add({ pattern, variant: "base", energy }));
  }
  add({ pattern: "rest", variant: "base", energy: 1 });

  const previousNotes = context.previous && renderRecipe(context.previous, context, "none");
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const offer = (recipe: Recipe, ending: Ending) => {
    if (candidates.length >= context.max) return;
    const notes = renderRecipe(recipe, context, ending);
    if (!notes) return;
    const signature = JSON.stringify(notes.map((n) => [n.pitch, +n.start.toFixed(3), +n.duration.toFixed(2), Math.round(n.velocity / 8)]));
    if (seen.has(signature)) return;
    seen.add(signature);
    const fill = ending === "fill" || ending === "big-fill" || ending === "pickup";
    const candidate: Candidate = { ...recipe, id: recipeId(recipe, target, ending), fill, ending, notes, description: "" };
    const plays = context.instrument === "drums" ? describeDrums(notes, context) : describeMelodic(notes, context);
    candidate.description = `${purposeOf(candidate, target)}${plays} ${describeFit(candidate, context, previousNotes)}.`;
    candidates.push(candidate);
  };
  const playable = recipes.filter((r) => r.pattern !== "rest");
  const rest = recipes.find((r) => r.pattern === "rest");
  if (context.rest) {
    // A planned break: rest, or (where the break ends with a fill) a pickup into what follows.
    if (rest) offer(rest, "none");
    if (context.ending === "fill" || context.ending === "big-fill") playable.slice(0, FILL_OFFERS).forEach((recipe) => offer(recipe, "pickup"));
    return candidates;
  }
  const ending = context.ending === "offer" ? "none" : context.ending;
  for (const recipe of playable) offer(recipe, ending);
  if (context.ending === "offer") playable.slice(0, FILL_OFFERS).forEach((recipe) => offer(recipe, "fill"));
  if (rest) offer(rest, "none");
  return candidates;
};

/**
 * Picks among the decision model's top answers rather than always the top
 * one, for variety: options within `band` of the top probability, weighted
 * by it, with the one that keeps playing the same thing favoured. The same
 * seed picks the same.
 */
export const pickFromOdds = (probabilities: Record<string, number>, seed: number, options: { band: number; stickiness: number; sticky?: string }) => {
  const entries = Object.entries(probabilities).filter(([, p]) => Number.isFinite(p) && p > 0);
  if (!entries.length) return undefined;
  const top = Math.max(...entries.map(([, p]) => p));
  const pool = entries.filter(([, p]) => p >= top * options.band).map(([id, p]) => [id, id === options.sticky ? p * options.stickiness : p] as const);
  const total = pool.reduce((sum, [, w]) => sum + w, 0);
  let roll = seededRandom(seed)() * total;
  for (const [id, weight] of pool) {
    roll -= weight;
    if (roll <= 0) return id;
  }
  return pool[pool.length - 1][0];
};

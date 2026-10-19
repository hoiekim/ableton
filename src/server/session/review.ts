import { AuditionResult, PatternPreview, PatternReview, TransportState } from "common";
import { beatsPerBar } from "./clock";
import { STANDARD_KIT, kitRoles } from "./instrument";
import { ChordInfo, ClipNote, chordFromSymbol, clamp, compactNote, hashString, liveNoteName, seededRandom } from "./music";
import { ClipSlotInfo, LiveOps } from "./ops";
import { HOLD_DESCRIPTION, KIT_LABELS, Option } from "./patterns";
import { PatternSource, fitNotes } from "./player";

/** What the Patterns tab renders over unless it asks for other chords. */
export const SAMPLE_PROGRESSION = ["Am7", "Fmaj7", "C", "G"];

const MAX_CHORDS = 8;
const DEFAULT_ENERGY = 6;

export interface ReviewRequest {
  /** 1–10. */
  energy: number;
  fill: boolean;
  /** One bar each. */
  chords: ChordInfo[];
}

/** An audition that can't be done, with the HTTP status that says why. */
export class AuditionError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Reads `?energy=6&fill=1&chords=Am7,Fmaj7,C,G`, or says what's wrong with it. */
export const parseReviewRequest = (params: URLSearchParams): ReviewRequest | string => {
  const energyText = params.get("energy") || String(DEFAULT_ENERGY);
  const energy = Number(energyText);
  if (!Number.isFinite(energy)) return `Energy should be a number from 1 to 10, not "${energyText}"`;
  const fillText = params.get("fill") || "0";
  if (!["0", "1", "false", "true"].includes(fillText)) return `Fill should be 0 or 1, not "${fillText}"`;
  const symbols = (params.get("chords") ?? "").split(/[\s,]+/).filter(Boolean);
  if (symbols.length > MAX_CHORDS) return `At most ${MAX_CHORDS} chords`;
  const chords: ChordInfo[] = [];
  for (const symbol of symbols.length ? symbols : SAMPLE_PROGRESSION) {
    const chord = chordFromSymbol(symbol);
    if (!chord) return `Unknown chord "${symbol}"`;
    chords.push(chord);
  }
  return { energy: clamp(Math.round(energy), 1, 10), fill: fillText === "1" || fillText === "true", chords };
};

/**
 * A pattern's notes over the progression, rendered the way the player writes
 * them into a clip. The same request always gives the same notes, so an
 * audition plays what the page shows.
 */
export const renderOption = (option: Option, source: PatternSource, transport: TransportState, request: ReviewRequest): ClipNote[] => {
  const { chords, energy, fill } = request;
  const bpb = beatsPerBar(transport);
  const notes = option.render({
    chords,
    // The progression comes round again.
    nextChord: chords[0],
    beatsPerBar: bpb,
    beatLength: 4 / transport.signatureDenominator,
    energy,
    fill,
    accent: false,
    kit: source.profile?.kind === "drums" ? source.profile.kit : STANDARD_KIT,
    // Not seeded by the fill, so with and without one differ only in the fill.
    random: seededRandom(hashString(`${option.id}:${energy}`)),
  });
  return fitNotes(notes, chords.length * bpb);
};

/** What each drum note plays: the kit's pad there, and the pattern sounds sent to it (stand-ins included). */
const drumSounds = (source: PatternSource, pitches: number[]) => {
  const drums = source.profile?.kind === "drums" ? source.profile : undefined;
  const kit = drums?.kit ?? STANDARD_KIT;
  return [...new Set(pitches)]
    .sort((a, b) => a - b)
    .map((pitch) => {
      const roles = kitRoles.filter((role) => kit[role] === pitch).map((role) => KIT_LABELS[role]);
      const pad = drums?.sounds.find((sound) => sound.note === pitch);
      const name = pad?.name ?? (drums ? `${liveNoteName(pitch)} (no sound)` : roles.join(", ") || liveNoteName(pitch));
      return { pitch, name, note: liveNoteName(pitch), roles };
    });
};

/** A player's patterns for its loaded instrument, each with its notes, for the Patterns tab. */
export const reviewPatterns = (source: PatternSource, transport: TransportState, request: ReviewRequest): PatternReview => {
  const { settings, role, profile } = source;
  const patterns: PatternPreview[] = source.options.map((option) => ({
    id: option.id,
    description: option.description,
    energy: option.energy,
    suits: option.suits,
    ...(option.articulation && { articulation: option.articulation }),
    fit: option.fit,
    notes: renderOption(option, source, transport, request).map((note) => compactNote(note.pitch, note.start, note.duration, note.velocity)),
  }));
  return {
    deviceId: settings.deviceId,
    trackName: settings.trackName,
    instrument: role,
    sound: profile && { name: profile.name, summary: profile.summary, kind: profile.kind },
    provider: source.provider,
    chords: request.chords.map((chord) => chord.symbol),
    beatsPerBar: beatsPerBar(transport),
    energy: request.energy,
    fill: request.fill,
    ...(role === "drums" && { sounds: drumSounds(source, patterns.flatMap((pattern) => pattern.notes.map(([pitch]) => pitch))) }),
    patterns,
    // A decision model may also keep the clip that's playing; the local rules don't weigh that.
    ...(source.provider !== "local" && { hold: HOLD_DESCRIPTION }),
  };
};

/**
 * Where an audition goes: the slot of the last one, else the empty slot just
 * above the ones the player cycles through (the band's scenes tend to be at
 * the top). Never a slot in the player's ring.
 */
export const auditionSlot = (slots: ClipSlotInfo[], ringSize: number, previousId?: number) => {
  const outside = slots.slice(0, Math.max(slots.length - ringSize, 0));
  return outside.find((slot) => slot.id === previousId) ?? [...outside].reverse().find((slot) => !slot.hasClip);
};

/**
 * Writes a pattern, as rendered for review, into a clip slot on the player's
 * track without launching it: launched while Live is stopped it would start
 * the transport, so that's left to the musician.
 */
export const auditionPattern = async (
  source: PatternSource,
  ops: LiveOps,
  transport: TransportState,
  request: ReviewRequest,
  patternId: string,
  ringSize: number,
  previousSlotId?: number
): Promise<AuditionResult & { slotId: number }> => {
  const { trackName, trackId, color } = source.settings;
  const option = source.options.find((o) => o.id === patternId);
  if (!option) throw new AuditionError(`${trackName} isn't offered a pattern "${patternId}" with this instrument`, 404);
  const slot = auditionSlot(await ops.clipSlots(trackId), ringSize, previousSlotId);
  if (!slot) throw new AuditionError(`${trackName} has no free clip slot above the last ${ringSize} the player uses: add a scene or clear a slot`, 409);
  const clipName = `Audition ${option.id} e${request.energy}${request.fill ? " fill" : ""}`;
  const length = request.chords.length * beatsPerBar(transport);
  await ops.writeClip(slot, { name: clipName, color, length, notes: renderOption(option, source, transport, request) });
  return { trackName, slot: slot.index, clipName, slotId: slot.id };
};

import { HeardNote } from "./analyze";

/** A note in a clip. Times are in clip beats. */
export interface ClipNoteData {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  mute: boolean;
}

/** A MIDI clip playing on a Session Input's track, as read from Live. */
export interface InputClip {
  trackId: number;
  clipId: number;
  name: string;
  notes: ClipNoteData[];
  looping: boolean;
  loopStart: number;
  loopEnd: number;
  startMarker: number;
  endMarker: number;
  /** Where the clip was playing, in clip beats, when the song was at `songTime`. */
  position: number;
  songTime: number;
}

/** Ties a clip's playhead to the engine's bars: the clip position at the start of `bar`. */
export interface ClipAnchor {
  bar: number;
  position: number;
}

const EPSILON = 1e-6;
/** Clips launch on a grid, so a playhead read a little off it is snapped to the nearest sixteenth. */
const GRID = 0.25;
const SNAP = 0.1;
/** Enough segments for a one-sixteenth loop in a long bar; guards against a degenerate loop. */
const MAX_SEGMENTS = 256;

const modulo = (value: number, length: number) => ((value % length) + length) % length;

/**
 * Works out where the clip's playhead was when engine bar `bar` started, from
 * a reading taken at a known song time. Counting in engine bars rather than
 * song beats keeps it right when the arrangement loop jumps the song back:
 * the clip plays on regardless.
 */
export const anchorClip = (clip: InputClip, bar: number, barStartBeat: number): ClipAnchor => {
  const position = clip.position - (clip.songTime - barStartBeat);
  const snapped = clip.startMarker + Math.round((position - clip.startMarker) / GRID) * GRID;
  return { bar, position: Math.abs(snapped - position) <= SNAP ? snapped : position };
};

/**
 * The notes the clip will play in engine bar `bar`, in the bar's beats, the
 * way the Recorder would hear them: a note still sounding from before the bar
 * is held, a note running past the bar is cut at its end. A looping clip
 * wraps from loop_end back to loop_start and cuts notes at loop_end; a clip
 * that doesn't loop plays from its start marker to its end marker, then stops.
 */
export const clipNotesInBar = (clip: InputClip, anchor: ClipAnchor, bar: number, beatsPerBar: number): HeardNote[] => {
  if (bar < anchor.bar) return [];
  const loopLength = clip.loopEnd - clip.loopStart;
  const looping = clip.looping && loopLength > EPSILON;
  const end = looping ? clip.loopEnd : clip.endMarker;

  let position = anchor.position + (bar - anchor.bar) * beatsPerBar;
  if (looping && position >= clip.loopEnd - EPSILON) position = clip.loopStart + modulo(position - clip.loopStart, loopLength);

  const notes: HeardNote[] = [];
  let offset = 0;
  for (let segment = 0; segment < MAX_SEGMENTS && offset < beatsPerBar - EPSILON; segment++) {
    if (position >= end - EPSILON) {
      if (!looping) break;
      position = clip.loopStart;
    }
    const from = position;
    const to = Math.min(from + beatsPerBar - offset, end);
    // Inside the loop only its own notes play; before it (or before the clip
    // started, mid-bar) it's the notes from the start marker on.
    const first = looping && from >= clip.loopStart - EPSILON ? clip.loopStart : clip.startMarker;
    for (const note of clip.notes) {
      if (note.mute || note.start < first - EPSILON || note.start >= to - EPSILON) continue;
      const noteEnd = Math.min(note.start + note.duration, end);
      if (noteEnd <= from + EPSILON) continue;
      const start = Math.max(note.start, from);
      notes.push({
        pitch: note.pitch,
        start: offset + start - from,
        duration: Math.min(noteEnd, to) - start,
        velocity: note.velocity,
        held: note.start < from - EPSILON,
      });
    }
    offset += to - from;
    position = to;
  }
  return notes.sort((a, b) => a.start - b.start);
};

import React from "react";
import { CompactNote } from "common";

interface Props {
  notes: CompactNote[];
  /** Beats across the roll. */
  beats: number;
  /** Lowest and highest pitch shown. */
  low: number;
  high: number;
  /** Beats heard so far, for the bar in progress: the rest is shaded. */
  upTo?: number;
  className?: string;
}

const BEAT_WIDTH = 24;
const HEIGHT = 40;

/** The pitch range that fits every note given, with a little room; a middle octave when there are none. */
export const pitchRange = (notes: CompactNote[]): [number, number] => {
  if (!notes.length) return [54, 66];
  const pitches = notes.map(([pitch]) => pitch);
  const low = Math.min(...pitches) - 1;
  const high = Math.max(...pitches) + 1;
  // At least an octave tall, so a single note doesn't fill the cell.
  const pad = Math.max(0, 12 - (high - low)) / 2;
  return [Math.floor(low - pad), Math.ceil(high + pad)];
};

/** Notes as a tiny piano roll: time across, pitch up, louder notes brighter. */
export const MiniRoll = ({ notes, beats, low, high, upTo, className }: Props) => {
  const width = Math.max(beats, 1) * BEAT_WIDTH;
  const rows = Math.max(high - low + 1, 1);
  const rowHeight = HEIGHT / rows;
  return (
    <svg className={["MiniRoll", className].filter(Boolean).join(" ")} viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      {Array.from({ length: Math.ceil(beats) - 1 }, (_, i) => (
        <line key={i} className="beatLine" x1={(i + 1) * BEAT_WIDTH} x2={(i + 1) * BEAT_WIDTH} y1={0} y2={HEIGHT} />
      ))}
      {notes.map(([pitch, start, duration, velocity, held], i) => (
        <rect
          key={i}
          className={held ? "note held" : "note"}
          x={start * BEAT_WIDTH}
          y={(high - pitch) * rowHeight}
          width={Math.max(duration * BEAT_WIDTH - 0.5, 1.5)}
          height={Math.max(rowHeight, 1.5)}
          opacity={0.35 + (Math.min(velocity, 127) / 127) * 0.65}
        />
      ))}
      {upTo !== undefined && upTo < beats && <rect className="unheard" x={upTo * BEAT_WIDTH} y={0} width={(beats - upTo) * BEAT_WIDTH} height={HEIGHT} />}
    </svg>
  );
};

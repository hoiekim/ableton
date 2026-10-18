import { ClipNote } from "./music";

export interface ClipSlotInfo {
  id: number;
  index: number;
  hasClip: boolean;
}

export interface ClipSpec {
  name: string;
  /** 0xRRGGBB. */
  color: number;
  /** In beats. */
  length: number;
  notes: ClipNote[];
}

/** What the Session Player needs from Live, implemented over the bridge in live.ts. */
export interface LiveOps {
  clipSlots: (trackId: number) => Promise<ClipSlotInfo[]>;
  playingSlotIndex: (trackId: number) => Promise<number>;
  /** Writes the clip into the slot, reusing a clip of the same length, and returns the clip's id. */
  writeClip: (slot: ClipSlotInfo, spec: ClipSpec) => Promise<number>;
  /** Launches a clip; it starts on the next bar, since the clips are written with 1-bar launch quantization. */
  fireClip: (clipId: number) => Promise<void>;
  stopTrack: (trackId: number) => Promise<void>;
}

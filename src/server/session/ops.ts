import { RawInstrument } from "./instrument";
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
  /**
   * Copies the device at `deviceIndex` on one track to the start of another
   * and switches it on. Live can't create a Max for Live device by API, but it
   * can duplicate a track and move a device, so: duplicate the source track,
   * move its copy of the device, delete the duplicate. Returns the device's id.
   */
  copyDevice: (fromTrackId: number, deviceIndex: number, toTrackId: number) => Promise<number>;
  /** Sets a Session device's parameter, e.g. "SPI On", as if turned in Live. */
  setSessionParam: (deviceId: number, name: string, value: number) => Promise<void>;
  /** What the first instrument after a device on a track is made of, or undefined when there's none. */
  instrument: (trackId: number, afterDeviceId: number) => Promise<RawInstrument | undefined>;
}

import {
  ConnectionStatus,
  LiveState,
  SessionState,
  TrackState,
  TransportState,
  initialSessionState,
  initialTransport,
} from "common";
import { InputClip } from "./session/clips";

/** "clips" is for the Session Player only; the web app isn't sent it. */
export type StoreChange = "status" | "tracks" | "transport" | "session" | "clips";

type Listener = (change: StoreChange) => void;

const toSixteenths = (songTime: number) => Math.floor(songTime * 4 + 1e-6);

/**
 * Holds the latest known state of the Live Set and tells subscribers which
 * part of it changed.
 */
export class LiveStore {
  state: LiveState = { status: "disconnected", transport: { ...initialTransport }, tracks: [] };

  session: SessionState = initialSessionState;

  /** When Live last reported the song position (performance.now()), for estimating it in between. */
  songTimeAt = 0;

  /** The MIDI clip playing on each Session Input's track, by track id, so the players can read ahead. */
  inputClips = new Map<number, InputClip>();

  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setStatus = (status: ConnectionStatus) => {
    if (this.state.status === status) return;
    this.state.status = status;
    this.notify("status");
  };

  setTracks = (tracks: TrackState[]) => {
    this.state.tracks = tracks;
    this.notify("tracks");
  };

  setInputClip = (trackId: number, clip: InputClip | undefined) => {
    if (!clip && !this.inputClips.has(trackId)) return;
    if (clip) this.inputClips.set(trackId, clip);
    else this.inputClips.delete(trackId);
    this.notify("clips");
  };

  setSession = (session: SessionState) => {
    this.session = session;
    this.notify("session");
  };

  /**
   * Song time changes many times per beat while playing, so it only counts as
   * a change once the position crosses into the next sixteenth.
   */
  patchTransport = (patch: Partial<TransportState>) => {
    const previous = this.state.transport;
    const next = { ...previous, ...patch };
    this.state.transport = next;
    // Stopped, the position doesn't move, so when playback starts it counts as
    // just reported: extrapolating from an old report would run far ahead.
    if (patch.songTime !== undefined || (next.isPlaying && !previous.isPlaying)) this.songTimeAt = performance.now();

    const keys = Object.keys(patch) as (keyof TransportState)[];
    const changed = keys.some((key) => {
      if (key === "songTime") return toSixteenths(previous.songTime) !== toSixteenths(next.songTime);
      return previous[key] !== next[key];
    });

    if (changed) this.notify("transport");
  };

  reset = () => {
    this.patchTransport(initialTransport);
    this.setTracks([]);
    if (this.inputClips.size) {
      this.inputClips.clear();
      this.notify("clips");
    }
    this.setStatus("disconnected");
  };

  private notify = (change: StoreChange) => {
    this.listeners.forEach((listener) => listener(change));
  };
}

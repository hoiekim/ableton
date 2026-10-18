import {
  ConnectionStatus,
  LiveState,
  SessionState,
  TrackState,
  TransportState,
  initialSessionState,
  initialTransport,
} from "common";

export type StoreChange = "status" | "tracks" | "transport" | "session";

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
    if (patch.songTime !== undefined) this.songTimeAt = performance.now();

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
    this.setStatus("disconnected");
  };

  private notify = (change: StoreChange) => {
    this.listeners.forEach((listener) => listener(change));
  };
}

import net from "net";
import { AbletonLive } from "ableton-live";
import {
  DeviceState,
  DeviceType,
  ParamValue,
  TrackState,
  TrackType,
  TransportCommand,
  TransportState,
  initialTransport,
} from "common";
import { ClipNoteData, InputClip } from "./session/clips";
import { estimateSongTime, msPerBeat } from "./session/clock";
import { ClipSlotInfo, ClipSpec, LiveOps } from "./session/ops";
import { LiveStore } from "./store";

// LiveAPI.amxd (shipped in node_modules/ableton-live/external) must be loaded
// on a track in Live. It serves Live's object model over a WebSocket.
const LIVE_HOST = process.env.LIVE_HOST || "127.0.0.1";
const LIVE_PORT = Number(process.env.LIVE_PORT) || 9001;
const RETRY_INTERVAL = 2000;
const CONNECT_TIMEOUT = 5000;
const SYNC_CHECK_INTERVAL = 5000;
// After a mismatch, check again sooner before deciding the observers are gone.
const SYNC_RECHECK_INTERVAL = 1000;
const SYNC_CHECK_FAILURES = 2;

type Unsubscribe = () => Promise<unknown>;

interface RawChild {
  id: string | number;
  path: string;
  [prop: string]: unknown;
}

interface DeviceEntry {
  state: DeviceState;
  unsubscribes: Unsubscribe[];
}

/** Follows the clip playing on a Session Input's track. */
interface ClipFollow {
  unsubscribes: Unsubscribe[];
  /** Observers on the clip playing now, to read it again when it's edited. */
  clipUnsubscribes: Unsubscribe[];
  clipId?: number;
  reading: boolean;
  stale: boolean;
}

interface TrackEntry {
  state: Omit<TrackState, "devices">;
  devices: DeviceEntry[];
  unsubscribes: Unsubscribe[];
  clips?: ClipFollow;
}

const transportProps: Record<string, keyof TransportState> = {
  is_playing: "isPlaying",
  current_song_time: "songTime",
  tempo: "tempo",
  signature_numerator: "signatureNumerator",
  signature_denominator: "signatureDenominator",
  record_mode: "recordMode",
  metronome: "metronome",
  loop: "loop",
};

// Master and return tracks don't have every property regular tracks have, and
// asking for a missing one makes Live log an error.
const trackLists: { child: string; type?: TrackType; props: string[] }[] = [
  { child: "tracks", props: ["name", "color", "mute", "solo", "has_audio_input", "is_foldable", "can_be_armed"] },
  { child: "return_tracks", type: "return", props: ["name", "color", "mute", "solo"] },
  { child: "master_track", type: "master", props: ["name", "color"] },
];

const deviceProps = ["name", "type", "class_name", "class_display_name", "is_active"];

const clipProps = ["is_midi_clip", "name", "length", "looping", "loop_start", "loop_end", "start_marker", "end_marker", "playing_position"];

/** Changes to these make a followed clip play something else, so it's read again. */
const watchedClipProps = ["notes", "looping", "loop_start", "loop_end"];

// Session Player and Session Input devices are recognized by their parameter
// names ("SP Instrument", "SPI Role", ...), so renaming a device is fine.
const SESSION_PARAM = /^SPI? /;

/** Clip launch quantization index for "1 Bar" (Live object model). */
const LAUNCH_ONE_BAR = 5;

const deviceTypes: Record<number, DeviceType> = { 1: "instrument", 2: "audio_effect", 4: "midi_effect" };

/**
 * The bridge forwards raw LiveAPI output, which is sometimes still wrapped in
 * a list like ["name", "Bass"].
 */
const unwrap = (value: unknown, prop: string): unknown => {
  if (!Array.isArray(value)) return value;
  const rest = value[0] === prop ? value.slice(1) : value;
  return rest.length === 1 ? rest[0] : rest.join(" ");
};

const toText = (value: unknown, prop: string) => {
  return String(unwrap(value, prop) ?? "").replace(/^"(.*)"$/, "$1");
};

const toNumber = (value: unknown, prop: string) => Number(unwrap(value, prop));

const toBoolean = (value: unknown, prop: string) => {
  const unwrapped = unwrap(value, prop);
  return unwrapped === "true" || Number(unwrapped) > 0;
};

const toColor = (value: unknown, prop: string) => {
  const rgb = toNumber(value, prop) & 0xffffff;
  return `#${rgb.toString(16).padStart(6, "0")}`;
};

const toDeviceType = (value: unknown): DeviceType => {
  const type = unwrap(value, "type");
  if (type === "instrument" || type === "audio_effect" || type === "midi_effect") return type;
  return deviceTypes[Number(type)] ?? "undefined";
};

const toItems = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => String(item).replace(/^"(.*)"$/, "$1"));
  return typeof value === "string" && value ? [value] : [];
};

const toParamValue = (value: number, items: string[]): ParamValue => {
  const label = items[Math.round(value)];
  return label === undefined ? { value } : { value, label };
};

const round = (value: number) => Math.round(value * 10000) / 10000;

/** get_notes_extended answers with a dictionary, which the bridge passes on as JSON text. */
const toClipNotes = (value: unknown): ClipNoteData[] => {
  let parsed = unwrap(value, "notes");
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const notes = (parsed as { notes?: unknown } | undefined)?.notes;
  if (!Array.isArray(notes)) return [];
  return notes
    .map((note) => ({
      pitch: Number(note?.pitch),
      start: Number(note?.start_time),
      duration: Number(note?.duration),
      velocity: Number(note?.velocity ?? 100),
      mute: !!Number(note?.mute ?? 0),
    }))
    .filter((note) => [note.pitch, note.start, note.duration, note.velocity].every(Number.isFinite));
};

const toTrackType = (raw: RawChild): TrackType => {
  if (toBoolean(raw.is_foldable, "is_foldable")) return "group";
  return toBoolean(raw.has_audio_input, "has_audio_input") ? "audio" : "midi";
};

const toTransportValue = (key: keyof TransportState, value: unknown, prop: string) => {
  return typeof initialTransport[key] === "boolean" ? toBoolean(value, prop) : toNumber(value, prop);
};

const isPortOpen = (host: string, port: number) => {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (isOpen: boolean) => {
      socket.destroy();
      resolve(isOpen);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
};

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string) => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
};

/**
 * The library retries a dropped socket on the same instance, but the bridge
 * forgets every observer when a socket closes, so a revived instance would sit
 * on dead listeners. LiveBridge opens a fresh instance after every drop instead.
 */
const disableAutoReconnect = (live: AbletonLive) => {
  const client = (live as unknown as { client?: { maxAttempts: number } }).client;
  if (client) client.maxAttempts = 0;
};

/**
 * Mirrors one connection's worth of Live state into the store. Uses the
 * library's low-level calls because its object helpers break on lists with a
 * single item and on the master track.
 */
class LiveSession {
  private tracks = new Map<number, TrackEntry>();
  private order: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<string>();
  private disposed = false;

  constructor(private live: AbletonLive, private store: LiveStore) {}

  start = async () => {
    await this.syncTransport();
    const syncTracks = () => this.schedule("tracks", this.syncTracks);
    await Promise.all([
      this.observe("live_set", "tracks", undefined, syncTracks),
      this.observe("live_set", "return_tracks", undefined, syncTracks),
    ]);
    await this.enqueue(this.syncTracks);
  };

  dispose = () => {
    this.disposed = true;
  };

  /**
   * Compares the mirrored transport and track list with Live. The bridge
   * forgets every observer whenever any of its clients disconnects, without
   * telling the others, so a lasting mismatch means ours are gone. Resolves to
   * undefined when the check is inconclusive.
   */
  isInSync = async (): Promise<boolean | undefined> => {
    try {
      // Queued behind structural syncs so the track order is settled.
      return await this.enqueue(async () => {
        const [isTransportInSync, trackIds] = await Promise.all([this.isTransportInSync(), this.listTrackIds()]);
        // A track change that arrived mid-check hasn't been applied yet.
        if (this.disposed || this.pending.size) return undefined;
        const isTrackListInSync =
          trackIds.length === this.order.length && trackIds.every((id, i) => id === this.order[i]);
        return isTransportInSync && isTrackListInSync;
      });
    } catch (error) {
      console.error("[live] Sync check failed:", error);
      return undefined;
    }
  };

  command = async (command: TransportCommand) => {
    const { transport } = this.store.state;
    switch (command) {
      case "play":
        return this.live.call("live_set", { method: "start_playing", parameters: [] });
      case "stop":
        return this.live.call("live_set", { method: "stop_playing", parameters: [] });
      case "toggleRecord":
        return this.live.set("live_set", "record_mode", transport.recordMode ? 0 : 1);
      case "toggleMetronome":
        return this.live.set("live_set", "metronome", transport.metronome ? 0 : 1);
      case "toggleLoop":
        return this.live.set("live_set", "loop", transport.loop ? 0 : 1);
    }
  };

  private syncTransport = async () => {
    const entries = Object.entries(transportProps);
    await Promise.all(
      entries.map(async ([prop, key]) => {
        const apply = (value: unknown) => {
          const converted = toTransportValue(key, value, prop);
          if (typeof converted === "number" && !Number.isFinite(converted)) return;
          this.store.patchTransport({ [key]: converted });
        };
        // Observe first so no change slips in between the read and the subscription.
        await this.observe("live_set", prop, undefined, apply);
        apply(await this.live.get("live_set", prop));
      })
    );
  };

  private isTransportInSync = async () => {
    const results = await Promise.all(
      Object.entries(transportProps).map(async ([prop, key]) => {
        const value = toTransportValue(key, await this.live.get("live_set", prop), prop);
        // Compared as soon as the reply lands: Live sends any earlier change
        // notification on the same socket first, so the store has applied it.
        const { transport } = this.store.state;
        if (typeof value === "boolean") return value === transport[key];
        if (!Number.isFinite(value)) return true;
        // Song time notifications trail the playhead a little while playing.
        const tolerance = key === "songTime" && transport.isPlaying ? transport.tempo / 60 : 0.01;
        return Math.abs(value - (transport[key] as number)) <= tolerance;
      })
    );
    return results.every(Boolean);
  };

  private listTrackIds = async () => {
    const lists = await Promise.all(trackLists.map(({ child }) => this.children("live_set", child, [])));
    return lists.flat().map((raw) => Number(raw.id));
  };

  private syncTracks = async () => {
    const lists = await Promise.all(
      trackLists.map(async ({ child, type, props }) => {
        const raws = await this.children("live_set", child, props);
        return raws.map((raw) => ({ raw, type: type ?? toTrackType(raw) }));
      })
    );
    if (this.disposed) return;

    const found = lists.flat();
    const foundIds = new Set(found.map(({ raw }) => Number(raw.id)));
    this.tracks.forEach((entry, id) => {
      if (foundIds.has(id)) return;
      this.tracks.delete(id);
      this.release(entry.unsubscribes);
      entry.devices.forEach((device) => this.release(device.unsubscribes));
      this.unfollowClips(entry);
    });

    this.order = found.map(({ raw }) => Number(raw.id));
    this.publish();

    for (const { raw, type } of found) {
      const id = Number(raw.id);
      if (this.tracks.has(id)) continue;
      try {
        const entry = await this.loadTrack(raw, type);
        if (this.disposed) return;
        this.tracks.set(id, entry);
        this.publish();
      } catch (error) {
        console.error(`[live] Failed to load track ${id}:`, error);
      }
    }
  };

  private loadTrack = async (raw: RawChild, type: TrackType): Promise<TrackEntry> => {
    const id = Number(raw.id);
    const entry: TrackEntry = {
      state: {
        id,
        name: toText(raw.name, "name"),
        type,
        color: toColor(raw.color, "color"),
        mute: toBoolean(raw.mute, "mute"),
        solo: toBoolean(raw.solo, "solo"),
        arm: false,
      },
      devices: [],
      unsubscribes: [],
    };
    const { state } = entry;

    const watches = [
      this.watch(id, "name", (value) => (state.name = toText(value, "name"))),
      this.watch(id, "color", (value) => (state.color = toColor(value, "color"))),
      this.observe(`id ${id}`, "devices", id, () => {
        this.schedule(`devices ${id}`, async () => {
          if (this.tracks.get(id) === entry) await this.syncDevices(entry);
        });
      }),
    ];
    if (type !== "master") {
      watches.push(this.watch(id, "mute", (value) => (state.mute = toBoolean(value, "mute"))));
      watches.push(this.watch(id, "solo", (value) => (state.solo = toBoolean(value, "solo"))));
    }
    if (toBoolean(raw.can_be_armed, "can_be_armed")) {
      watches.push(this.watch(id, "arm", (value) => (state.arm = toBoolean(value, "arm"))));
      state.arm = toBoolean(await this.live.get(`id ${id}`, "arm", id), "arm");
    }
    entry.unsubscribes = await Promise.all(watches);

    await this.syncDevices(entry);
    return entry;
  };

  private syncDevices = async (track: TrackEntry) => {
    const trackId = track.state.id;
    const raws = await this.children(`id ${trackId}`, "devices", deviceProps, trackId);
    if (this.disposed) return;

    const previous = new Map(track.devices.map((device) => [device.state.id, device]));
    const devices: DeviceEntry[] = [];
    for (const raw of raws) {
      const id = Number(raw.id);
      const existing = previous.get(id);
      if (existing) {
        previous.delete(id);
        devices.push(existing);
      } else {
        devices.push(await this.loadDevice(raw));
        if (this.disposed) return;
      }
    }
    previous.forEach((device) => this.release(device.unsubscribes));

    track.devices = devices;
    this.publish();
    await this.followClips(track);
  };

  /**
   * Follows the clips on a MIDI track with a Session Input, so the Session
   * Player can read what the band is about to play. Tracks with a Session
   * Player are left out: their clips change every bar.
   */
  private followClips = async (track: TrackEntry) => {
    const sessions = track.devices.map((device) => device.state.session?.kind);
    const wanted = track.state.type === "midi" && sessions.includes("input") && !sessions.includes("player");
    if (!wanted) return this.unfollowClips(track);
    if (track.clips) return;
    const id = track.state.id;
    const follow: ClipFollow = { unsubscribes: [], clipUnsubscribes: [], reading: false, stale: false };
    track.clips = follow;
    const unsubscribe = await this.observe(`id ${id}`, "playing_slot_index", id, () => this.readClip(track, follow));
    if (track.clips !== follow) return void this.release([unsubscribe]);
    follow.unsubscribes.push(unsubscribe);
    this.readClip(track, follow);
  };

  private unfollowClips = (track: TrackEntry) => {
    const follow = track.clips;
    if (!follow) return;
    track.clips = undefined;
    this.release([...follow.unsubscribes, ...follow.clipUnsubscribes]);
    this.store.setInputClip(track.state.id, undefined);
  };

  /** Reads the followed track's playing clip; requests that come in meanwhile collapse into one more read. */
  private readClip = (track: TrackEntry, follow: ClipFollow) => {
    follow.stale = true;
    if (follow.reading) return;
    follow.reading = true;
    void (async () => {
      while (follow.stale && track.clips === follow && !this.disposed) {
        follow.stale = false;
        try {
          await this.loadClip(track, follow);
        } catch (error) {
          console.error(`[live] Failed to read the clip playing on track ${track.state.id}:`, error);
        }
      }
      follow.reading = false;
    })();
  };

  private loadClip = async (track: TrackEntry, follow: ClipFollow) => {
    const trackId = track.state.id;
    const current = () => track.clips === follow && !this.disposed;
    const index = toNumber(await this.live.get(`id ${trackId}`, "playing_slot_index", trackId), "playing_slot_index");
    let raw: RawChild | undefined;
    let songTime = 0;
    if (index >= 0) {
      const slot = (await this.children(`id ${trackId}`, "clip_slots", [], trackId))[index];
      if (slot) {
        // The playhead comes with the clip's other properties. Live read it
        // during the round trip, so it goes with the song position halfway
        // through, worked out now: later reports would place it too late.
        const sentAt = performance.now();
        [raw] = await this.children(`id ${slot.id}`, "clip", clipProps, Number(slot.id));
        const receivedAt = performance.now();
        const { transport } = this.store.state;
        songTime = estimateSongTime(transport, this.store.songTimeAt, receivedAt);
        if (transport.isPlaying) songTime -= (receivedAt - sentAt) / 2 / msPerBeat(transport);
      }
    }
    if (!current()) return;

    const clipId = raw && toBoolean(raw.is_midi_clip, "is_midi_clip") ? Number(raw.id) : undefined;
    if (clipId !== follow.clipId) {
      this.release(follow.clipUnsubscribes);
      follow.clipUnsubscribes = [];
      follow.clipId = clipId;
      if (clipId) {
        const readAgain = () => this.readClip(track, follow);
        follow.clipUnsubscribes = await Promise.all(watchedClipProps.map((prop) => this.observe(`id ${clipId}`, prop, clipId, readAgain)));
        if (!current()) return;
      }
    }
    if (!raw || !clipId) return this.store.setInputClip(trackId, undefined);

    const loopStart = toNumber(raw.loop_start, "loop_start");
    const loopEnd = toNumber(raw.loop_end, "loop_end");
    const startMarker = toNumber(raw.start_marker, "start_marker");
    const endMarker = toNumber(raw.end_marker, "end_marker");
    const from = Math.min(0, loopStart, startMarker);
    const span = Math.max(toNumber(raw.length, "length"), loopEnd, endMarker) - from + 1;
    const result = await this.live.call(`id ${clipId}`, { method: "get_notes_extended", parameters: [0, 128, from, span] }, clipId);
    if (!current() || follow.clipId !== clipId) return;

    const clip: InputClip = {
      trackId,
      clipId,
      name: toText(raw.name, "name"),
      notes: toClipNotes(result),
      looping: toBoolean(raw.looping, "looping"),
      loopStart,
      loopEnd,
      startMarker,
      endMarker,
      position: toNumber(raw.playing_position, "playing_position"),
      songTime,
    };
    if ([clip.loopStart, clip.loopEnd, clip.startMarker, clip.endMarker, clip.position].every(Number.isFinite)) {
      this.store.setInputClip(trackId, clip);
    }
  };

  private loadDevice = async (raw: RawChild): Promise<DeviceEntry> => {
    const id = Number(raw.id);
    const state: DeviceState = {
      id,
      name: toText(raw.name, "name"),
      className: toText(raw.class_name, "class_name"),
      classDisplayName: toText(raw.class_display_name, "class_display_name"),
      type: toDeviceType(raw.type),
      isActive: toBoolean(raw.is_active, "is_active"),
    };
    const unsubscribes = await Promise.all([
      this.watch(id, "name", (value) => (state.name = toText(value, "name"))),
      this.watch(id, "is_active", (value) => (state.isActive = toBoolean(value, "is_active"))),
    ]);
    // Only Max for Live devices can be Session devices.
    if (state.className.startsWith("Mx")) unsubscribes.push(...(await this.loadSessionParams(state)));
    return { state, unsubscribes };
  };

  /** Reads and observes the parameters of a Session Player or Session Input device. */
  private loadSessionParams = async (state: DeviceState): Promise<Unsubscribe[]> => {
    const raws = await this.children(`id ${state.id}`, "parameters", ["name", "value", "value_items"], state.id);
    const params = raws
      .map((raw) => ({
        id: Number(raw.id),
        name: toText(raw.name, "name"),
        value: toNumber(raw.value, "value"),
        items: toItems(raw.value_items),
      }))
      .filter((param) => SESSION_PARAM.test(param.name));
    if (!params.length) return [];

    const session = {
      kind: params.some((param) => param.name.startsWith("SP ")) ? ("player" as const) : ("input" as const),
      params: Object.fromEntries(params.map((param) => [param.name, toParamValue(param.value, param.items)])),
    };
    state.session = session;
    return Promise.all(
      params.map((param) =>
        this.watch(param.id, "value", (value) => {
          const number = toNumber(value, "value");
          if (Number.isFinite(number)) session.params[param.name] = toParamValue(number, param.items);
        })
      )
    );
  };

  /** Clip operations for the Session Player, over the same connection. */
  ops: LiveOps = {
    clipSlots: async (trackId) => {
      const raws = await this.children(`id ${trackId}`, "clip_slots", ["has_clip"], trackId);
      return raws.map((raw, index) => ({ id: Number(raw.id), index, hasClip: toBoolean(raw.has_clip, "has_clip") }));
    },
    playingSlotIndex: async (trackId) => {
      return toNumber(await this.live.get(`id ${trackId}`, "playing_slot_index", trackId), "playing_slot_index");
    },
    writeClip: async (slot: ClipSlotInfo, spec: ClipSpec) => {
      const slotPath = `id ${slot.id}`;
      let clip = await this.clipIn(slot.id);
      if (clip && Math.abs(clip.length - spec.length) > 1e-6) {
        await this.live.call(slotPath, { method: "delete_clip", parameters: [] }, slot.id);
        clip = undefined;
      }
      const created = !clip;
      if (!clip) {
        await this.live.call(slotPath, { method: "create_clip", parameters: [spec.length] }, slot.id);
        clip = await this.clipIn(slot.id);
        if (!clip) throw new Error(`Live didn't create a clip in slot ${slot.index + 1}`);
      }
      const { id } = clip;
      const clipPath = `id ${id}`;
      const notes = spec.notes.map((note) => ({
        pitch: note.pitch,
        start_time: round(note.start),
        duration: round(note.duration),
        velocity: note.velocity,
      }));
      // The bridge handles requests in order, so these go out together.
      await Promise.all([
        created ? undefined : this.live.call(clipPath, { method: "remove_notes_extended", parameters: [0, 128, 0, spec.length + 1] }, id),
        notes.length ? this.live.call(clipPath, { method: "add_new_notes", parameters: [{ notes }] }, id) : undefined,
        this.live.set(clipPath, "name", spec.name, id),
        created ? this.live.set(clipPath, "color", spec.color, id) : undefined,
        created ? this.live.set(clipPath, "looping", 1, id) : undefined,
        created ? this.live.set(clipPath, "launch_quantization", LAUNCH_ONE_BAR, id) : undefined,
      ]);
      return id;
    },
    fireClip: async (clipId) => {
      await this.live.call(`id ${clipId}`, { method: "fire", parameters: [] }, clipId);
    },
    stopTrack: async (trackId) => {
      await this.live.call(`id ${trackId}`, { method: "stop_all_clips", parameters: [] }, trackId);
    },
  };

  private clipIn = async (slotId: number) => {
    const [clip] = await this.children(`id ${slotId}`, "clip", ["length"], slotId);
    return clip ? { id: Number(clip.id), length: toNumber(clip.length, "length") } : undefined;
  };

  /**
   * Observes a property of a track or device. Objects are addressed by id so
   * the subscription survives tracks being reordered.
   */
  private watch = (id: number, prop: string, apply: (value: unknown) => void) => {
    return this.observe(`id ${id}`, prop, id, (value) => {
      apply(value);
      this.publish();
    });
  };

  private observe = (
    path: string,
    prop: string,
    liveObjectId: number | undefined,
    listener: (value: unknown) => void
  ): Promise<Unsubscribe> => {
    const onChange = (value: unknown) => {
      if (!this.disposed) listener(value);
    };
    return this.live.observe(path, prop, onChange, { liveObjectId });
  };

  private children = async (path: string, child: string, props: string[], liveObjectId?: number) => {
    const result = await this.live.getChildren(path, { child, initialProps: props }, liveObjectId);
    const raws: RawChild[] = Array.isArray(result) ? result : [result];
    // The bridge reports an empty slot (e.g. no master track) as id 0.
    return raws.filter((raw) => raw && Number(raw.id) > 0);
  };

  private release = (unsubscribes: Unsubscribe[]) => {
    if (this.disposed) return;
    unsubscribes.forEach((unsubscribe) => {
      unsubscribe().catch((error) => console.error("[live] Failed to remove observer:", error));
    });
  };

  private publish = () => {
    if (this.disposed) return;
    const tracks = this.order.flatMap((id) => {
      const entry = this.tracks.get(id);
      if (!entry) return [];
      return [{ ...entry.state, devices: entry.devices.map((device) => ({ ...device.state })) }];
    });
    this.store.setTracks(tracks);
  };

  /** Runs structural syncs one at a time so they never interleave. */
  private enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  };

  /** Like enqueue, but collapses repeated requests that arrive before the task runs. */
  private schedule = (key: string, task: () => Promise<void>) => {
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.enqueue(async () => {
      this.pending.delete(key);
      if (this.disposed) return;
      await task();
    }).catch((error) => console.error(`[live] Failed to sync ${key}:`, error));
  };
}

/**
 * Keeps a connection to Live's bridge alive: waits for it to come up,
 * mirrors its state while connected and starts over after any drop.
 */
export class LiveBridge {
  private live?: AbletonLive;
  private session?: LiveSession;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private syncCheckTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private store: LiveStore) {}

  start = () => {
    this.stopped = false;
    this.connect();
  };

  stop = () => {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.live) this.drop(this.live);
  };

  /** Clip operations, while connected and in sync. */
  ops = (): LiveOps | undefined => {
    return this.store.state.status === "connected" ? this.session?.ops : undefined;
  };

  command = async (command: TransportCommand) => {
    if (!this.session || this.store.state.status !== "connected") return;
    await this.session.command(command);
  };

  private scheduleConnect = () => {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(this.connect, RETRY_INTERVAL);
  };

  private connect = async () => {
    // Probing first keeps the library from logging every failed attempt
    // while Live isn't running.
    if (!(await isPortOpen(LIVE_HOST, LIVE_PORT))) return this.scheduleConnect();
    if (this.stopped) return;

    const live = new AbletonLive({ host: LIVE_HOST, port: LIVE_PORT });
    disableAutoReconnect(live);
    live.on("disconnect", () => this.drop(live));
    this.live = live;
    this.store.setStatus("connecting");

    try {
      await withTimeout(live.connect(), CONNECT_TIMEOUT, "Connecting to Live");
      const session = new LiveSession(live, this.store);
      this.session = session;
      await session.start();
      if (this.live !== live) return;
      this.store.setStatus("connected");
      this.scheduleSyncCheck(live, session, 0);
    } catch (error) {
      console.error("[live] Failed to sync with Live:", error);
      this.drop(live);
    }
  };

  private scheduleSyncCheck = (live: AbletonLive, session: LiveSession, failures: number) => {
    const delay = failures ? SYNC_RECHECK_INTERVAL : SYNC_CHECK_INTERVAL;
    this.syncCheckTimer = setTimeout(async () => {
      const isInSync = await session.isInSync();
      if (this.live !== live) return;
      const nextFailures = isInSync === false ? failures + 1 : isInSync ? 0 : failures;
      if (nextFailures >= SYNC_CHECK_FAILURES) {
        console.warn("[live] Out of sync with Live, probably because another bridge client disconnected. Reconnecting.");
        this.drop(live);
        return;
      }
      this.scheduleSyncCheck(live, session, nextFailures);
    }, delay);
  };

  private drop = (live: AbletonLive) => {
    if (this.live !== live) return;
    clearTimeout(this.syncCheckTimer);
    this.live = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.store.reset();
    try {
      live.close();
    } catch {
      // Already closed.
    }
    this.scheduleConnect();
  };
}

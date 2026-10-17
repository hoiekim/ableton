/**
 * Development stand-in for LiveAPI.amxd, the Max for Live device that serves
 * Live's object model to the ableton-live package. It speaks the bridge's
 * WebSocket protocol on ws://127.0.0.1:9001/ableton-live and serves a sample
 * Live Set, so the controller runs without Ableton Live.
 *
 *   bun run mock                         # LIVE_PORT=9002 bun run mock to move it
 *   curl http://127.0.0.1:9001/mock      # control actions and the current Set
 *
 * MOCK_VERBOSE=1 logs every request, MOCK_LATENCY=<ms> delays every reply.
 *
 * Behaviour follows the bridge's own scripts (live-api.js and
 * node-live-api.js inside LiveAPI.amxd), quirks included.
 */
import type { Server, ServerWebSocket } from "bun";

const HOST = process.env.LIVE_HOST || "127.0.0.1";
const PORT = Number(process.env.LIVE_PORT) || 9001;
const VERBOSE = !!process.env.MOCK_VERBOSE;
const LATENCY = Number(process.env.MOCK_LATENCY) || 0;
const CLOCK_INTERVAL = 25;
const MAX_WARNINGS = 50;

// ---- Live Set ----

interface LiveObject {
  id: number;
  path: string;
  props: Record<string, unknown>;
  /** Child objects by property, e.g. a track's devices, as ids in Live's order. */
  children: Record<string, number[]>;
}

type InitialProp = string | { name: string; initialProps?: InitialProp[] };

const BOOL_PROPS = new Set([
  "is_playing",
  "record_mode",
  "metronome",
  "loop",
  "mute",
  "solo",
  "arm",
  "has_audio_input",
  "has_midi_input",
  "is_foldable",
  "is_grouped",
  "can_be_armed",
  "is_active",
  "can_have_chains",
  "can_have_drum_pads",
]);

const READ_ONLY_PROPS = new Set([
  "has_audio_input",
  "has_midi_input",
  "is_foldable",
  "is_grouped",
  "can_be_armed",
  "type",
  "class_name",
  "class_display_name",
  "is_active",
  "can_have_chains",
  "can_have_drum_pads",
]);

/** Children that are a single object rather than a list, so their path has no index. */
const SINGLE_CHILDREN = new Set(["master_track"]);

const objects = new Map<number, LiveObject>();
const byPath = new Map<string, LiveObject>();
let nextId = 1;

const create = (props: Record<string, unknown>, children: Record<string, LiveObject[]> = {}): LiveObject => {
  const obj: LiveObject = { id: nextId++, path: "", props, children: {} };
  Object.entries(children).forEach(([child, list]) => (obj.children[child] = list.map(({ id }) => id)));
  objects.set(obj.id, obj);
  return obj;
};

const destroy = (obj: LiveObject) => {
  objects.delete(obj.id);
  Object.values(obj.children).forEach((ids) => ids.forEach((id) => destroy(objects.get(id)!)));
};

const INSTRUMENT = 1;
const AUDIO_EFFECT = 2;
const MIDI_EFFECT = 4;

// [class_display_name, type, class_name]
const deviceCatalogue: [string, number, string][] = [
  ["Analog", INSTRUMENT, "UltraAnalog"],
  ["Drift", INSTRUMENT, "Drift"],
  ["Drum Rack", INSTRUMENT, "DrumGroupDevice"],
  ["Electric", INSTRUMENT, "LoungeLizard"],
  ["Instrument Rack", INSTRUMENT, "InstrumentGroupDevice"],
  ["Operator", INSTRUMENT, "Operator"],
  ["Sampler", INSTRUMENT, "MultiSampler"],
  ["Simpler", INSTRUMENT, "OriginalSimpler"],
  ["Wavetable", INSTRUMENT, "InstrumentVector"],
  ["Audio Effect Rack", AUDIO_EFFECT, "AudioEffectGroupDevice"],
  ["Auto Filter", AUDIO_EFFECT, "AutoFilter"],
  ["Chorus-Ensemble", AUDIO_EFFECT, "Chorus2"],
  ["Compressor", AUDIO_EFFECT, "Compressor2"],
  ["Delay", AUDIO_EFFECT, "Delay"],
  ["EQ Eight", AUDIO_EFFECT, "Eq8"],
  ["Echo", AUDIO_EFFECT, "Echo"],
  ["Glue Compressor", AUDIO_EFFECT, "GlueCompressor"],
  ["Hybrid Reverb", AUDIO_EFFECT, "Hybrid"],
  ["Limiter", AUDIO_EFFECT, "Limiter"],
  ["Max Audio Effect", AUDIO_EFFECT, "MxDeviceAudioEffect"],
  ["Reverb", AUDIO_EFFECT, "Reverb"],
  ["Saturator", AUDIO_EFFECT, "Saturator"],
  ["Utility", AUDIO_EFFECT, "StereoGain"],
  ["Arpeggiator", MIDI_EFFECT, "MidiArpeggiator"],
  ["Chord", MIDI_EFFECT, "MidiChord"],
  ["MIDI Effect Rack", MIDI_EFFECT, "MidiEffectGroupDevice"],
  ["Scale", MIDI_EFFECT, "MidiScale"],
];

const findDevice = (query: string) => {
  const lower = query.toLowerCase();
  return deviceCatalogue.find(([displayName, , className]) => {
    return displayName.toLowerCase() === lower || className.toLowerCase() === lower;
  });
};

const device = (classDisplayName: string, name = classDisplayName, isActive = true) => {
  const [displayName, type, className] = findDevice(classDisplayName)!;
  return create({
    name,
    type,
    class_name: className,
    class_display_name: displayName,
    is_active: isActive,
    can_have_chains: className.endsWith("GroupDevice"),
    can_have_drum_pads: className === "DrumGroupDevice",
  });
};

type TrackKind = "midi" | "audio" | "group" | "return" | "master";

/** Master and return tracks lack some properties, and only MIDI and audio tracks can be armed. */
const track = (
  kind: TrackKind,
  name: string,
  color: number,
  devices: LiveObject[],
  overrides: Record<string, unknown> = {}
) => {
  const canBeArmed = kind === "midi" || kind === "audio";
  const props: Record<string, unknown> = {
    name,
    color,
    has_audio_input: kind === "audio" || kind === "return" || kind === "master",
    has_midi_input: kind === "midi",
    is_foldable: kind === "group",
    is_grouped: false,
    can_be_armed: canBeArmed,
  };
  if (kind !== "master") Object.assign(props, { mute: false, solo: false });
  if (canBeArmed) props.arm = false;
  if (kind === "group") props.fold_state = 0;
  return create({ ...props, ...overrides }, { devices });
};

const song = create(
  {
    is_playing: false,
    current_song_time: 0,
    start_time: 0,
    tempo: 124,
    signature_numerator: 4,
    signature_denominator: 4,
    record_mode: false,
    metronome: true,
    loop: false,
    loop_start: 0,
    loop_length: 16,
  },
  {
    tracks: [
      track("midi", "Drums", 0xff3a34, [device("Drum Rack"), device("Glue Compressor"), device("EQ Eight")]),
      track("midi", "Bass", 0xffa529, [device("Operator"), device("Saturator"), device("Auto Filter", undefined, false)]),
      track("midi", "Keys", 0x5480e4, [
        device("Arpeggiator"),
        device("Electric"),
        device("Chorus-Ensemble"),
        device("Reverb"),
      ]),
      track("audio", "Vocals", 0x85b84d, [device("EQ Eight"), device("Compressor"), device("Echo", "Vox Delay")], {
        arm: true,
      }),
      track("group", "FX Group", 0xb677f4, [device("Glue Compressor")]),
      track("audio", "Riser", 0xd86ce4, [device("Auto Filter"), device("Delay")], { is_grouped: true }),
      track("audio", "Impacts", 0xe5a2f6, [], { is_grouped: true }),
    ],
    return_tracks: [
      track("return", "A-Reverb", 0x10a4ee, [device("Hybrid Reverb")]),
      track("return", "B-Delay", 0xffe12f, [device("Delay"), device("EQ Eight")]),
    ],
    // The bridge itself sits on a track in a real Set.
    master_track: [track("master", "Master", 0x969696, [device("Max Audio Effect", "LiveAPI"), device("Utility"), device("Limiter")])],
  }
);

const reindex = () => {
  byPath.clear();
  const place = (obj: LiveObject, path: string) => {
    obj.path = path;
    byPath.set(path, obj);
    Object.entries(obj.children).forEach(([child, ids]) => {
      ids.forEach((id, index) => {
        place(objects.get(id)!, SINGLE_CHILDREN.has(child) ? `${path} ${child}` : `${path} ${child} ${index}`);
      });
    });
  };
  place(song, "live_set");
};

reindex();

const find = (path: string, objectId?: unknown) => {
  // Like the bridge, an object id wins over the path.
  const target = objectId !== undefined && objectId !== null ? `id ${objectId}` : path;
  const normalized = target.replace(/"/g, "").trim().replace(/\s+/g, " ");
  const match = /^id (\d+)$/.exec(normalized);
  return match ? objects.get(Number(match[1])) : byPath.get(normalized);
};

const describe = (obj: LiveObject) => {
  const name = obj.props.name ? ` "${obj.props.name}"` : "";
  return `${obj.path || "?"}${name} (id ${obj.id})`;
};

const warnings: string[] = [];

/** Real Live logs an error for these, which is easy to miss in Max's console. */
const warn = (message: string) => {
  console.warn(`[mock] WARN ${message}`);
  warnings.push(message);
  if (warnings.length > MAX_WARNINGS) warnings.shift();
};

// ---- Bridge protocol ----

interface BridgeRequest {
  uuid?: string;
  objectId?: string | number;
  action?: string;
  path?: string;
  args?: {
    prop?: string;
    value?: unknown;
    child?: string;
    index?: number;
    initialProps?: InitialProp[];
    method?: string;
    parameters?: unknown[];
    calls?: unknown[][];
    objectPath?: string;
    property?: string;
    eventId?: string;
  };
}

interface Observer {
  listeners: string[];
  targetId?: number;
  prop: string;
  initialProps?: InitialProp[];
}

const sockets = new Set<ServerWebSocket<unknown>>();
let observers = new Map<string, Observer>();

/** The bridge hands every reply to every connected client, not just the one that asked. */
const broadcast = (payload: unknown) => {
  const data = JSON.stringify(payload);
  sockets.forEach((ws) => ws.send(data));
};

/** Same as handleLiveOutput in live-api.js. */
const handleLiveOutput = (prop: string, value: unknown, isBool: boolean) => {
  let result = value;
  if (Array.isArray(value)) {
    if (value.length === 1) result = value[0];
    else if (value.length === 2 && (value[0] === "id" || value[0] === prop)) result = value[1];
  }
  return isBool ? !!result : result;
};

/** What LiveAPI's get() returns, which is always a list. */
const rawGet = (obj: LiveObject, prop: string): unknown[] | undefined => {
  const ids = obj.children[prop];
  if (ids) return ids.flatMap((id) => ["id", id]);
  if (prop in obj.props) return [obj.props[prop]];
  return undefined;
};

const apiGet = (obj: LiveObject, prop: string) => {
  const raw = rawGet(obj, prop);
  if (raw) return handleLiveOutput(prop, raw, BOOL_PROPS.has(prop));
  // What the bridge passes on after Live's error isn't modelled.
  warn(`get "${prop}" on ${describe(obj)}: no such property`);
  return null;
};

const childProps = (obj: LiveObject, initialProps: InitialProp[]) => {
  const data: Record<string, unknown> = { id: String(obj.id), path: obj.path };
  initialProps.forEach((prop) => {
    if (typeof prop === "string") {
      data[prop] = apiGet(obj, prop);
      return;
    }
    const nested = objects.get(Number(apiGet(obj, prop.name)));
    data[prop.name] = nested ? childProps(nested, prop.initialProps ?? []) : { id: "0", path: "" };
  });
  return data;
};

/** Turns Live's ["id", 1, "id", 2, ...] into child data, as processChildren in live-api.js. */
const processChildren = (ids: unknown[], initialProps?: InitialProp[]) => {
  const data: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 2) {
    const child = objects.get(Number(ids[i + 1]));
    if (!child) data.push({ id: "0", path: "" });
    else data.push(initialProps ? childProps(child, initialProps) : { id: String(child.id), path: child.path });
  }
  return data;
};

/** Observers are keyed by "<path> <property>" and the object id, as callbackName in live-api.js. */
const callbackName = (objectPath: string | undefined, objectId: unknown) => {
  return objectId ? `${objectPath}-${objectId}` : String(objectPath);
};

const notify = (obj: LiveObject, prop: string) => {
  observers.forEach((observer) => {
    if (observer.targetId !== obj.id || observer.prop !== prop) return;
    // LiveAPI callbacks get the property name first, e.g. ["tracks", "id", 1, ...].
    const raw: unknown[] = [prop, ...(rawGet(obj, prop) ?? [])];
    const result = observer.initialProps ? processChildren(raw.slice(1), observer.initialProps) : raw;
    const data = handleLiveOutput(prop, result, BOOL_PROPS.has(prop));
    broadcast({ event: "callback", result: { data, listeners: observer.listeners } });
  });
};

/** Changes a property the way Live would and tells observers, if it really changed. */
const update = (obj: LiveObject, prop: string, value: unknown) => {
  if (obj.props[prop] === value) return;
  obj.props[prop] = value;
  notify(obj, prop);
};

const setProp = (obj: LiveObject, prop: string, value: unknown) => {
  if (!(prop in obj.props)) return warn(`set "${prop}" on ${describe(obj)}: no such property`);
  if (READ_ONLY_PROPS.has(prop)) return warn(`set "${prop}" on ${describe(obj)}: property is read-only`);
  const current = obj.props[prop];
  if (BOOL_PROPS.has(prop)) return update(obj, prop, value === true || Number(value) > 0);
  if (typeof current !== "number") return update(obj, prop, String(value));
  const number = Number(value);
  if (!Number.isFinite(number)) return warn(`set "${prop}" on ${describe(obj)}: ${JSON.stringify(value)} is not a number`);
  update(obj, prop, number);
};

/** Transport roughly as Live does it: Play starts from the insert marker, Stop twice rewinds. */
const songMethods: Record<string, () => void> = {
  start_playing: () => {
    update(song, "current_song_time", song.props.start_time);
    update(song, "is_playing", true);
  },
  continue_playing: () => update(song, "is_playing", true),
  stop_playing: () => {
    if (!song.props.is_playing) {
      update(song, "start_time", 0);
      update(song, "current_song_time", 0);
    }
    update(song, "is_playing", false);
  },
};

const callMethod = (obj: LiveObject, method: unknown) => {
  const run = obj === song ? songMethods[String(method)] : undefined;
  if (run) run();
  else warn(`call "${method}" on ${describe(obj)}: not supported by the mock`);
  return !!run;
};

const handleRequest = (request: BridgeRequest) => {
  const { uuid, objectId, action, path = "", args = {} } = request;
  const success = (result?: unknown) => broadcast({ uuid, event: "success", result });
  const failure = (result?: unknown) => broadcast({ uuid, event: "error", result });
  if (VERBOSE) console.log(`[mock] ${action} ${objectId !== undefined ? `id ${objectId}` : path}`, JSON.stringify(args));

  // The real bridge doesn't check this and leaves Live to log an error, but an
  // immediate error reply is easier to track down than a timeout.
  const target = () => {
    const obj = find(path, objectId);
    if (!obj) {
      const address = objectId !== undefined ? `id ${objectId}` : `"${path}"`;
      warn(`${action} on ${address}: no such object`);
      failure(`No object at ${address}`);
    }
    return obj;
  };

  switch (action) {
    case "get": {
      const obj = target();
      if (obj) success(args.prop ? apiGet(obj, args.prop) : String(obj.id));
      return;
    }
    case "children": {
      const obj = target();
      if (!obj) return;
      const child = String(args.child);
      // Like the bridge, index 0 counts as no index.
      const ids = args.index ? ["id", find(`${obj.path} ${child} ${args.index}`)?.id ?? 0] : rawGet(obj, child);
      if (!ids) warn(`children "${child}" of ${describe(obj)}: no such property`);
      success(processChildren(ids ?? [], args.initialProps));
      return;
    }
    case "set": {
      const obj = target();
      if (!obj) return;
      setProp(obj, String(args.prop), args.value);
      success(args.value);
      return;
    }
    case "call": {
      const obj = target();
      if (!obj) return;
      if (callMethod(obj, args.method)) success();
      else failure(args.method);
      return;
    }
    case "callMultiple": {
      const obj = target();
      if (!obj) return;
      const calls = args.calls ?? [];
      if (calls.every(([method]) => callMethod(obj, method))) success();
      else failure("callMultiple");
      return;
    }
    case "observe": {
      const { objectPath, property = "", eventId = "", initialProps } = args;
      const key = callbackName(objectPath, objectId);
      const existing = observers.get(key);
      if (existing) {
        existing.listeners.push(eventId);
        success(eventId);
        return;
      }
      // The bridge attaches to whatever the path names and never fails here.
      const obj = find(path, objectId);
      if (!obj) warn(`observe "${property}" on ${objectId !== undefined ? `id ${objectId}` : `"${path}"`}: no such object`);
      else if (!rawGet(obj, property)) warn(`observe "${property}" on ${describe(obj)}: no such property`);
      // Nothing is pushed until the value changes: the bridge registers its
      // listener only after attaching the observer.
      observers.set(key, { listeners: [eventId], targetId: obj?.id, prop: property, initialProps });
      success(eventId);
      return;
    }
    case "removeObserver": {
      const key = callbackName(args.objectPath, objectId);
      const observer = observers.get(key);
      if (observer) {
        // Like the bridge, an unknown eventId removes the last listener (splice(-1, 1)).
        observer.listeners.splice(observer.listeners.indexOf(String(args.eventId)), 1);
        if (!observer.listeners.length) observers.delete(key);
      }
      success();
      return;
    }
    case "close":
      observers = new Map();
      return;
    default:
      // The bridge doesn't answer these either, so the client times out.
      warn(`unknown action "${action}"`);
  }
};

const handleMessage = (text: string) => {
  if (text === "pong") return;
  let request: BridgeRequest;
  try {
    request = JSON.parse(text);
  } catch (error) {
    console.error("[mock] Malformed message:", text);
    return;
  }
  handleRequest(request);
};

// ---- Song clock ----

let lastTick = performance.now();

setInterval(() => {
  const now = performance.now();
  const seconds = (now - lastTick) / 1000;
  lastTick = now;
  if (!song.props.is_playing) return;

  const previous = Number(song.props.current_song_time);
  let time = previous + (Number(song.props.tempo) / 60) * seconds;
  const loopStart = Number(song.props.loop_start);
  const loopLength = Number(song.props.loop_length);
  const loopEnd = loopStart + loopLength;
  if (song.props.loop && previous < loopEnd && time >= loopEnd) time = loopStart + ((time - loopEnd) % loopLength);
  update(song, "current_song_time", time);
}, CLOCK_INTERVAL);

// ---- Control endpoint ----

class ControlError extends Error {}

const reject = (message: string): never => {
  throw new ControlError(message);
};

const listNames: Record<string, string> = {
  tracks: "tracks",
  returns: "return_tracks",
  return_tracks: "return_tracks",
  master: "master_track",
  master_track: "master_track",
};

const listParam = (query: URLSearchParams) => {
  const list = query.get("list") ?? "tracks";
  return listNames[list] ?? reject(`Unknown list "${list}", use tracks, returns or master`);
};

const indexParam = (query: URLSearchParams, name: string, fallback: number) => {
  const value = query.get(name);
  if (value === null || value === "") return fallback;
  const index = Number(value);
  return Number.isInteger(index) ? index : reject(`"${name}" must be an integer, got "${value}"`);
};

const trackParam = (query: URLSearchParams) => {
  const list = listParam(query);
  const ids = song.children[list];
  const index = indexParam(query, "track", 0);
  const obj = objects.get(ids[index]);
  return obj ?? reject(`No track ${index} in ${list}, it has ${ids.length}`);
};

const deviceParam = (query: URLSearchParams, track: LiveObject) => {
  const ids = track.children.devices;
  const index = indexParam(query, "device", ids.length - 1);
  const obj = objects.get(ids[index]);
  return obj ?? reject(`No device ${index} on ${describe(track)}, it has ${ids.length}`);
};

const requireParam = (query: URLSearchParams, name: string) => {
  return query.get(name) || reject(`Missing "${name}"`);
};

const toggle = (prop: string) => (query: URLSearchParams) => {
  const target = trackParam(query);
  if (!(prop in target.props)) reject(`${describe(target)} has no ${prop}`);
  update(target, prop, !target.props[prop]);
  return `${prop} ${target.props[prop] ? "on" : "off"}: ${describe(target)}`;
};

const trackKind = (obj: LiveObject, list: string): TrackKind => {
  if (list === "return_tracks") return "return";
  if (list === "master_track") return "master";
  if (obj.props.is_foldable) return "group";
  return obj.props.has_audio_input ? "audio" : "midi";
};

const trackColors = [0x00c9b7, 0xff94a6, 0xffff00, 0x1aff2f, 0x5480e4, 0xff3a34];

const actions: Record<string, (query: URLSearchParams) => string> = {
  "add-device": (query) => {
    const target = trackParam(query);
    const kind = query.get("class") ?? "Utility";
    if (!findDevice(kind)) reject(`Unknown device class "${kind}", use one of: ${deviceCatalogue.map(([name]) => name).join(", ")}`);
    const added = device(kind, query.get("name") || undefined);
    const ids = target.children.devices;
    ids.splice(indexParam(query, "at", ids.length), 0, added.id);
    reindex();
    notify(target, "devices");
    return `added ${describe(added)}`;
  },
  "remove-device": (query) => {
    const target = trackParam(query);
    const removed = deviceParam(query, target);
    const description = describe(removed);
    target.children.devices = target.children.devices.filter((id) => id !== removed.id);
    destroy(removed);
    reindex();
    notify(target, "devices");
    return `removed ${description}`;
  },
  "toggle-device": (query) => {
    const target = deviceParam(query, trackParam(query));
    update(target, "is_active", !target.props.is_active);
    return `${target.props.is_active ? "on" : "off"}: ${describe(target)}`;
  },
  rename: (query) => {
    const name = requireParam(query, "name");
    const track = trackParam(query);
    const target = query.has("device") ? deviceParam(query, track) : track;
    update(target, "name", name);
    return `renamed ${describe(target)}`;
  },
  color: (query) => {
    const target = trackParam(query);
    const color = parseInt(requireParam(query, "color").replace(/^#|^0x/, ""), 16);
    if (!Number.isFinite(color)) reject(`"color" must be hex, e.g. ff3a34`);
    update(target, "color", color & 0xffffff);
    return `colored ${describe(target)}`;
  },
  mute: toggle("mute"),
  solo: toggle("solo"),
  arm: toggle("arm"),
  "add-track": (query) => {
    const value = query.get("kind") ?? "midi";
    const kinds: TrackKind[] = ["midi", "audio", "return"];
    const kind = kinds.find((kind) => kind === value) ?? reject(`"kind" must be midi, audio or return`);
    const list = kind === "return" ? "return_tracks" : "tracks";
    const ids = song.children[list];
    const index = indexParam(query, "at", ids.length);
    const fallbackName =
      kind === "return" ? `${String.fromCharCode(65 + ids.length)}-Return` : `${index + 1}-${kind === "midi" ? "MIDI" : "Audio"}`;
    const devices = kind === "midi" ? [device("Simpler")] : kind === "audio" ? [device("Utility")] : [device("Reverb")];
    const color = trackColors[nextId % trackColors.length];
    const added = track(kind, query.get("name") || fallbackName, color, devices);
    ids.splice(index, 0, added.id);
    reindex();
    notify(song, list);
    return `added ${describe(added)}`;
  },
  "remove-track": (query) => {
    const list = listParam(query);
    if (list === "master_track") reject("The master track can't be removed");
    const removed = trackParam(query);
    const description = describe(removed);
    song.children[list] = song.children[list].filter((id) => id !== removed.id);
    destroy(removed);
    reindex();
    notify(song, list);
    return `removed ${description}`;
  },
  "move-track": (query) => {
    const list = listParam(query);
    if (list === "master_track") reject("The master track can't be moved");
    const moved = trackParam(query);
    const ids = song.children[list].filter((id) => id !== moved.id);
    ids.splice(indexParam(query, "to", ids.length), 0, moved.id);
    song.children[list] = ids;
    reindex();
    notify(song, list);
    return `moved ${describe(moved)}`;
  },
  play: () => {
    songMethods.start_playing();
    return "playing";
  },
  stop: () => {
    songMethods.stop_playing();
    return "stopped";
  },
  tempo: (query) => {
    setProp(song, "tempo", requireParam(query, "bpm"));
    return `tempo ${song.props.tempo}`;
  },
  drop: () => {
    const count = sockets.size;
    sockets.forEach((ws) => ws.terminate());
    return `dropped ${count} connection(s)`;
  },
  down: (query) => {
    const seconds = Number(query.get("seconds") ?? 5);
    if (!(seconds > 0)) reject(`"seconds" must be positive`);
    setTimeout(() => {
      server.stop(true);
      console.log(`[mock] Down for ${seconds}s`);
      setTimeout(listen, seconds * 1000);
    }, 50);
    return `going down for ${seconds}s`;
  },
};

const describeSet = () => {
  const lines: string[] = [];
  [["tracks", "tracks"], ["returns", "return_tracks"], ["master", "master_track"]].forEach(([label, list]) => {
    song.children[list].forEach((id, index) => {
      const obj = objects.get(id)!;
      const flags = ["mute", "solo", "arm"].filter((prop) => obj.props[prop]).join(" ");
      lines.push(`${label}[${index}] ${describe(obj)} ${trackKind(obj, list)}${flags ? ` (${flags})` : ""}`);
      obj.children.devices.forEach((deviceId, deviceIndex) => {
        const item = objects.get(deviceId)!;
        lines.push(`    device[${deviceIndex}] "${item.props.name}" (id ${item.id})${item.props.is_active ? "" : " off"}`);
      });
    });
  });
  return lines;
};

const help = () => {
  const { tempo, is_playing, current_song_time } = song.props;
  return [
    `LiveAPI bridge mock on ws://${HOST}:${PORT}/ableton-live`,
    "",
    "GET /mock?action=<action>&...  Tracks are picked with track=<index> and list=tracks|returns|master,",
    "devices with device=<index> (default: the last one).",
    "",
    "  add-device     track, class=<device, e.g. Reverb>, name, at",
    "  remove-device  track, device",
    "  toggle-device  track, device",
    "  rename         track, [device], name",
    "  color          track, color=<hex>",
    "  mute|solo|arm  track",
    "  add-track      kind=midi|audio|return, name, at",
    "  remove-track   track",
    "  move-track     track, to",
    "  play|stop      transport (stop twice rewinds)",
    "  tempo          bpm",
    "  drop           cut every connection, like Live crashing",
    "  down           seconds: stop listening for a while, like Live quitting",
    "  state          JSON: observers and recent warnings",
    "",
    `Song: ${tempo} BPM, ${is_playing ? "playing" : "stopped"} at beat ${Number(current_song_time).toFixed(2)}`,
    ...describeSet(),
    "",
  ].join("\n");
};

const control = (query: URLSearchParams) => {
  const action = query.get("action");
  if (!action) return new Response(help());
  if (action === "state") {
    const listeners = [...observers.values()].reduce((count, { listeners }) => count + listeners.length, 0);
    return Response.json({ connections: sockets.size, observers: observers.size, listeners, warnings });
  }
  const run = actions[action];
  if (!run) return new Response(`Unknown action "${action}"\n\n${help()}`, { status: 400 });
  try {
    const message = run(query);
    console.log(`[mock] ${action}: ${message}`);
    return new Response(`${message}\n`);
  } catch (error) {
    if (error instanceof ControlError) return new Response(`${error.message}\n`, { status: 400 });
    throw error;
  }
};

// ---- Server ----

let server: Server;

const listen = () => {
  server = Bun.serve({
    hostname: HOST,
    port: PORT,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ableton-live") {
        if (server.upgrade(req)) return;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (url.pathname === "/mock") return control(url.searchParams);
      return new Response("Not found\n", { status: 404 });
    },
    // Same limits as the bridge's uWebSockets server, which also pings idle clients.
    websocket: {
      idleTimeout: 12,
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws) {
        sockets.add(ws);
        console.log(`[mock] Client connected (${sockets.size} open)`);
      },
      message(_ws, message) {
        const text = typeof message === "string" ? message : message.toString();
        if (LATENCY) setTimeout(() => handleMessage(text), LATENCY);
        else handleMessage(text);
      },
      close(ws, code) {
        sockets.delete(ws);
        // The bridge forgets every observer when any client disconnects.
        observers = new Map();
        console.log(`[mock] Client disconnected with code ${code} (${sockets.size} open)`);
      },
    },
  });
};

try {
  listen();
} catch (error) {
  console.error(`[mock] Can't listen on ${HOST}:${PORT}. Is Live or another mock running? Set LIVE_PORT to move.`);
  console.error(error);
  process.exit(1);
}

const counts = ["tracks", "return_tracks"].map((list) => song.children[list].length);
console.log(`[mock] LiveAPI bridge mock on ws://${HOST}:${PORT}/ableton-live (${counts[0]} tracks, ${counts[1]} returns, master)`);
console.log(`[mock] Controls: curl http://${HOST}:${PORT}/mock`);

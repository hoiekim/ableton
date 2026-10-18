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
 * While the transport plays, a scripted band sends Session Input notes over OSC
 * to MOCK_OSC_PORT (default 9101); MOCK_BAND=0 turns it off. A Session Input
 * on a track that plays a clip forwards the clip's notes instead, as the real
 * device does (see the band-clips and scene actions). MOCK_CLIP_LOG=0 stops
 * the per-bar log of what each clip plays.
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
const OSC_PORT = Number(process.env.MOCK_OSC_PORT) || 9101;
const CLIP_LOG = process.env.MOCK_CLIP_LOG !== "0";
const SLOTS_PER_TRACK = 8;

// ---- Live Set ----

type ObjectKind = "song" | "track" | "device" | "parameter" | "clip_slot" | "clip" | "chain" | "drum_pad" | "sample";

interface LiveObject {
  id: number;
  kind: ObjectKind;
  path: string;
  /** The object this one belongs to, e.g. a clip's slot. */
  parent?: number;
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
  "has_clip",
  "is_triggered",
  "looping",
  "is_midi_clip",
  "is_audio_clip",
  "is_quantized",
  "is_enabled",
  "has_drum_pads",
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
  "has_clip",
  "is_triggered",
  "length",
  "playing_position",
  "is_midi_clip",
  "is_audio_clip",
  "playing_slot_index",
  "fired_slot_index",
  "is_quantized",
  "value_items",
  "notes",
]);

/** Children that are a single object rather than a list, so their path has no index. */
const SINGLE_CHILDREN = new Set(["master_track", "clip", "sample"]);

const objects = new Map<number, LiveObject>();
const byPath = new Map<string, LiveObject>();
let nextId = 1;

const create = (
  props: Record<string, unknown>,
  children: Record<string, LiveObject[]> = {},
  kind: ObjectKind = "device"
): LiveObject => {
  const obj: LiveObject = { id: nextId++, kind, path: "", props, children: {} };
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
  ["Max MIDI Effect", MIDI_EFFECT, "MxDeviceMidiEffect"],
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

interface ParamSpec {
  name: string;
  /** Enum labels; the value is the index. */
  items?: string[];
  min?: number;
  max?: number;
  value: number;
}

const parameter = ({ name, items, min = 0, max = items ? items.length - 1 : 1, value }: ParamSpec) =>
  create(
    {
      name,
      original_name: name,
      value,
      default_value: value,
      min,
      max,
      is_quantized: !!items,
      value_items: items ?? [],
      is_enabled: true,
      state: 0,
    },
    {},
    "parameter"
  );

const device = (classDisplayName: string, name = classDisplayName, isActive = true, params: ParamSpec[] = []) => {
  const [displayName, type, className] = findDevice(classDisplayName)!;
  // Every Live device's first parameter is its on/off switch.
  const parameters = [{ name: "Device On", items: ["Off", "On"], value: isActive ? 1 : 0 }, ...params].map(parameter);
  return create(
    {
      name,
      type,
      class_name: className,
      class_display_name: displayName,
      is_active: isActive,
      can_have_chains: className.endsWith("GroupDevice"),
      can_have_drum_pads: className === "DrumGroupDevice",
    },
    { parameters }
  );
};

// The Session devices' parameters, as in devices/*.maxpat.
const ROLES = ["Auto", "Bass", "Chords", "Melody", "Drums"];

const sessionPlayer = (instrument: number) =>
  device("Max MIDI Effect", "Session Player", true, [
    { name: "SP Instrument", items: ["Drums", "Bass", "Keys", "Guitar", "Auto"], value: instrument },
    { name: "SP Active", items: ["Off", "On"], value: 1 },
    { name: "SP Lookahead", min: 1, max: 4, value: 1 },
    { name: "SP Length", items: ["1 bar", "2 bars", "4 bars"], value: 0 },
    { name: "SP Join", min: 0, max: 4, value: 1 },
    { name: "SP Energy", items: ["Auto", ...Array.from({ length: 10 }, (_, i) => String(i + 1))], value: 0 },
  ]);

const sessionInput = (role: string) =>
  device("Max MIDI Effect", "Session Input", true, [
    { name: "SPI Role", items: ROLES, value: ROLES.indexOf(role) },
    { name: "SPI On", items: ["Off", "On"], value: 1 },
  ]);

/** Simpler with a sample and an amp envelope (times in ms, sustain 0–1), as Live reports them. */
const simpler = (name: string, file: string, envelope: { attack: number; decay: number; sustain: number; release: number }) => {
  const obj = device("Simpler", name, true, [
    { name: "Ve Attack", min: 0.1, max: 20000, value: envelope.attack },
    { name: "Ve Decay", min: 1, max: 60000, value: envelope.decay },
    { name: "Ve Sustain", min: 0, max: 1, value: envelope.sustain },
    { name: "Ve Release", min: 1, max: 60000, value: envelope.release },
  ]);
  const sample = create({ file_path: `/Users/me/Samples/${file}`, length: 44100 }, {}, "sample");
  obj.children.sample = [sample.id];
  return obj;
};

/** A Drum Rack with a Simpler on each named pad; `pads` maps note to sound name. */
const drumRack = (name: string, pads: Record<number, string>) => {
  const rack = device("Drum Rack", name);
  rack.props.has_drum_pads = true;
  const chains: LiveObject[] = [];
  const padObjects = Array.from({ length: 128 }, (_, note) => {
    const sound = pads[note];
    const padChains = sound ? [create({ name: sound, mute: false, solo: false, out_note: 60 }, { devices: [simpler(sound, `${sound}.wav`, { attack: 0.1, decay: 300, sustain: 0, release: 50 })] }, "chain")] : [];
    chains.push(...padChains);
    return create({ note, name: sound ?? "", mute: false, solo: false }, { chains: padChains }, "drum_pad");
  });
  rack.children.drum_pads = padObjects.map(({ id }) => id);
  rack.children.chains = chains.map(({ id }) => id);
  return rack;
};

/** An Instrument Rack whose chains hold the given instruments. */
const instrumentRack = (name: string, chains: [string, LiveObject[]][]) => {
  const rack = device("Instrument Rack", name);
  rack.children.chains = chains.map(([chainName, devices]) => create({ name: chainName, mute: false, solo: false }, { devices }, "chain").id);
  return rack;
};

const sessionInputAudio = (role: string) =>
  device("Max Audio Effect", "Session Input Audio", true, [
    { name: "SPI Role", items: ROLES, value: ROLES.indexOf(role) },
    { name: "SPI On", items: ["Off", "On"], value: 1 },
    { name: "SPI Threshold", min: -70, max: 0, value: -40 },
  ]);

const sessionVoice = () =>
  device("Max Audio Effect", "Session Voice", true, [
    { name: "SPV On", items: ["Off", "On"], value: 1 },
    { name: "SPV Threshold", min: -70, max: 0, value: -35 },
  ]);

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
  const children: Record<string, LiveObject[]> = { devices };
  // Return and master tracks have no clip slots.
  if (kind === "midi" || kind === "audio" || kind === "group") {
    Object.assign(props, { playing_slot_index: -1, fired_slot_index: -1 });
    children.clip_slots = Array.from({ length: SLOTS_PER_TRACK }, () =>
      create({ has_clip: false, is_playing: false, is_triggered: false }, { clip: [] }, "clip_slot")
    );
  }
  return create({ ...props, ...overrides }, children, "track");
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
    // Song enum: 0 None, 1 8 Bars, 2 4 Bars, 3 2 Bars, 4 1 Bar, ...
    clip_trigger_quantization: 4,
  },
  {
    tracks: [
      track("midi", "Drums", 0xff3a34, [device("Drum Rack"), device("Glue Compressor"), device("EQ Eight")]),
      track("midi", "Bass", 0xffa529, [
        sessionInput("Bass"),
        device("Operator"),
        device("Saturator"),
        device("Auto Filter", undefined, false),
      ]),
      track("midi", "Keys", 0x5480e4, [
        sessionInput("Chords"),
        device("Arpeggiator"),
        device("Electric"),
        device("Chorus-Ensemble"),
        device("Reverb"),
      ]),
      track(
        "audio",
        "Vocals",
        0x85b84d,
        [sessionVoice(), sessionInputAudio("Melody"), device("EQ Eight"), device("Compressor"), device("Echo", "Vox Delay")],
        { arm: true }
      ),
      track("group", "FX Group", 0xb677f4, [device("Glue Compressor")]),
      track("audio", "Riser", 0xd86ce4, [device("Auto Filter"), device("Delay")], { is_grouped: true }),
      track("audio", "Impacts", 0xe5a2f6, [], { is_grouped: true }),
      // Session Players: an AI drummer and guitarist jamming with the band above.
      // Both players on Auto: the server works out drums and guitar from what's loaded.
      // The kit's pads are off the General MIDI notes on purpose, to catch assumptions.
      track("midi", "AI Drums", 0xc792ff, [
        sessionPlayer(4),
        drumRack("808 Core Kit", {
          48: "Kick 808",
          50: "Snare Tight",
          51: "Clap 909",
          52: "Tom Lo",
          54: "Hat Closed",
          55: "Tom Hi",
          58: "Hat Open",
          60: "Shaker",
          61: "Crash",
          62: "Conga Hi",
        }),
      ]),
      track("midi", "AI Guitar", 0x9d6bff, [
        sessionPlayer(4),
        instrumentRack("Nylon Guitar", [["Nylon Guitar", [simpler("Nylon Guitar", "Nylon Guitar C3.wav", { attack: 1, decay: 900, sustain: 0.05, release: 300 })]]]),
      ]),
    ],
    return_tracks: [
      track("return", "A-Reverb", 0x10a4ee, [device("Hybrid Reverb")]),
      track("return", "B-Delay", 0xffe12f, [device("Delay"), device("EQ Eight")]),
    ],
    // The bridge itself sits on a track in a real Set.
    master_track: [track("master", "Master", 0x969696, [device("Max Audio Effect", "LiveAPI"), device("Utility"), device("Limiter")])],
  },
  "song"
);

const reindex = () => {
  byPath.clear();
  const place = (obj: LiveObject, path: string, parent?: number) => {
    obj.path = path;
    obj.parent = parent;
    byPath.set(path, obj);
    Object.entries(obj.children).forEach(([child, ids]) => {
      ids.forEach((id, index) => {
        place(objects.get(id)!, SINGLE_CHILDREN.has(child) ? `${path} ${child}` : `${path} ${child} ${index}`, obj.id);
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
  // Live's playhead runs on between the mock's clock ticks.
  if (obj.kind === "clip" && prop === "playing_position") {
    const current = playing.get(parentOf(parentOf(obj)!)?.id ?? -1);
    if (current?.clip === obj) return [clipPosition(current, songTimeNow())];
  }
  const ids = obj.children[prop];
  // Live reports an empty single child (a slot without a clip) as id 0.
  if (ids && !ids.length && SINGLE_CHILDREN.has(prop)) return ["id", 0];
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
  if (obj.kind === "parameter" && prop === "value") {
    return update(obj, prop, Math.min(Number(obj.props.max), Math.max(Number(obj.props.min), number)));
  }
  update(obj, prop, number);
};

// ---- Clips and launching ----

interface Note {
  note_id: number;
  pitch: number;
  start_time: number;
  duration: number;
  velocity: number;
  mute: boolean;
  probability: number;
  velocity_deviation: number;
  release_velocity: number;
}

interface Playing {
  slot: LiveObject;
  clip: LiveObject;
  /** Song beat the clip started at. */
  startedAt: number;
}

const clipNotes = new Map<number, Note[]>();
let nextNoteId = 1;
/** Per track: the clip waiting for its launch point. */
const launches = new Map<number, { slot: LiveObject; at: number }>();
/** Per track: the beat its playing clip stops at. */
const stops = new Map<number, number>();
const playing = new Map<number, Playing>();

const beatsPerBar = () => (Number(song.props.signature_numerator) * 4) / Number(song.props.signature_denominator);

/** Grid in beats for Live's global quantization enum (0 None, 1 8 Bars, ... 4 1 Bar, 5 1/2, ...). */
const gridBeats = (songQuantization: number) => {
  const bar = beatsPerBar();
  return [0, 8 * bar, 4 * bar, 2 * bar, bar, 2, 4 / 3, 1, 2 / 3, 0.5, 1 / 3, 0.25, 1 / 6, 0.125][songQuantization] ?? bar;
};

/** The next point on the grid, or now when there's no quantization. */
const nextLaunchPoint = (songQuantization: number) => {
  const time = Number(song.props.current_song_time);
  const grid = gridBeats(songQuantization);
  return grid ? Math.ceil((time + 1e-6) / grid) * grid : time;
};

const parentOf = (obj: LiveObject) => (obj.parent !== undefined ? objects.get(obj.parent) : undefined);
const clipIn = (slot: LiveObject) => objects.get(slot.children.clip?.[0] ?? -1);
const slotIndex = (slot: LiveObject) => parentOf(slot)!.children.clip_slots.indexOf(slot.id);

const launch = (slot: LiveObject, override?: number, startAt?: number) => {
  const track = parentOf(slot)!;
  const clip = clipIn(slot);
  if (!clip) {
    // An empty slot acts as the track's stop button.
    stops.set(track.id, nextLaunchPoint(Number(song.props.clip_trigger_quantization)));
    return;
  }
  // The clip's own setting wins (clip enum: 0 Global, 1 None, 2 8 Bars, ...), then the override, then global.
  const clipQuantization = Number(clip.props.launch_quantization);
  const quantization =
    clipQuantization > 0 ? clipQuantization - 1 : override !== undefined ? override : Number(song.props.clip_trigger_quantization);
  // Launching a clip while stopped starts the transport, as in Live.
  const wasStopped = !song.props.is_playing;
  if (wasStopped) update(song, "is_playing", true);
  const at = startAt ?? (wasStopped ? Number(song.props.current_song_time) : nextLaunchPoint(quantization));
  const previous = launches.get(track.id);
  if (previous && previous.slot !== slot) {
    update(previous.slot, "is_triggered", false);
    const previousClip = clipIn(previous.slot);
    if (previousClip) update(previousClip, "is_triggered", false);
  }
  launches.set(track.id, { slot, at });
  stops.delete(track.id);
  update(slot, "is_triggered", true);
  update(clip, "is_triggered", true);
  update(track, "fired_slot_index", slotIndex(slot));
};

const stopClip = (trackId: number) => {
  const current = playing.get(trackId);
  if (!current) return;
  cutInputNotes(trackId, Number(song.props.current_song_time));
  playing.delete(trackId);
  update(current.clip, "is_playing", false);
  update(current.slot, "is_playing", false);
  update(objects.get(trackId)!, "playing_slot_index", -1);
};

const startClip = (track: LiveObject, slot: LiveObject, at: number) => {
  const clip = clipIn(slot);
  launches.delete(track.id);
  update(slot, "is_triggered", false);
  update(track, "fired_slot_index", -1);
  if (!clip) return;
  const current = playing.get(track.id);
  if (current && current.clip !== clip) stopClip(track.id);
  // From here the track's Session Input hears the clip, not the scripted band.
  cutInputNotes(track.id, at);
  playing.set(track.id, { slot, clip, startedAt: at });
  update(clip, "is_triggered", false);
  update(clip, "is_playing", true);
  update(slot, "is_playing", true);
  update(track, "playing_slot_index", slotIndex(slot));
};

const stopAllClips = () => {
  [...playing.keys()].forEach(stopClip);
  launches.forEach(({ slot }, trackId) => {
    update(slot, "is_triggered", false);
    update(objects.get(trackId)!, "fired_slot_index", -1);
  });
  launches.clear();
  stops.clear();
};

/** Where in the clip the playhead is at a song beat. */
const clipPosition = (current: Playing, time: number) => {
  const { clip, startedAt } = current;
  const elapsed = Math.max(time - startedAt, 0);
  if (!clip.props.looping) return elapsed;
  const loopStart = Number(clip.props.loop_start);
  const loopLength = Math.max(Number(clip.props.loop_end) - loopStart, 1e-6);
  return loopStart + (elapsed % loopLength);
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (pitch: number) => `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;

/** Logs what each playing clip sounds in the bar that just started. */
const logBar = (time: number) => {
  if (!CLIP_LOG) return;
  const bar = beatsPerBar();
  playing.forEach((current, trackId) => {
    const track = objects.get(trackId)!;
    const from = clipPosition(current, time);
    const notes = (clipNotes.get(current.clip.id) ?? [])
      .filter((note) => note.start_time >= from - 1e-6 && note.start_time < from + bar - 1e-6)
      .sort((a, b) => a.start_time - b.start_time);
    const shown = notes.slice(0, 12).map((note) => `${noteName(note.pitch)}@${+(note.start_time - from).toFixed(2)}`);
    const more = notes.length > 12 ? ` …+${notes.length - 12}` : "";
    const songBar = Math.floor(time / bar + 1e-6) + 1;
    console.log(
      `[clip] bar ${songBar} | ${track.props.name} | "${current.clip.props.name}" (slot ${slotIndex(current.slot) + 1}) | ${shown.join(" ") || "silent"}${more}`
    );
  });
};

type Method = (obj: LiveObject, parameters: unknown[]) => unknown;

/** Thrown by a method to make the bridge reply with an error, as Live does for invalid calls. */
class CallError extends Error {}

/** Transport roughly as Live does it: Play starts from the insert marker, Stop twice rewinds. */
const songMethods: Record<string, Method> = {
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
    stopAllClips();
  },
};

const trackMethods: Record<string, Method> = {
  stop_all_clips: (track) => {
    const triggered = launches.get(track.id);
    if (triggered) {
      update(triggered.slot, "is_triggered", false);
      launches.delete(track.id);
    }
    if (playing.has(track.id)) stops.set(track.id, nextLaunchPoint(Number(song.props.clip_trigger_quantization)));
  },
};

const slotMethods: Record<string, Method> = {
  create_clip: (slot, [length]) => {
    const track = parentOf(slot)!;
    if (!track.props.has_midi_input) throw new CallError("create_clip: only MIDI tracks can have new clips");
    if (clipIn(slot)) throw new CallError("create_clip: the slot already has a clip");
    const beats = Number(length);
    if (!(beats > 0)) throw new CallError("create_clip: length must be positive");
    const clip = create(
      {
        name: "",
        color: track.props.color,
        length: beats,
        looping: true,
        loop_start: 0,
        loop_end: beats,
        start_marker: 0,
        end_marker: beats,
        launch_quantization: 0,
        // Only observed: Live notifies when the clip's notes change.
        notes: 0,
        is_playing: false,
        is_triggered: false,
        playing_position: 0,
        is_midi_clip: true,
        is_audio_clip: false,
      },
      {},
      "clip"
    );
    clipNotes.set(clip.id, []);
    slot.children.clip = [clip.id];
    reindex();
    update(slot, "has_clip", true);
    notify(slot, "clip");
  },
  delete_clip: (slot) => {
    const clip = clipIn(slot);
    if (!clip) return;
    const track = parentOf(slot)!;
    if (playing.get(track.id)?.clip === clip) stopClip(track.id);
    if (launches.get(track.id)?.slot === slot) launches.delete(track.id);
    slot.children.clip = [];
    clipNotes.delete(clip.id);
    destroy(clip);
    reindex();
    update(slot, "has_clip", false);
    notify(slot, "clip");
  },
  fire: (slot, [, launchQuantization]) => launch(slot, launchQuantization === undefined ? undefined : Number(launchQuantization)),
  stop: (slot) => {
    const track = parentOf(slot)!;
    if (playing.get(track.id)?.slot === slot) stops.set(track.id, nextLaunchPoint(Number(song.props.clip_trigger_quantization)));
  },
};

const inRange = (value: number, from: number, span: number) => value >= from && value < from + span;

const clipMethods: Record<string, Method> = {
  add_new_notes: (clip, [dict]) => {
    const notes = (dict as { notes?: unknown } | undefined)?.notes;
    if (!Array.isArray(notes)) throw new CallError("add_new_notes: expected a dictionary with a notes list");
    const added = notes.map((raw) => {
      const note = raw as Partial<Note>;
      if (![note.pitch, note.start_time, note.duration].every((n) => Number.isFinite(Number(n)))) {
        throw new CallError("add_new_notes: every note needs pitch, start_time and duration");
      }
      return {
        note_id: nextNoteId++,
        pitch: Number(note.pitch),
        start_time: Number(note.start_time),
        duration: Number(note.duration),
        velocity: Number(note.velocity ?? 100),
        mute: !!note.mute,
        probability: Number(note.probability ?? 1),
        velocity_deviation: Number(note.velocity_deviation ?? 0),
        release_velocity: Number(note.release_velocity ?? 64),
      };
    });
    clipNotes.get(clip.id)!.push(...added);
    update(clip, "notes", Number(clip.props.notes) + 1);
    return added.map((note) => note.note_id);
  },
  remove_notes_extended: (clip, [fromPitch, pitchSpan, fromTime, timeSpan]) => {
    const keep = (note: Note) =>
      !(inRange(note.pitch, Number(fromPitch), Number(pitchSpan)) && inRange(note.start_time, Number(fromTime), Number(timeSpan)));
    const before = clipNotes.get(clip.id)!;
    const kept = before.filter(keep);
    clipNotes.set(clip.id, kept);
    if (kept.length !== before.length) update(clip, "notes", Number(clip.props.notes) + 1);
  },
  get_notes_extended: (clip, [fromPitch, pitchSpan, fromTime, timeSpan]) => {
    const notes = clipNotes
      .get(clip.id)!
      .filter((note) => inRange(note.pitch, Number(fromPitch), Number(pitchSpan)) && inRange(note.start_time, Number(fromTime), Number(timeSpan)));
    // Max's LiveAPI hands dictionaries back as JSON text.
    return JSON.stringify({ notes });
  },
  fire: (clip) => launch(parentOf(clip)!),
  stop: (clip) => slotMethods.stop(parentOf(clip)!, []),
};

const methodsByKind: Partial<Record<ObjectKind, Record<string, Method>>> = {
  song: songMethods,
  track: trackMethods,
  clip_slot: slotMethods,
  clip: clipMethods,
};

/** Runs a LOM method; the result is what the bridge replies with. */
const callMethod = (obj: LiveObject, method: unknown, parameters: unknown[] = []): { ok: boolean; result?: unknown } => {
  const run = methodsByKind[obj.kind]?.[String(method)];
  if (!run) {
    warn(`call "${method}" on ${describe(obj)}: not supported by the mock`);
    return { ok: false };
  }
  try {
    return { ok: true, result: run(obj, parameters) };
  } catch (error) {
    if (!(error instanceof CallError)) throw error;
    warn(`${error.message} (${describe(obj)})`);
    return { ok: false, result: error.message };
  }
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
      const { ok, result } = callMethod(obj, args.method, args.parameters ?? []);
      if (ok) success(result);
      else failure(result ?? args.method);
      return;
    }
    case "callMultiple": {
      const obj = target();
      if (!obj) return;
      // Like the bridge, each entry is [method, ...arguments].
      const calls = args.calls ?? [];
      if (calls.every(([method, ...parameters]) => callMethod(obj, method, parameters).ok)) success();
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

// ---- Scripted band ----

// What the Session Input devices would send while a band plays: notes stamped
// with Live's song position in ticks (480 per quarter note), over OSC/UDP.
const TICKS_PER_BEAT = 480;
const CHORD_TYPES: Record<string, number[]> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  m7b5: [0, 3, 6, 10],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
};

const parseChord = (symbol: string) => {
  const match = /^([A-G])([#b]?)(.*)$/.exec(symbol.trim());
  const intervals = match && CHORD_TYPES[match[3]];
  if (!match || !intervals) return undefined;
  const root = (NOTE_NAMES.indexOf(match[1]) + (match[2] === "#" ? 1 : match[2] === "b" ? 11 : 0)) % 12;
  return { root, intervals };
};

let bandSymbols = ["Am7", "Fmaj7", "C", "G"];
let bandChords = bandSymbols.map((symbol) => parseChord(symbol)!);
let bandOn = process.env.MOCK_BAND !== "0";

interface BandEvent {
  deviceId: number;
  pitch: number;
  velocity: number;
  beat: number;
}

let bandQueue: BandEvent[] = [];
let lastTick = performance.now();

/** The song position now, between the clock's ticks. */
const songTimeNow = () => {
  const time = Number(song.props.current_song_time);
  return song.props.is_playing ? time + ((performance.now() - lastTick) / 60000) * Number(song.props.tempo) : time;
};
let bandScheduledBar = -1;
const sounding = new Map<string, BandEvent>();
const udp = await Bun.udpSocket({});

const oscString = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / 4) * 4);
  padded.set(bytes);
  return padded;
};

const oscMessage = (address: string, args: (["i" | "f", number] | ["s", string])[]) => {
  const parts = [oscString(address), oscString(`,${args.map(([type]) => type).join("")}`)];
  for (const [type, value] of args) {
    if (type === "s") {
      parts.push(oscString(value));
      continue;
    }
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    if (type === "i") view.setInt32(0, value);
    else view.setFloat32(0, value);
    parts.push(bytes);
  }
  const message = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  return message;
};

/** The Session Input devices in the set, with their role and whether they're MIDI or audio. */
const inputDevices = () => {
  const found: { id: number; role: string; kind: "midi" | "audio"; trackId?: number }[] = [];
  objects.forEach((obj) => {
    if (obj.kind !== "device") return;
    const params = (obj.children.parameters ?? []).map((id) => objects.get(id)!);
    const role = params.find((param) => param.props.name === "SPI Role");
    const on = params.find((param) => param.props.name === "SPI On");
    if (!role || !obj.props.is_active || Number(on?.props.value ?? 1) < 1) return;
    found.push({
      id: obj.id,
      role: ROLES[Number(role.props.value)],
      kind: obj.props.class_name === "MxDeviceAudioEffect" ? "audio" : "midi",
      trackId: parentOf(obj)?.id,
    });
  });
  return found;
};

/** What each audio input is hearing; it reports readings, not notes, like fzero~ in the real device. */
const audioPitch = new Map<number, number | undefined>();
const isAudioInput = (deviceId: number) => objects.get(deviceId)?.props.class_name === "MxDeviceAudioEffect";

const sendNote = ({ deviceId, pitch, velocity, beat }: BandEvent) => {
  if (isAudioInput(deviceId)) {
    if (velocity) {
      audioPitch.set(deviceId, pitch);
      udp.send(oscMessage("/sp/onset", [["i", deviceId], ["f", beat * TICKS_PER_BEAT]]), OSC_PORT, "127.0.0.1");
    } else if (audioPitch.get(deviceId) === pitch) audioPitch.set(deviceId, undefined);
    return;
  }
  // A few milliseconds of timing slop, like a real player.
  const msPerBeat = 60000 / Number(song.props.tempo);
  const jitter = ((Math.random() - 0.5) * 10) / msPerBeat;
  const ticks = Math.max(beat + (velocity ? jitter : 0), 0) * TICKS_PER_BEAT;
  udp.send(oscMessage("/sp/note", [["i", deviceId], ["i", pitch], ["i", velocity], ["f", ticks]]), OSC_PORT, "127.0.0.1");
};

const pitchAbove = (pc: number, low: number) => low + ((pc - low + 120) % 12);

type Chord = NonNullable<ReturnType<typeof parseChord>>;

/** One bar of a part over a chord, in beats from the bar's start: bass in eighths, held chords, or a simple melody. */
const partNotes = (role: string, chord: Chord, length: number) => {
  const tones = chord.intervals.map((interval) => (chord.root + interval) % 12);
  const notes: { pitch: number; start: number; duration: number; velocity: number }[] = [];
  const note = (pitch: number, start: number, duration: number, velocity: number) => notes.push({ pitch, start, duration, velocity });
  if (role === "Bass") {
    const root = pitchAbove(chord.root, 33);
    const fifth = root + 7;
    [root, root, fifth, root, root, root, fifth, root + 12].forEach((pitch, i) => {
      if (i * 0.5 < length) note(pitch, i * 0.5, 0.45, i % 2 ? 80 : 96);
    });
  } else if (role === "Chords") {
    tones.map((pc) => pitchAbove(pc, 57)).forEach((pitch) => note(pitch, 0, length - 0.1, 70));
  } else if (role === "Melody") {
    const line = [pitchAbove(tones[1], 64), pitchAbove(tones[2], 64), pitchAbove(tones[0], 69)];
    line.forEach((pitch, i) => note(pitch, i, i === 2 ? 1.5 : 0.9, 84));
  }
  return notes;
};

/** A MIDI input whose track plays (or is about to play) a clip forwards the clip instead of the scripted part. */
const followsClip = (input: ReturnType<typeof inputDevices>[number]) => {
  return input.kind === "midi" && input.trackId !== undefined && (playing.has(input.trackId) || launches.has(input.trackId));
};

/** One bar of the scripted band, for the inputs not playing clips. */
const bandBar = (bar: number): BandEvent[] => {
  const length = beatsPerBar();
  const start = bar * length;
  const chord = bandChords[((bar % bandChords.length) + bandChords.length) % bandChords.length];
  const events: BandEvent[] = [];
  for (const input of inputDevices()) {
    if (followsClip(input)) continue;
    for (const note of partNotes(input.role, chord, length)) {
      const beat = start + note.start;
      events.push(
        { deviceId: input.id, pitch: note.pitch, velocity: note.velocity, beat },
        { deviceId: input.id, pitch: note.pitch, velocity: 0, beat: beat + note.duration }
      );
    }
  }
  return events;
};

/**
 * Queues what each MIDI Session Input hears from the clip playing on its
 * track during song beats [from, to): every pass of a looping clip plays its
 * notes again, cut at the loop end.
 */
const forwardClips = (from: number, to: number) => {
  for (const input of inputDevices()) {
    const current = input.kind === "midi" && input.trackId !== undefined ? playing.get(input.trackId) : undefined;
    if (!current) continue;
    const { clip, startedAt } = current;
    const looping = !!clip.props.looping;
    // Same playhead as clipPosition: a looping clip starts at its loop start, any other at 0.
    const first = looping ? Number(clip.props.loop_start) : 0;
    const end = looping ? Number(clip.props.loop_end) : Number(clip.props.end_marker);
    const loopLength = end - first;
    const elapsedFrom = Math.max(from, startedAt) - startedAt;
    const elapsedTo = to - startedAt;
    if (elapsedTo <= elapsedFrom || loopLength <= 0) continue;
    for (const note of clipNotes.get(clip.id) ?? []) {
      if (note.mute || note.start_time < first || note.start_time >= end) continue;
      const offset = note.start_time - first;
      const duration = Math.min(note.duration, end - note.start_time);
      const pass = looping ? Math.max(0, Math.ceil((elapsedFrom - offset) / loopLength - 1e-9)) : 0;
      for (let k = pass; looping || k === 0; k++) {
        const elapsed = offset + k * loopLength;
        if (elapsed >= elapsedTo - 1e-9) break;
        if (elapsed < elapsedFrom - 1e-9) continue;
        const beat = startedAt + elapsed;
        bandQueue.push(
          { deviceId: input.id, pitch: note.pitch, velocity: note.velocity, beat },
          { deviceId: input.id, pitch: note.pitch, velocity: 0, beat: beat + duration }
        );
      }
    }
  }
};

/** Drops what a track's MIDI inputs had queued from `at` on and ends their sounding notes there. */
const cutInputNotes = (trackId: number, at: number) => {
  const inputs = new Set(inputDevices().filter((input) => input.kind === "midi" && input.trackId === trackId).map((input) => input.id));
  if (!inputs.size) return;
  bandQueue = bandQueue.filter((event) => !inputs.has(event.deviceId) || event.beat < at);
  sounding.forEach((event) => {
    if (inputs.has(event.deviceId)) bandQueue.push({ ...event, velocity: 0, beat: at });
  });
};

const allNotesOff = () => {
  const time = Number(song.props.current_song_time);
  sounding.forEach((event) => sendNote({ ...event, velocity: 0, beat: time }));
  sounding.clear();
  audioPitch.clear();
  bandQueue = [];
};

// Audio inputs: a pitch reading every 10 ms, with a little vibrato, and a noise floor between notes.
setInterval(() => {
  if (!song.props.is_playing || !bandOn) return;
  const beat = songTimeNow();
  for (const input of inputDevices()) {
    if (input.kind !== "audio") continue;
    const pitch = audioPitch.get(input.id);
    const hz = pitch === undefined ? 80 + Math.random() * 2000 : 440 * 2 ** ((pitch - 69) / 12) * (1 + 0.003 * Math.sin(beat * 20));
    const amplitude = pitch === undefined ? 0.001 : 0.2;
    udp.send(oscMessage("/sp/pitch", [["i", input.id], ["f", hz], ["f", amplitude], ["f", beat * TICKS_PER_BEAT]]), OSC_PORT, "127.0.0.1");
  }
}, 10);

/** Schedules the scripted band's bars as the song reaches them. */
const scheduleBand = (time: number) => {
  const bar = Math.floor(time / beatsPerBar() + 1e-9);
  if (bandScheduledBar < bar - 1 || bandScheduledBar > bar + 1) bandScheduledBar = bar - 1;
  while (bandScheduledBar < bar + 1) {
    bandScheduledBar++;
    bandQueue.push(...bandBar(bandScheduledBar));
  }
};

/** Sends the queued notes that are due by `time`. */
const sendDue = (time: number) => {
  bandQueue.sort((a, b) => a.beat - b.beat);
  while (bandQueue.length && bandQueue[0].beat <= time) {
    const event = bandQueue.shift()!;
    const key = `${event.deviceId}:${event.pitch}`;
    if (event.velocity) sounding.set(key, event);
    else if (!sounding.delete(key)) continue;
    sendNote(event);
  }
};

/** The Session Voice devices in the set, with whether they're on. */
const voiceDevices = () => {
  const found: { id: number; on: boolean; trackName: string }[] = [];
  objects.forEach((obj) => {
    if (obj.kind !== "device") return;
    const on = (obj.children.parameters ?? []).map((id) => objects.get(id)!).find((param) => param.props.name === "SPV On");
    if (!on) return;
    found.push({ id: obj.id, on: !!obj.props.is_active && Number(on.props.value) >= 1, trackName: String(parentOf(obj)?.props.name ?? "") });
  });
  return found;
};

/** Each Session Voice device's last take number, as its counter in Max keeps it. */
const voiceTakes = new Map<number, number>();

setInterval(() => {
  inputDevices().forEach((input) => udp.send(oscMessage("/sp/hello", [["i", input.id], ["s", input.kind]]), OSC_PORT, "127.0.0.1"));
  voiceDevices().forEach((voice) => udp.send(oscMessage("/sp/hello", [["i", voice.id], ["s", "voice"]]), OSC_PORT, "127.0.0.1"));
}, 2000);

// ---- Song clock ----

let wasPlaying = false;

setInterval(() => {
  const now = performance.now();
  const seconds = (now - lastTick) / 1000;
  lastTick = now;
  if (!song.props.is_playing) {
    if (wasPlaying) allNotesOff();
    wasPlaying = false;
    return;
  }
  wasPlaying = true;

  const previous = Number(song.props.current_song_time);
  let time = previous + (Number(song.props.tempo) / 60) * seconds;
  const loopStart = Number(song.props.loop_start);
  const loopLength = Number(song.props.loop_length);
  const loopEnd = loopStart + loopLength;
  const wrapped = !!song.props.loop && previous < loopEnd && time >= loopEnd;
  if (wrapped) time = loopStart + ((time - loopEnd) % loopLength);

  // Clips launch and stop on their quantization points.
  const due = (at: number) => (wrapped ? at >= previous || at <= time : at > previous - 1e-9 && at <= time);
  stops.forEach((at, trackId) => {
    if (!due(at)) return;
    stops.delete(trackId);
    stopClip(trackId);
  });
  launches.forEach(({ slot, at }, trackId) => {
    if (due(at)) startClip(objects.get(trackId)!, slot, at);
  });
  playing.forEach((current, trackId) => {
    const position = clipPosition(current, time);
    current.clip.props.playing_position = position;
    if (!current.clip.props.looping && position >= Number(current.clip.props.end_marker)) stopClip(trackId);
  });

  update(song, "current_song_time", time);
  const bar = beatsPerBar();
  if (wrapped || Math.floor(time / bar + 1e-9) !== Math.floor(previous / bar + 1e-9)) logBar(Math.floor(time / bar + 1e-9) * bar);
  if (wrapped) allNotesOff();
  // Clip time doesn't follow the arrangement loop back, so a wrap skips a tick.
  else forwardClips(previous, time);
  if (bandOn) scheduleBand(time);
  sendDue(time);
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

const setBandChords = (list: string) => {
  const symbols = list.split(",").map((symbol) => symbol.trim());
  const chords = symbols.map((symbol) => parseChord(symbol) ?? reject(`Can't read chord "${symbol}"; use e.g. Am7, Fmaj7, G7, C`));
  bandSymbols = symbols;
  bandChords = chords;
};

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
    songMethods.start_playing(song, []);
    return "playing";
  },
  stop: () => {
    songMethods.stop_playing(song, []);
    return "stopped";
  },
  tempo: (query) => {
    setProp(song, "tempo", requireParam(query, "bpm"));
    return `tempo ${song.props.tempo}`;
  },
  // Like singing into the Session Voice device: macOS's speech voice records the
  // take where the device would, and the server is told it's ready.
  say: (query) => {
    const text = requireParam(query, "text");
    const voice = voiceDevices()[0] ?? reject("No Session Voice device in the set");
    if (!voice.on) return `Session Voice on ${voice.trackName} is off; nothing recorded`;
    const take = voiceTakes.get(voice.id) ?? 0;
    voiceTakes.set(voice.id, take + 1);
    const file = `/tmp/session-voice-${voice.id}-${take}.wav`;
    // The system's default voice can render to silence; Samantha always speaks.
    const speak = Bun.spawnSync(["say", "-v", query.get("voice") ?? "Samantha", "-o", file, "--data-format=LEI16@48000", text]);
    if (speak.exitCode !== 0) reject(`say failed: ${speak.stderr.toString().trim()}`);
    udp.send(oscMessage("/sp/voice", [["i", voice.id], ["i", take]]), OSC_PORT, "127.0.0.1");
    return `${voice.trackName} said "${text}" (take ${take})`;
  },
  "band-start": () => {
    bandOn = true;
    return `band on: ${bandChords.length}-chord loop`;
  },
  "band-stop": () => {
    bandOn = false;
    allNotesOff();
    return "band off";
  },
  "band-chords": (query) => {
    setBandChords(requireParam(query, "chords"));
    return `band chords: ${bandSymbols.join(" ")}`;
  },
  "band-clips": (query) => {
    if (query.has("chords")) setBandChords(requireParam(query, "chords"));
    const index = indexParam(query, "slot", 0);
    const length = beatsPerBar();
    const written: string[] = [];
    for (const input of inputDevices()) {
      const track = input.kind === "midi" && input.trackId !== undefined ? objects.get(input.trackId) : undefined;
      const notes = bandChords.flatMap((chord, bar) =>
        partNotes(input.role, chord, length).map((note) => ({ ...note, start_time: bar * length + note.start }))
      );
      if (!track || !notes.length) continue;
      const slot = objects.get(track.children.clip_slots?.[index] ?? -1) ?? reject(`No slot ${index} on ${describe(track)}`);
      const clipLength = bandChords.length * length;
      const existing = clipIn(slot);
      // A clip of the same length is edited in place, so one that's playing plays on.
      if (existing && Number(existing.props.length) === clipLength) clipMethods.remove_notes_extended(existing, [0, 128, 0, clipLength + 1]);
      else {
        if (existing) slotMethods.delete_clip(slot, []);
        slotMethods.create_clip(slot, [clipLength]);
      }
      const clip = clipIn(slot)!;
      clipMethods.add_new_notes(clip, [{ notes }]);
      update(clip, "name", `Band ${bandSymbols.join(" ")}`);
      written.push(`${track.props.name} slot ${index + 1}`);
    }
    if (!written.length) reject("No MIDI track has a Session Input with a Bass, Chords or Melody role");
    return `band clips (${bandSymbols.join(" ")}): ${written.join(", ")}`;
  },
  scene: (query) => {
    const index = indexParam(query, "scene", 0);
    // Launched while stopped, every clip starts together with the transport.
    const startAt = song.props.is_playing ? undefined : Number(song.props.current_song_time);
    const tracks = song.children.tracks.map((id) => objects.get(id)!).filter((track) => track.children.clip_slots?.[index]);
    if (!tracks.length) reject(`No scene ${index}`);
    tracks.forEach((track) => launch(objects.get(track.children.clip_slots[index])!, undefined, startAt));
    return `launched scene ${index + 1}`;
  },
  fire: (query) => {
    const track = trackParam(query);
    const index = indexParam(query, "slot", 0);
    const slot = objects.get(track.children.clip_slots?.[index] ?? -1) ?? reject(`No slot ${index} on ${describe(track)}`);
    launch(slot);
    return `fired slot ${index + 1} on ${describe(track)}`;
  },
  clips: () => {
    const lines: string[] = [];
    song.children.tracks.forEach((trackId) => {
      const track = objects.get(trackId)!;
      const slots = (track.children.clip_slots ?? []).map((id) => objects.get(id)!);
      const filled = slots.filter((slot) => clipIn(slot));
      if (!filled.length) return;
      lines.push(`${track.props.name} (playing slot ${Number(track.props.playing_slot_index) + 1 || "none"})`);
      filled.forEach((slot) => {
        const clip = clipIn(slot)!;
        const notes = clipNotes.get(clip.id) ?? [];
        const state = clip.props.is_playing ? " playing" : clip.props.is_triggered ? " triggered" : "";
        lines.push(`  slot ${slotIndex(slot) + 1}: "${clip.props.name}" ${clip.props.length} beats, ${notes.length} notes${state}`);
      });
    });
    return lines.join("\n") || "no clips";
  },
  param: (query) => {
    const target = deviceParam(query, trackParam(query));
    const name = requireParam(query, "name");
    const param = (target.children.parameters ?? []).map((id) => objects.get(id)!).find((p) => p.props.name === name);
    if (!param) reject(`${describe(target)} has no parameter "${name}"`);
    setProp(param!, "value", requireParam(query, "value"));
    return `${name} = ${param!.props.value} on ${describe(target)}`;
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
    "  clips          every clip slot with a clip, and what's playing",
    "  param          track, device, name=<parameter>, value",
    "  say            text, [voice=Samantha]: speak into the Session Voice device (macOS say)",
    "  band-start     the scripted band sends Session Input notes while playing",
    "  band-stop      silence the scripted band",
    "  band-chords    chords=Am7,Fmaj7,C,G (one per bar, looped)",
    "  band-clips     [chords], [slot=0]: the band's parts as looping clips on its MIDI tracks",
    "  scene          scene=<index>: fire that slot on every track (stopped: starts together)",
    "  fire           track, slot: fire one clip slot",
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

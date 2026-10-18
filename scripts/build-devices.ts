/**
 * Builds the Session Player's Max for Live devices into devices/*.amxd.
 *
 *   bun run build:devices
 *
 * The devices are deliberately thin: Session Player only holds settings (as
 * Live parameters the server reads through the Live API), and the two Session
 * Input devices forward what a track plays to the server over OSC/UDP. All the
 * logic lives in the server, where it can be tested.
 *
 * Each device is described here as Max boxes and patch cords, written out as an
 * unfrozen .amxd: an "ampf" chunk with the device type, a "meta" chunk, and a
 * "ptch" chunk holding the patcher JSON (the layout Ableton's own templates use).
 */
import fs from "fs";
import path from "path";

const OUT = path.join(import.meta.dir, "..", "devices");
const OSC_PORT = 9101;

type Rect = [number, number, number, number];

interface Box {
  id: string;
  maxclass: string;
  numinlets: number;
  numoutlets: number;
  outlettype?: string[];
  patching_rect: Rect;
  [key: string]: unknown;
}

type Cord = [from: Box, outlet: number, to: Box, inlet: number];

const MIDI_EFFECT = { tag: "mmmm", amxdtype: 1835887981 };
const AUDIO_EFFECT = { tag: "aaaa", amxdtype: 1633771873 };

/** Collects one device's boxes and cords. */
const patch = () => {
  const boxes: Box[] = [];
  const cords: Cord[] = [];
  let count = 0;
  let y = 20;
  const add = (box: Omit<Box, "id" | "patching_rect"> & { patching_rect?: Rect }) => {
    const full = { id: `obj-${++count}`, patching_rect: [20, (y += 30), 200, 22] as Rect, ...box } as Box;
    boxes.push(full);
    return full;
  };

  /** A plain Max object, with its inlet count and outlet types. */
  const object = (text: string, inlets: number, outlets: string[]) =>
    add({ maxclass: "newobj", text, numinlets: inlets, numoutlets: outlets.length, outlettype: outlets });

  const message = (text: string) => add({ maxclass: "message", text, numinlets: 2, numoutlets: 1, outlettype: [""] });

  const comment = (text: string, presentation: Rect, extra: Record<string, unknown> = {}) =>
    add({
      maxclass: "live.comment",
      text,
      numinlets: 1,
      numoutlets: 0,
      presentation: 1,
      presentation_rect: presentation,
      textjustification: 0,
      ...extra,
    });

  /**
   * A Live parameter control. The server finds Session devices by these names,
   * so the short name is the long name too: whichever one Live reports matches.
   */
  const control = (
    maxclass: "live.tab" | "live.menu" | "live.numbox" | "live.text" | "live.dial",
    longname: string,
    valueof: Record<string, unknown>,
    presentation: Rect,
    extra: Record<string, unknown> = {}
  ) => {
    const outlets = maxclass === "live.text" || maxclass === "live.numbox" || maxclass === "live.dial" ? ["", "float"] : ["", "", "float"];
    return add({
      maxclass,
      numinlets: 1,
      numoutlets: outlets.length,
      outlettype: outlets,
      parameter_enable: 1,
      presentation: 1,
      presentation_rect: presentation,
      varname: longname.replace(/\s+/g, "_"),
      saved_attribute_attributes: {
        valueof: {
          parameter_linknames: 1,
          parameter_longname: longname,
          parameter_shortname: longname,
          parameter_initial_enable: 1,
          ...valueof,
        },
      },
      ...extra,
    });
  };

  const connect = (...cord: Cord) => cords.push(cord);

  return { boxes, cords, object, message, comment, control, connect };
};

type Patch = ReturnType<typeof patch>;

const enumParam = (items: string[], initial: number) => ({
  parameter_type: 2,
  parameter_enum: items,
  parameter_mmax: items.length - 1,
  parameter_initial: [initial],
});

const intParam = (min: number, max: number, initial: number) => ({
  parameter_type: 1,
  parameter_mmin: min,
  parameter_mmax: max,
  parameter_initial: [initial],
  parameter_unitstyle: 0,
});

const onOff = (p: Patch, longname: string, presentation: Rect) =>
  p.control("live.text", longname, { ...enumParam(["Off", "On"], 1), parameter_defer: 1 }, presentation, {
    text: "Off",
    texton: "On",
    automation: "Off",
    automationon: "On",
    prototypename: "onoff",
  });

/**
 * Looks up the device's own Live API id once it's loaded, and keeps the OSC
 * messages' leading arguments ("/sp/note <id>", ...) set to it.
 */
const deviceId = (p: Patch, targets: { prefix: Box; address: string }[], hello: Box) => {
  const thisDevice = p.object("live.thisdevice", 1, ["bang", "int", "int"]);
  const devicePath = p.object("live.path this_device", 1, ["", "", ""]);
  const id = p.object("route id", 2, ["", ""]);
  p.connect(thisDevice, 0, devicePath, 0);
  p.connect(devicePath, 0, id, 0);
  for (const { prefix, address } of targets) {
    const set = p.object(`prepend set ${address}`, 2, [""]);
    p.connect(id, 0, set, 0);
    p.connect(set, 0, prefix, 0);
  }
  p.connect(id, 0, hello, 0);
};

/** "/sp/hello <id> <kind>" every 2 seconds, so the server can show the input as connected. */
const heartbeat = (p: Patch, kind: "midi" | "audio", udp: Box) => {
  const kindArg = p.object(`append ${kind}`, 2, [""]);
  const set = p.object("prepend set /sp/hello", 2, [""]);
  const text = p.message(`/sp/hello 0 ${kind}`);
  const metro = p.object("metro 2000 @active 1", 2, ["bang"]);
  p.connect(kindArg, 0, set, 0);
  p.connect(set, 0, text, 0);
  p.connect(metro, 0, text, 0);
  p.connect(text, 0, udp, 0);
  return kindArg;
};

const sessionPlayer = () => {
  const p = patch();
  const midiIn = p.object("midiin", 1, ["int"]);
  const midiOut = p.object("midiout", 1, []);
  p.connect(midiIn, 0, midiOut, 0);

  p.comment("Session Player", [8, 4, 120, 18], { fontsize: 12, fontface: 1 });
  // "Auto" is last so devices saved before it existed keep their setting.
  p.control("live.tab", "SP Instrument", enumParam(["Drums", "Bass", "Keys", "Guitar", "Auto"], 4), [8, 26, 232, 20], {
    num_lines_patching: 1,
    num_lines_presentation: 1,
    annotation: "What this player plays. Auto follows the instrument after the device: a Drum Rack plays drums, a bass sound bass, a guitar sound guitar, anything else keys.",
  });
  onOff(p, "SP Active", [8, 54, 44, 18]);
  p.comment("Lookahead", [64, 54, 58, 18]);
  p.control("live.numbox", "SP Lookahead", intParam(1, 4, 1), [122, 55, 30, 15], {
    annotation: "How many bars ahead the player may decide. Raise it for slow decision models.",
  });
  p.comment("bars", [154, 54, 30, 18]);
  p.comment("Clip", [8, 80, 40, 18]);
  p.control("live.menu", "SP Length", enumParam(["1 bar", "2 bars", "4 bars"], 0), [48, 81, 64, 15], {
    annotation: "Length of each generated clip.",
  });
  p.comment("Energy", [124, 80, 44, 18]);
  p.control("live.menu", "SP Energy", enumParam(["Auto", ...Array.from({ length: 10 }, (_, i) => String(i + 1))], 0), [168, 81, 64, 15], {
    annotation: "Auto follows the band; a number fixes the intensity.",
  });
  p.comment("Join after", [8, 104, 58, 18]);
  p.control("live.numbox", "SP Join", intParam(0, 4, 1), [66, 105, 30, 15], {
    annotation: "Bars to listen after Play before joining.",
  });
  p.comment("bars", [98, 104, 30, 18]);
  p.comment("Decisions show in the web panel.", [8, 132, 232, 18], { textcolor: [0.6, 0.6, 0.63, 1] });
  return { name: "Session Player", type: MIDI_EFFECT, patch: p };
};

const sessionInput = () => {
  const p = patch();
  const midiIn = p.object("midiin", 1, ["int"]);
  const midiOut = p.object("midiout", 1, []);
  p.connect(midiIn, 0, midiOut, 0);

  p.comment("Session Input", [8, 4, 120, 18], { fontsize: 12, fontface: 1 });
  p.comment("Role", [8, 28, 40, 18]);
  p.control("live.menu", "SPI Role", enumParam(["Auto", "Bass", "Chords", "Melody", "Drums"], 0), [48, 29, 72, 15], {
    annotation: "What this track plays, for the Session Players listening to it.",
  });
  const on = onOff(p, "SPI On", [8, 52, 44, 18]);
  p.comment("Put first on the track.", [8, 76, 150, 18], { textcolor: [0.6, 0.6, 0.63, 1] });

  // Every note-on and note-off goes out as "/sp/note <id> <pitch> <velocity> <ticks>",
  // stamped with Live's song position at 480 ticks per quarter note.
  const parse = p.object("midiparse", 2, ["", "", "", "int", "int", "int", "int", ""]);
  const gate = p.object("gate 1 1", 2, [""]);
  const order = p.object("t l b", 1, ["", "bang"]);
  const transport = p.object("transport", 2, ["int", "int", "float", "float", "float", "", "int", "float", ""]);
  const split = p.object("unpack 0 0", 1, ["int", "int"]);
  const pack = p.object("pack 0 0 0.", 3, [""]);
  const prefix = p.object("prepend /sp/note 0", 2, [""]);
  const udp = p.object(`udpsend 127.0.0.1 ${OSC_PORT}`, 1, []);
  p.connect(midiIn, 0, parse, 0);
  p.connect(parse, 0, gate, 1);
  p.connect(on, 0, gate, 0);
  p.connect(gate, 0, order, 0);
  p.connect(order, 1, transport, 0);
  p.connect(transport, 7, pack, 2);
  p.connect(order, 0, split, 0);
  p.connect(split, 1, pack, 1);
  p.connect(split, 0, pack, 0);
  p.connect(pack, 0, prefix, 0);
  p.connect(prefix, 0, udp, 0);

  const hello = heartbeat(p, "midi", udp);
  deviceId(p, [{ prefix, address: "/sp/note" }], hello);
  return { name: "Session Input", type: MIDI_EFFECT, patch: p };
};

const sessionInputAudio = () => {
  const p = patch();
  const input = p.object("plugin~", 2, ["signal", "signal"]);
  const output = p.object("plugout~", 2, ["signal", "signal"]);
  p.connect(input, 0, output, 0);
  p.connect(input, 1, output, 1);

  p.comment("Session Input Audio", [8, 4, 150, 18], { fontsize: 12, fontface: 1 });
  p.comment("Role", [8, 28, 40, 18]);
  p.control("live.menu", "SPI Role", enumParam(["Auto", "Bass", "Chords", "Melody", "Drums"], 0), [48, 29, 72, 15], {
    annotation: "What this track plays, for the Session Players listening to it.",
  });
  const on = onOff(p, "SPI On", [8, 52, 44, 18]);
  p.control(
    "live.dial",
    "SPI Threshold",
    { parameter_type: 0, parameter_mmin: -70, parameter_mmax: 0, parameter_initial: [-40], parameter_unitstyle: 4 },
    [128, 26, 44, 40],
    { annotation: "Quieter sound than this doesn't count as a note.", showname: 0 }
  );
  p.comment("Threshold", [124, 66, 56, 18]);
  p.comment("One note at a time. Put first on the track.", [8, 80, 180, 30], { textcolor: [0.6, 0.6, 0.63, 1] });

  // Pitch tracking on the summed input. The server turns these readings into
  // notes, so the note logic can be tested and tuned without Max.
  const sum = p.object("+~", 2, ["signal"]);
  const half = p.object("*~ 0.5", 2, ["signal"]);
  const tracker = p.object("fzero~ @size 2048 @period 480 @freqmin 40 @freqmax 2000 @quiet 1", 2, ["float", "float", "bang"]);
  p.connect(input, 0, sum, 0);
  p.connect(input, 1, sum, 1);
  p.connect(sum, 0, half, 0);
  p.connect(half, 0, tracker, 0);

  // Every 10 ms: "/sp/pitch <id> <hz> <amplitude> <ticks>".
  const pitch = p.object("f", 2, ["float"]);
  const amplitude = p.object("f", 2, ["float"]);
  const metro = p.object("metro 10 @active 1", 2, ["bang"]);
  const gate = p.object("gate 1 1", 2, [""]);
  const order = p.object("t b b b", 1, ["bang", "bang", "bang"]);
  const transport = p.object("transport", 2, ["int", "int", "float", "float", "float", "", "int", "float", ""]);
  const pack = p.object("pack 0. 0. 0.", 3, [""]);
  const pitchPrefix = p.object("prepend /sp/pitch 0", 2, [""]);
  const udp = p.object(`udpsend 127.0.0.1 ${OSC_PORT}`, 1, []);
  p.connect(tracker, 0, pitch, 1);
  p.connect(tracker, 1, amplitude, 1);
  p.connect(metro, 0, gate, 1);
  p.connect(on, 0, gate, 0);
  p.connect(gate, 0, order, 0);
  p.connect(order, 2, transport, 0);
  p.connect(transport, 7, pack, 2);
  p.connect(order, 1, amplitude, 0);
  p.connect(amplitude, 0, pack, 1);
  p.connect(order, 0, pitch, 0);
  p.connect(pitch, 0, pack, 0);
  p.connect(pack, 0, pitchPrefix, 0);
  p.connect(pitchPrefix, 0, udp, 0);

  // Onsets: "/sp/onset <id> <ticks>", with their own transport so frames don't trigger them.
  const onsetGate = p.object("gate 1 1", 2, [""]);
  const onsetTransport = p.object("transport", 2, ["int", "int", "float", "float", "float", "", "int", "float", ""]);
  const onsetPrefix = p.object("prepend /sp/onset 0", 2, [""]);
  p.connect(tracker, 2, onsetGate, 1);
  p.connect(on, 0, onsetGate, 0);
  p.connect(onsetGate, 0, onsetTransport, 0);
  p.connect(onsetTransport, 7, onsetPrefix, 0);
  p.connect(onsetPrefix, 0, udp, 0);

  const hello = heartbeat(p, "audio", udp);
  deviceId(
    p,
    [
      { prefix: pitchPrefix, address: "/sp/pitch" },
      { prefix: onsetPrefix, address: "/sp/onset" },
    ],
    hello
  );
  return { name: "Session Input Audio", type: AUDIO_EFFECT, patch: p };
};

/** Patch cords must start at an outlet and end at an inlet the boxes really have. */
const validate = (name: string, { boxes, cords }: Patch) => {
  for (const [from, outlet, to, inlet] of cords) {
    if (!boxes.includes(from) || !boxes.includes(to)) throw new Error(`${name}: cord to a box that isn't in the patch`);
    if (outlet >= from.numoutlets) throw new Error(`${name}: ${from.text ?? from.maxclass} has no outlet ${outlet}`);
    if (inlet >= to.numinlets) throw new Error(`${name}: ${to.text ?? to.maxclass} has no inlet ${inlet}`);
  }
  const names = boxes.map((box) => (box.saved_attribute_attributes as any)?.valueof?.parameter_longname).filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error(`${name}: parameter names must be unique`);
};

const toPatcher = (name: string, type: typeof MIDI_EFFECT, { boxes, cords }: Patch) => ({
  patcher: {
    fileversion: 1,
    appversion: { major: 8, minor: 5, revision: 8, architecture: "x64", modernui: 1 },
    classnamespace: "box",
    rect: [100, 100, 760, 640],
    openrect: [0, 0, 0, 169],
    bglocked: 0,
    openinpresentation: 1,
    default_fontsize: 10,
    default_fontface: 0,
    default_fontname: "Arial Bold",
    gridonopen: 1,
    gridsize: [8, 8],
    gridsnaponopen: 1,
    objectsnaponopen: 1,
    statusbarvisible: 2,
    toolbarvisible: 1,
    lefttoolbarpinned: 0,
    toptoolbarpinned: 0,
    righttoolbarpinned: 0,
    bottomtoolbarpinned: 0,
    toolbars_unpinned_last_save: 0,
    tallnewobj: 0,
    boxanimatetime: 500,
    enablehscroll: 1,
    enablevscroll: 1,
    devicewidth: 0,
    description: "",
    digest: "",
    tags: "",
    style: "",
    subpatcher_template: "",
    title: name,
    boxes: boxes.map((box) => ({ box })),
    lines: cords.map(([from, outlet, to, inlet]) => ({
      patchline: { destination: [to.id, inlet], source: [from.id, outlet] },
    })),
    dependency_cache: [],
    latency: 0,
    project: {
      version: 1,
      creationdate: 3590052786,
      modificationdate: 3590052786,
      viewrect: [0, 0, 300, 500],
      autoorganize: 1,
      hideprojectwindow: 1,
      showdependencies: 1,
      autolocalize: 0,
      contents: { patchers: {} },
      layout: {},
      searchpath: {},
      detailsvisible: 0,
      amxdtype: type.amxdtype,
      readonly: 0,
      devpathtype: 0,
      devpath: ".",
      sortmode: 0,
      viewmode: 0,
    },
    autosave: 0,
  },
});

/** Packs patcher JSON as an unfrozen device: ampf, meta and ptch chunks, sizes little-endian. */
const toAmxd = (json: string, type: typeof MIDI_EFFECT) => {
  const body = new TextEncoder().encode(json);
  const chunk = (tag: string, data: Uint8Array) => {
    const out = new Uint8Array(8 + data.length);
    out.set(new TextEncoder().encode(tag), 0);
    new DataView(out.buffer).setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
  };
  const ptch = new Uint8Array(body.length + 1); // JSON plus a trailing NUL, like Max writes it
  ptch.set(body);
  const parts = [chunk("ampf", new TextEncoder().encode(type.tag)), chunk("meta", new Uint8Array(4)), chunk("ptch", ptch)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Reads a device back to check it round-trips. */
const readAmxd = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Record<string, Uint8Array> = {};
  for (let offset = 0; offset + 8 <= bytes.length; ) {
    const tag = new TextDecoder().decode(bytes.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    chunks[tag] = bytes.slice(offset + 8, offset + 8 + size);
    offset += 8 + size;
  }
  const json = new TextDecoder().decode(chunks.ptch.slice(0, -1));
  return { type: new TextDecoder().decode(chunks.ampf), patcher: JSON.parse(json).patcher };
};

fs.mkdirSync(OUT, { recursive: true });
for (const device of [sessionPlayer(), sessionInput(), sessionInputAudio()]) {
  validate(device.name, device.patch);
  const json = JSON.stringify(toPatcher(device.name, device.type, device.patch), null, "\t");
  const bytes = toAmxd(json, device.type);
  const file = path.join(OUT, `${device.name}.amxd`);
  fs.writeFileSync(file, bytes);
  const back = readAmxd(new Uint8Array(fs.readFileSync(file)));
  if (back.type !== device.type.tag || back.patcher.project.amxdtype !== device.type.amxdtype) {
    throw new Error(`${device.name}: device type didn't survive the round trip`);
  }
  const params = back.patcher.boxes
    .map((b: { box: Box }) => (b.box.saved_attribute_attributes as any)?.valueof?.parameter_longname)
    .filter(Boolean);
  console.log(`${path.relative(process.cwd(), file)}: ${back.patcher.boxes.length} boxes, ${back.patcher.lines.length} cords, parameters ${params.join(", ")}`);
}

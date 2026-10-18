/**
 * End-to-end check of the Session Player against the mock: starts the mock
 * and the server, has the band play, and compares the chord of every clip the
 * AI Guitar fires with the chord the band plays in that bar.
 *
 *   bun run jam-check                     # band from clips, 120 BPM
 *   bun run jam-check -- --band live --tempo 80,120,160 --bars 12
 *   bun run jam-check -- --log            # also print the mock's per-bar clip log
 *   bun run jam-check -- --edit 6:Dm7,G7,Cmaj7,Am7
 *
 * --edit rewrites the band's clips in place a quarter into the given bar, the
 * way someone editing the notes would; from the next bar on the guitar should
 * follow the new chords.
 *
 * --band clips: the band's parts are clips on Bass and Keys, so the player can
 * read ahead. --band live: the scripted band plays them, and the player only
 * knows what it has heard. It runs on its own ports (LIVE_PORT 9201,
 * SESSION_OSC_PORT 9202, PORT 3201, SESSION_WHISPER_PORT 9203 unless set),
 * next to Live or a running mock.
 */
import type { Subprocess } from "bun";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    band: { type: "string", default: "clips" },
    tempo: { type: "string", default: "120" },
    bars: { type: "string", default: "10" },
    chords: { type: "string", default: "Am7,Fmaj7,C,G" },
    log: { type: "boolean", default: false },
    edit: { type: "string" },
  },
});

const LIVE_PORT = process.env.LIVE_PORT || "9201";
const OSC_PORT = process.env.SESSION_OSC_PORT || "9202";
const PORT = process.env.PORT || "3201";
const WHISPER_PORT = process.env.SESSION_WHISPER_PORT || "9203";
const MOCK = `http://127.0.0.1:${LIVE_PORT}/mock`;
const root = new URL("..", import.meta.url).pathname;

const band = values.band === "live" ? "live" : "clips";
const tempos = values.tempo!.split(",").map(Number);
const bars = Number(values.bars);
const chords = values.chords!.split(",");
const [editBar, editChords] = values.edit ? [Number(values.edit.split(":")[0]), values.edit.split(":")[1].split(",")] : [];
if (editBar && band !== "clips") throw new Error("--edit needs --band clips");
/** The band's chord in a bar; the bar of the edit itself is a mix of both. */
const bandChord = (bar: number) => {
  if (!editBar || !editChords || bar < editBar) return chords[(bar - 1) % chords.length];
  return bar === editBar ? undefined : editChords[(bar - 1) % editChords.length];
};

const control = async (query: string) => {
  const response = await fetch(`${MOCK}?${query}`);
  const text = (await response.text()).trim();
  if (!response.ok) throw new Error(`mock ${query}: ${text}`);
  return text;
};

/** Collects a process's output lines and resolves when one matches. */
const lines = (process: Subprocess<"ignore", "pipe", "inherit">) => {
  const seen: string[] = [];
  const waiters: { pattern: RegExp; resolve: () => void }[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    const reader = process.stdout.getReader();
    let buffer = "";
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      buffer += decoder.decode(read.value);
      const parts = buffer.split("\n");
      buffer = parts.pop()!;
      for (const line of parts) {
        seen.push(line);
        waiters.filter((w) => w.pattern.test(line)).forEach((w) => w.resolve());
      }
    }
  })();
  const waitFor = (pattern: RegExp, ms = 10000) =>
    new Promise<void>((resolve, reject) => {
      if (seen.some((line) => pattern.test(line))) return resolve();
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), ms);
      waiters.push({ pattern, resolve: () => (clearTimeout(timer), resolve()) });
    });
  return { seen, waitFor };
};

/** Waits until the server has subscribed to everything: the observer count stops changing. */
const waitForServer = async () => {
  let last = -1;
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(300);
    const { observers } = JSON.parse(await control("action=state"));
    if (observers > 50 && observers === last) return observers as number;
    last = observers;
  }
  throw new Error("The server didn't connect to the mock");
};

const run = async (tempo: number) => {
  const env = {
    ...process.env,
    LIVE_PORT,
    MOCK_OSC_PORT: OSC_PORT,
    SESSION_OSC_PORT: OSC_PORT,
    PORT,
    SESSION_WHISPER_PORT: WHISPER_PORT,
    SESSION_PROVIDER: "local",
  };
  const mock = Bun.spawn(["bun", "scripts/mock-live.ts"], { cwd: root, env, stdout: "pipe", stderr: "inherit" });
  const mockOutput = lines(mock);
  let server: Subprocess | undefined;
  let warnings: string[] = [];
  try {
    await mockOutput.waitFor(/LiveAPI bridge mock on/);
    server = Bun.spawn(["bun", "src/server/index.ts"], { cwd: root, env, stdout: "ignore", stderr: "inherit" });
    await waitForServer();

    await control(`action=tempo&bpm=${tempo}`);
    if (band === "clips") {
      await control(`action=band-clips&chords=${chords.join(",")}`);
      // Launched while stopped, the scene starts the transport with every clip on bar 1.
      await control("action=scene&scene=0");
    } else {
      await control(`action=band-chords&chords=${chords.join(",")}`);
      await control("action=play");
    }
    const msPerBar = (4 * 60000) / tempo;
    const started = performance.now();
    if (editBar && editChords) {
      await Bun.sleep(msPerBar * (editBar - 0.75));
      await control(`action=band-clips&chords=${editChords.join(",")}`);
    }
    await Bun.sleep(msPerBar * (bars + 0.5) - (performance.now() - started));
    // The mock warns about anything real Live would log an error for.
    warnings = JSON.parse(await control("action=state")).warnings;
    await control("action=stop");
  } finally {
    server?.kill();
    mock.kill();
    await Promise.all([server?.exited, mock.exited]);
  }

  // [clip] bar 3 | AI Guitar | "SP 3 strum C e5" (slot 6) | C4@0 ...
  const guitar = new Map<number, string>();
  for (const line of mockOutput.seen) {
    const match = /^\[clip\] bar (\d+) \| AI Guitar \| "SP \d+ \S+ (\S+?)…? e\d+/.exec(line);
    if (match) guitar.set(Number(match[1]), match[2]);
  }
  const results = Array.from({ length: bars }, (_, i) => ({ bar: i + 1, expected: bandChord(i + 1), played: guitar.get(i + 1) }));
  const played = results.filter((r) => r.played && r.expected);
  const wrong = played.filter((r) => r.played !== r.expected);
  const missing = results.filter((r) => r.bar >= 2 && !r.played);
  const lastWrong = wrong.length ? Math.max(...wrong.map((r) => r.bar)) : 0;
  const rightFrom = played.length ? (wrong.length ? lastWrong + 1 : Math.min(...played.map((r) => r.bar))) : undefined;

  console.log(`\n${tempo} BPM, band from ${band}`);
  if (values.log) mockOutput.seen.filter((line) => line.startsWith("[clip]")).forEach((line) => console.log(`  ${line}`));
  const verdict = (r: (typeof results)[number]) => (!r.played ? "" : !r.expected ? "(edited)" : r.played === r.expected ? "ok" : "WRONG");
  console.log(
    results
      .map((r) => `  bar ${String(r.bar).padStart(2)}  band ${(r.expected ?? "edit").padEnd(6)} guitar ${(r.played ?? "–").padEnd(6)} ${verdict(r)}`)
      .join("\n")
  );
  console.log(`  right from bar ${rightFrom ?? "–"}; ${wrong.length} wrong, ${missing.length} bars without a guitar clip`);
  warnings.forEach((warning) => console.log(`  mock warning: ${warning}`));
  return { tempo, rightFrom, wrong: wrong.length, missing: missing.length, warnings: warnings.length };
};

const summary = [];
for (const tempo of tempos) summary.push(await run(tempo));
console.log(`\nSummary (band from ${band}):`);
summary.forEach((s) =>
  console.log(`  ${s.tempo} BPM: right from bar ${s.rightFrom ?? "–"}, ${s.wrong} wrong, ${s.missing} missing, ${s.warnings} mock warnings`)
);
const passed = summary.every((s) => s.rightFrom !== undefined && !s.missing && !s.warnings && (band === "live" || s.rightFrom <= 2));
process.exit(passed ? 0 : 1);

import fs from "fs/promises";
import path from "path";
import type { Subprocess } from "bun";
import { TranscriberState } from "common";
import { SessionConfig } from "./config";

/**
 * Where a Session Voice device records take `take`. The device builds the same
 * path; the server only ever reads and deletes files of this form.
 */
export const voiceFile = (deviceId: number, take: number) => `/tmp/session-voice-${deviceId}-${take}.wav`;

/** Shorter recordings are clicks and breaths. */
const MIN_SECONDS = 0.3;
const READY_POLL_MS = 250;
const START_TIMEOUT_MS = 30000;
const SETTLE_POLL_MS = 60;
const SETTLE_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 20000;
/** Segments Whisper itself rates this likely to be silence are dropped. */
const MAX_NO_SPEECH = 0.6;
/** The decision model reads every phrase each bar; a runaway transcript is cut. */
export const MAX_SPEECH_LENGTH = 200;
/** What Whisper writes for noise and music it can't make out, when that's all there is. */
const NOISE_PHRASES = /^(you|thanks for watching|thank you for watching|please subscribe|like and subscribe|subtitles by .*)$/;

export interface WhisperSegment {
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

export interface WhisperResult {
  text: string;
  segments?: WhisperSegment[];
}

/**
 * The words in a whisper-server answer, without the segments it wasn't sure
 * were speech, sound tags like [BLANK_AUDIO] or (music), or its stock phrases
 * for noise. Undefined when nothing is left.
 */
export const cleanTranscript = (result: WhisperResult, minLogprob = -1) => {
  const segments = result.segments?.length ? result.segments : [{ text: result.text }];
  const kept = segments.filter((segment) => (segment.no_speech_prob ?? 0) <= MAX_NO_SPEECH && (segment.avg_logprob ?? 0) >= minLogprob);
  const text = kept
    .map((segment) => segment.text)
    .join(" ")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[a-z]/i.test(text)) return undefined;
  const bare = text.toLowerCase().replace(/[^a-z' ]/g, "").replace(/\s+/g, " ").trim();
  if (NOISE_PHRASES.test(bare)) return undefined;
  return text.length > MAX_SPEECH_LENGTH ? `${text.slice(0, MAX_SPEECH_LENGTH - 1)}…` : text;
};

/** "RIFF"…"WAVE" for WAV, "FORM" for AIFF (which whisper-server can't read). */
const fourCC = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

/**
 * Seconds of audio in a WAV file, from its header and its size on disk. While
 * a file is still being written its data size can read 0, so the bytes
 * actually there count.
 */
export const wavSeconds = (header: Uint8Array, fileSize: number) => {
  if (header.length < 12 || fourCC(header, 0) !== "RIFF" || fourCC(header, 8) !== "WAVE") return undefined;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= header.length; ) {
    const id = fourCC(header, offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 20 <= header.length) byteRate = view.getUint32(offset + 16, true);
    if (id === "data") {
      const present = Math.max(fileSize - offset - 8, 0);
      const bytes = size > 0 && size <= present ? size : present;
      return byteRate ? bytes / byteRate : undefined;
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the device has finished writing the file: its size stops changing. */
const settle = async (file: string) => {
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  let last = -1;
  while (performance.now() < deadline) {
    const size = await fs.stat(file).then((stat) => stat.size, () => -1);
    if (size > 44 && size === last) return size;
    last = size;
    await sleep(SETTLE_POLL_MS);
  }
  return last > 44 ? last : undefined;
};

const readHeader = async (file: string) => {
  const handle = await fs.open(file, "r");
  try {
    const header = new Uint8Array(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/** macOS's own converter, for a device that wrote AIFF instead of WAV. */
const aiffToWav = async (file: string) => {
  const out = `${file}.converted.wav`;
  const convert = Bun.spawn(["afconvert", "-f", "WAVE", "-d", "LEI16", file, out], { stdout: "ignore", stderr: "ignore" });
  if ((await convert.exited) !== 0) throw new Error("afconvert couldn't convert the recording to WAV");
  return out;
};

/**
 * Speech to text for the Session Voice devices, on this machine: runs
 * whisper.cpp's whisper-server with a small English model and sends it each
 * recorded phrase. It's started the first time a Session Voice device shows
 * up, and a whisper-server already listening on the port is used as is.
 */
export class Transcriber {
  state: TranscriberState = { status: "off" };
  private child?: Subprocess<"ignore", "ignore", "pipe">;
  private ready?: Promise<boolean>;
  private stopping = false;

  constructor(private config: SessionConfig["voice"], private onChange: () => void) {}

  /** Starts whisper-server unless it's running; resolves to whether it's usable. */
  ensureStarted = () => {
    this.ready ??= this.launch();
    return this.ready;
  };

  /**
   * The phrase in a take the device recorded, or undefined when it's empty,
   * noise, or speech-to-text isn't available. The file is deleted either way.
   */
  transcribe = async (file: string): Promise<string | undefined> => {
    const temporary = [file];
    try {
      if (!(await this.ensureStarted())) return undefined;
      const size = await settle(file);
      if (size === undefined) return undefined;
      let upload = file;
      let header = await readHeader(file);
      if (fourCC(header, 0) === "FORM") {
        upload = await aiffToWav(file);
        temporary.push(upload);
        header = await readHeader(upload);
      }
      const seconds = wavSeconds(header, upload === file ? size : (await fs.stat(upload)).size);
      if (seconds === undefined || seconds < MIN_SECONDS) return undefined;

      const form = new FormData();
      form.append("file", Bun.file(upload), path.basename(upload));
      form.append("response_format", "verbose_json");
      form.append("temperature", "0.0");
      const response = await fetch(this.url("/inference"), { method: "POST", body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`whisper-server answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return cleanTranscript((await response.json()) as WhisperResult, this.config.minLogprob);
    } finally {
      await Promise.all(temporary.map((name) => fs.rm(name, { force: true })));
    }
  };

  private url = (pathname = "/") => `http://127.0.0.1:${this.config.port}${pathname}`;

  private isUp = async () => {
    try {
      return (await fetch(this.url(), { signal: AbortSignal.timeout(500) })).ok;
    } catch {
      return false;
    }
  };

  private set = (status: TranscriberState["status"], message?: string) => {
    if (this.state.status === status && this.state.message === message) return;
    this.state = { status, message };
    if (message) console.info(`[voice] ${message}`);
    this.onChange();
  };

  private launch = async () => {
    const { port } = this.config;
    if (await this.isUp()) {
      this.set("ready", `Using the whisper-server already on port ${port}.`);
      return true;
    }
    const binary = Bun.which(this.config.whisperServer) ?? Bun.which(this.config.whisperServer, { PATH: "/opt/homebrew/bin:/usr/local/bin" });
    if (!binary) {
      this.set("unavailable", "Speech-to-text needs whisper-server: brew install whisper-cpp");
      this.ready = undefined;
      return false;
    }
    const model = path.resolve(this.config.model);
    if (!(await Bun.file(model).exists())) {
      this.set("unavailable", `No speech model at ${this.config.model}; see the README to download it.`);
      this.ready = undefined;
      return false;
    }

    this.set("starting", "Loading the speech model…");
    const child = Bun.spawn([binary, "-m", model, "--host", "127.0.0.1", "--port", String(port), "--suppress-nst"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    this.child = child;
    this.stopWithServer();
    const lastLines = this.collectErrors(child);
    let exited = false;
    void child.exited.then((code) => {
      exited = true;
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      if (this.state.status === "ready") this.set("error", `whisper-server stopped (exit code ${code}); it restarts with the next phrase.`);
    });

    const deadline = performance.now() + START_TIMEOUT_MS;
    while (performance.now() < deadline) {
      if (await this.isUp()) {
        this.set("ready", `Speech-to-text ready (whisper-server on port ${port}).`);
        return true;
      }
      if (exited) break;
      await sleep(READY_POLL_MS);
    }
    child.kill();
    this.ready = undefined;
    const reason = lastLines().filter((line) => /error|fail|couldn't|unable|bind/i.test(line)).pop() ?? lastLines().pop();
    this.set("error", `whisper-server didn't start${reason ? `: ${reason}` : ""}`);
    return false;
  };

  /** Keeps whisper-server's last lines of output, skipping its long list of GPU details. */
  private collectErrors = (child: Subprocess<"ignore", "ignore", "pipe">) => {
    const lines: string[] = [];
    void (async () => {
      const decoder = new TextDecoder();
      let partial = "";
      const reader = child.stderr.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        const text = partial + decoder.decode(chunk.value, { stream: true });
        const parts = text.split("\n");
        partial = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim() || /^(ggml_|load_backend|whisper_|system_info)/.test(line)) continue;
          lines.push(line.trim());
          if (lines.length > 20) lines.shift();
        }
      }
    })().catch(() => {});
    return () => lines;
  };

  /** whisper-server would outlive the server and keep its port. */
  private stopWithServer = () => {
    if (this.stopping) return;
    this.stopping = true;
    const stop = () => this.child?.kill();
    process.once("exit", stop);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        stop();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  };
}

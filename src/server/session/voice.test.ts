import { describe, expect, test } from "bun:test";
import { cleanTranscript, voiceFile, wavSeconds } from "./voice";

/** A WAV header for `seconds` of mono 16-bit audio at `rate`, as the device writes it. */
const wavHeader = (rate: number, seconds: number, dataSize = Math.round(rate * 2 * seconds)) => {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => (header[offset + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataSize, true);
  return header;
};

describe("voice takes", () => {
  test("live in a fixed place per device and take", () => {
    expect(voiceFile(12, 3)).toBe("/tmp/session-voice-12-3.wav");
  });

  test("their length comes from the header, or the bytes there while it's still being written", () => {
    expect(wavSeconds(wavHeader(48000, 2), 44 + 48000 * 2 * 2)).toBeCloseTo(2);
    expect(wavSeconds(wavHeader(44100, 0, 0), 44 + 44100 * 2)).toBeCloseTo(1);
    expect(wavSeconds(new TextEncoder().encode("FORM....AIFF"), 4000)).toBeUndefined();
  });
});

describe("cleanTranscript", () => {
  const result = (...segments: [string, number?, number?][]) => ({
    text: segments.map(([text]) => text).join(""),
    segments: segments.map(([text, noSpeech = 0.01, logprob = -0.2]) => ({ text, no_speech_prob: noSpeech, avg_logprob: logprob })),
  });

  test("keeps what was said", () => {
    expect(cleanTranscript(result([" Okay, let's go. Give me a cue.\n"]))).toBe("Okay, let's go. Give me a cue.");
    expect(cleanTranscript(result([" under the city lights I keep on running,"], [" running home to you.\n"]))).toBe(
      "under the city lights I keep on running, running home to you."
    );
  });

  test("drops sound tags, unsure segments and Whisper's stock phrases for noise", () => {
    expect(cleanTranscript(result([" [BLANK_AUDIO]"]))).toBeUndefined();
    expect(cleanTranscript(result([" (guitar strumming) ♪ Are you ready? ♪"]))).toBe("Are you ready?");
    expect(cleanTranscript(result([" Thanks for watching!"]))).toBeUndefined();
    expect(cleanTranscript(result([" you"]))).toBeUndefined();
    expect(cleanTranscript(result([" Take it down."], [" Thank you.", 0.9]))).toBe("Take it down.");
    expect(cleanTranscript(result([" mumble", 0.1, -1.6]))).toBeUndefined();
    expect(cleanTranscript({ text: "" })).toBeUndefined();
  });

  test("a runaway transcript is cut short", () => {
    expect(cleanTranscript(result([` ${"la ".repeat(200)}`]))!.length).toBeLessThanOrEqual(200);
  });
});

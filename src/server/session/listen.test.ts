import { describe, expect, test } from "bun:test";
import { toBuffer } from "osc-min";
import { Recorder, parseOsc } from "./listen";

const packet = (address: string, args: { type: "integer" | "float" | "string"; value: number | string }[]) => {
  const view = toBuffer({ address, args } as Parameters<typeof toBuffer>[0]);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
};

describe("parseOsc", () => {
  test("reads a note with its song position", () => {
    const message = parseOsc(
      packet("/sp/note", [
        { type: "integer", value: 12 },
        { type: "integer", value: 60 },
        { type: "integer", value: 100 },
        { type: "float", value: 1920 },
      ])
    );
    expect(message).toEqual({ type: "note", deviceId: 12, pitch: 60, velocity: 100, beat: 4 });
  });

  test("reads pitch readings and onsets from audio inputs", () => {
    const reading = parseOsc(
      packet("/sp/pitch", [
        { type: "integer", value: 3 },
        { type: "float", value: 220 },
        { type: "float", value: 0.25 },
        { type: "float", value: 960 },
      ])
    );
    expect(reading).toEqual({ type: "pitch", deviceId: 3, hz: 220, amplitude: 0.25, beat: 2 });
    expect(parseOsc(packet("/sp/onset", [{ type: "integer", value: 3 }, { type: "float", value: 480 }]))).toEqual({
      type: "onset",
      deviceId: 3,
      beat: 1,
    });
  });

  test("reads a hello", () => {
    expect(parseOsc(packet("/sp/hello", [{ type: "integer", value: 7 }, { type: "string", value: "audio" }]))).toEqual({
      type: "hello",
      deviceId: 7,
      kind: "audio",
    });
  });

  test("ignores anything else", () => {
    expect(parseOsc(packet("/other", []))).toBeUndefined();
    expect(parseOsc(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("Recorder", () => {
  const inputs = [{ deviceId: 1, trackName: "Keys", role: "chords" as const }];
  const push = (recorder: Recorder, pitch: number, velocity: number, beat: number) =>
    recorder.push({ deviceId: 1, pitch, velocity, beat, receivedAt: performance.now() });

  test("cuts notes into bars and carries held notes over", () => {
    const recorder = new Recorder();
    push(recorder, 60, 90, 0);
    push(recorder, 60, 0, 1);
    push(recorder, 64, 80, 3);
    push(recorder, 64, 0, 5); // released in the next bar
    const first = recorder.closeBar(1, 0, 4, inputs);
    expect(first.inputs[0].notes).toEqual([
      { pitch: 60, start: 0, duration: 1, velocity: 90, held: false },
      { pitch: 64, start: 3, duration: 1, velocity: 80, held: false },
    ]);
    const second = recorder.closeBar(2, 4, 4, inputs);
    expect(second.inputs[0].notes).toEqual([{ pitch: 64, start: 0, duration: 1, velocity: 80, held: true }]);
  });

  test("keeps notes that belong to a later bar", () => {
    const recorder = new Recorder();
    push(recorder, 62, 90, 4.01); // arrives while bar 1 is still closing
    expect(recorder.closeBar(1, 0, 4, inputs).inputs[0].notes).toEqual([]);
    expect(recorder.closeBar(2, 4, 4, inputs).inputs[0].notes[0]).toMatchObject({ pitch: 62 });
  });

  test("peeks at the current bar without consuming it", () => {
    const recorder = new Recorder();
    push(recorder, 60, 90, 0.5);
    const partial = recorder.peekBar(1, 0, 4, inputs, 2);
    expect(partial).toMatchObject({ partial: true, beatsPerBar: 4 });
    expect(partial.inputs[0].notes[0]).toMatchObject({ pitch: 60, start: 0.5, duration: 1.5 });
    expect(recorder.closeBar(1, 0, 4, inputs).inputs[0].notes[0]).toMatchObject({ pitch: 60, duration: 3.5 });
  });
});

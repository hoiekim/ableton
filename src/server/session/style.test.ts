import { describe, expect, test } from "bun:test";
import { initialTransport } from "common";
import { analyzeBand } from "./analyze";
import { optionsFor } from "./patterns";
import { decideLocally } from "./providers";
import { describeState } from "./state";
import { energyBias, styleAffinity } from "./style";

const request = (direction: string, instrument: "drums" | "bass" | "keys" | "guitar" = "drums") => ({
  instrument,
  state: "",
  analysis: analyzeBand([]),
  patterns: optionsFor(instrument, undefined),
  targetBar: 6,
  phraseLength: 4,
  previous: { pattern: "backbeat", energy: 5 },
  barsSinceFill: 1,
  direction,
  seed: 3,
});

describe("style direction", () => {
  test("genre words favour the patterns of that genre", () => {
    expect(styleAffinity("disco house, four on the floor", "four-on-floor")).toBe(1);
    expect(styleAffinity("smoky late-night jazz", "walking")).toBe(1);
    expect(styleAffinity("smoky late-night jazz", "power-eighths")).toBe(0);
    expect(styleAffinity("", "backbeat")).toBe(0);
  });

  test("mood words move the energy", () => {
    expect(energyBias("intense and driving")).toBe(2);
    expect(energyBias("laid back and mellow")).toBe(-2);
    expect(energyBias("bossa nova")).toBe(0);
  });

  test("the local rules follow the direction over sticking with the current pattern", () => {
    expect(decideLocally(request("")).pattern).toBe("backbeat");
    expect(decideLocally(request("swing jazz")).pattern).toBe("shuffle");
    expect(decideLocally(request("walking jazz bass", "bass")).pattern).toBe("walking");
  });

  test("the decision model is told the direction first", () => {
    const text = describeState(analyzeBand([]), initialTransport, {
      instrument: "drums",
      targetBar: 3,
      phraseLength: 4,
      barsSinceFill: 2,
      direction: "funky 70s soul, laid back",
    });
    expect(text.split("\n")[0]).toBe('The musician wants: "funky 70s soul, laid back".');
  });
});

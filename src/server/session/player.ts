import { CompactNote, DecisionDetail, DecisionLog, Instrument, PlayerState, PlayerStatus, SpeechState, TransportState } from "common";
import { BandAnalysis } from "./analyze";
import { p90, slowest } from "./clock";
import { SessionConfig } from "./config";
import { ChordInfo, ClipNote, clamp, compactNote, hashString, seededRandom, triad } from "./music";
import { InstrumentProfile, STANDARD_KIT } from "./instrument";
import { ClipSlotInfo, LiveOps } from "./ops";
import { Option, optionsFor } from "./patterns";
import { Decision, DecisionProvider, DecisionRequest, decideLocally } from "./providers";
import { Asked, bandQuiet, fingerprint, reuseReason } from "./reuse";
import { describeState } from "./state";

export interface PlayerSettings {
  deviceId: number;
  trackId: number;
  trackName: string;
  /** 0xRRGGBB, used for the clips. */
  color: number;
  /** What it plays; "auto" follows the instrument loaded after the device. */
  instrument: Instrument | "auto";
  active: boolean;
  /** How many bars ahead a decision may be made. */
  lookahead: number;
  /** Clip length in bars. */
  length: number;
  /** Bars to listen after Play before joining. */
  join: number;
  energy: number | "auto";
}

export interface Timing {
  playing: boolean;
  /** Current bar, counted from when playback started (1-based). */
  bar: number;
  /** Estimated position within the current bar, in beats. */
  beatInBar: number;
  beatsPerBar: number;
  msPerBeat: number;
}

export interface PlayerDeps {
  config: SessionConfig;
  provider: DecisionProvider;
  ops: () => LiveOps | undefined;
  /** The band so far, including the bar in progress. */
  analyze: () => BandAnalysis;
  transport: () => TransportState;
  timing: () => Timing;
  /** The musician's style direction; empty when none. */
  direction: () => string;
  /** What was said or sung on the Session Voice tracks, newest first. */
  speech: () => SpeechState[];
  onChange: () => void;
}

/** What a player is offered and plays with, to review its patterns away from a jam. */
export interface PatternSource {
  settings: PlayerSettings;
  role: Instrument;
  profile?: InstrumentProfile;
  /** Its patterns, described for the loaded instrument as the decision model reads them. */
  options: Option[];
  provider: string;
}

/** A decision waiting to be written and fired. */
interface Prepared {
  bar: number;
  decision: Decision;
  request: DecisionRequest;
  decisionMs: number;
}

/** A bar being decided for, or decided and waiting for its turn to be written. */
interface Pending {
  bar: number;
  started: number;
  prepared?: Prepared;
}

/** The clip most recently fired. */
interface Playing {
  bar: number;
  length: number;
  pattern: string;
  energy: number;
  fill: boolean;
  slotIndex: number;
  /** What was rendered, to tell whether a new decision would sound the same. */
  signature: string;
  notes: CompactNote[];
}

/** Decisions kept for the web page: enough to fill its timeline. */
const MAX_LOG = 16;
/** Decisions whose full detail (request, answer) can be looked up. */
const MAX_DETAILS = 32;
/** Firing closer than this to the bar risks Live starting the clip a bar late. */
const MIN_FIRE_MS = 25;
/** The engine checks every 15 ms, so a decision can start up to that much later than planned. */
const TICK_SLACK_MS = 20;
/** Longest a decision request may take before it's abandoned. */
const PROVIDER_TIMEOUT_MS = 10000;
/** Time to work out a reused decision (the band's analysis, the notes) before writing it. */
const REUSE_SLACK_MS = 30;
/** Phrases heard this many bars back (8 s at least) are told to the decision model. */
const HEARD_BARS = 4;
/** A phrase this recent (4 s at least) may ask for a fill outside a phrase's last bar. */
const CUE_BARS = 2;
const MAX_HEARD_LINES = 3;

/** The decision model's odds, for the log. */
const odds = ({ odds, fillP, joinP }: Decision) => ({ odds, fillP, joinP });

/** When a phrase was heard, for the decision model: "this bar", "2 bars ago". */
const whenSaid = (said: SpeechState, timing: Timing) => {
  if (!said.bar) return "just before playback started";
  const ago = timing.bar - said.bar;
  return ago <= 0 ? "this bar" : ago === 1 ? "last bar" : `${ago} bars ago`;
};

export const msUntilBar = (bar: number, timing: Timing) => {
  return ((bar - timing.bar) * timing.beatsPerBar - timing.beatInBar) * timing.msPerBeat;
};

/** The notes that start inside a clip of `length` beats, kept within it and within MIDI's ranges. */
export const fitNotes = (notes: ClipNote[], length: number) => {
  return notes
    .filter((note) => note.start >= 0 && note.start < length - 1e-4)
    .map((note) => ({
      pitch: clamp(Math.round(note.pitch), 0, 127),
      start: note.start,
      duration: clamp(note.duration, 0.01, length - note.start),
      velocity: clamp(Math.round(note.velocity), 1, 127),
    }));
};

/**
 * Plays one Session Player device's part. For each upcoming bar it decides
 * what to play (as late as the decision time allows, for the most context),
 * writes that as a clip into the next slot of the track's ring and fires it;
 * the clip's 1-bar launch quantization makes Live start it exactly on the bar.
 * Lookahead sets how far ahead, and so how many decisions at once, a slow
 * decision model may work. Clips still go out in order, one waiting at a time.
 * A clip that can't be ready in time is never fired late: the current clip
 * keeps looping and the late choice is reused for a following bar.
 */
export class Player {
  private status: PlayerStatus = "waiting";
  private message?: string;
  private nextBar = 2;
  private pending = new Map<number, Pending>();
  /** The bar whose clip is being written and fired right now. */
  private committing?: number;
  private carry?: Decision;
  private playing?: Playing;
  private ring?: ClipSlotInfo[];
  private ringCursor = 0;
  private decisionSamples: number[] = [];
  private writeSamples: number[] = [];
  private lastFillBar = -Infinity;
  /** The latest phrase that brought the player in early, and the latest that got a cued fill. */
  private joinCalledAt = 0;
  private cueUsedAt = 0;
  /** The bar the Join setting brings the player in at, and whether it has come in. */
  private joinBar = 2;
  private joined = false;
  private recent: DecisionLog[] = [];
  private details = new Map<number, DecisionDetail>();
  private decisions = 0;
  private misses = 0;
  /** Requests made to the decision model, and decisions that reused an earlier answer instead. */
  private calls = 0;
  private reusedCount = 0;
  /** The decision model's last own answer, to reuse while nothing changes (see reuse.ts). */
  private asked?: Asked;
  private lastWasFallback = false;
  /** Decisions asked about since the band went quiet. */
  private quietAsks = 0;
  /** Whether the next bar to decide will reuse the last answer, worked out once when its decision is due. */
  private reusing?: { bar: number; reason?: string };
  /** Bumped on start and stop so work from an earlier run is dropped. */
  private run = 0;
  /** The instrument loaded after the device, as last read from Live. */
  private profile?: InstrumentProfile;

  constructor(public settings: PlayerSettings, private deps: PlayerDeps) {}

  update = (settings: PlayerSettings) => {
    const role = this.role();
    const lengthChanged = settings.length !== this.settings.length;
    const deactivated = this.settings.active && !settings.active;
    this.settings = settings;
    if (lengthChanged || this.role() !== role) {
      this.pending.clear();
      this.reusing = undefined;
    }
    if (deactivated) void this.stopClips();
    this.deps.onChange();
  };

  /** A newly read instrument: decisions from now on use its sounds. */
  setInstrument = (profile: InstrumentProfile | undefined) => {
    const role = this.role();
    this.profile = profile;
    if (this.role() !== role) this.pending.clear();
    this.deps.onChange();
  };

  /** What the player plays: its setting, or for Auto what the loaded instrument suggests. */
  role = (): Instrument => {
    const { instrument } = this.settings;
    return instrument === "auto" ? this.profile?.suggestedRole ?? "keys" : instrument;
  };

  /** Playback started: listen for `join` bars, then play. */
  start = () => {
    this.run++;
    this.status = "waiting";
    this.joinBar = Math.max(2, this.settings.join + 1);
    this.joined = false;
    this.nextBar = this.joinBar;
    this.pending.clear();
    this.committing = undefined;
    this.carry = undefined;
    this.playing = undefined;
    this.ring = undefined;
    this.lastFillBar = -Infinity;
    this.joinCalledAt = 0;
    this.cueUsedAt = 0;
    // Bars count again from 1: the last take's decisions would be mistaken for this one's.
    this.recent = [];
    this.details.clear();
    this.asked = undefined;
    this.lastWasFallback = false;
    this.quietAsks = 0;
    this.reusing = undefined;
  };

  /** Playback stopped; Live stops the clips itself. */
  stop = () => {
    this.run++;
    this.pending.clear();
    this.committing = undefined;
    this.playing = undefined;
    this.setStatus("waiting", "Waiting for playback");
  };

  tick = () => {
    const timing = this.deps.timing();
    if (!this.settings.active) return this.setStatus("off");
    if (!timing.playing) return this.setStatus("waiting", "Waiting for playback");
    if (!this.deps.ops()) return this.setStatus("waiting", "Waiting for Live");
    if (this.status === "error") return;
    if (!this.playing) this.setStatus("listening", `Joins at bar ${this.nextBar}`);

    // A bar that began before its clip went out has been missed.
    for (const entry of [...this.pending.values()]) {
      if (entry.bar <= timing.bar && entry.bar !== this.committing) {
        this.miss(entry, entry.prepared ? "Not written in time" : "Decision not ready in time");
      }
    }
    if (this.nextBar <= timing.bar) this.nextBar = timing.bar + 1;
    this.commitNext(timing);

    // Decide each bar as late as the expected decision and write times allow.
    // Lookahead caps how early, and so how many decisions run at once.
    const lead = this.decisionLead() + this.writeEstimate() + this.deps.config.timing.fireMarginMs + TICK_SLACK_MS;
    if (!this.playing) this.joinWhenCalled(timing, lead);
    const earliest = this.settings.lookahead * timing.beatsPerBar * timing.msPerBeat;
    const lastMoment = this.writeEstimate() + this.deps.config.timing.fireMarginMs + TICK_SLACK_MS + REUSE_SLACK_MS;
    while (this.pending.size < this.settings.lookahead && msUntilBar(this.nextBar, timing) <= Math.min(lead, earliest)) {
      const bar = this.nextBar;
      if (this.reusing?.bar !== bar) this.reusing = { bar, reason: this.reuseFor(bar, timing) };
      // Reusing takes no time, so it waits for the last moment, for the most context.
      if (this.reusing.reason && msUntilBar(bar, timing) > lastMoment) break;
      this.nextBar += this.settings.length;
      this.pending.set(bar, { bar, started: performance.now() });
      void this.decide(bar, this.reusing.reason);
    }
  };

  state = (): PlayerState => ({
    deviceId: this.settings.deviceId,
    trackId: this.settings.trackId,
    trackName: this.settings.trackName,
    instrument: this.role(),
    instrumentSetting: this.settings.instrument,
    sound: this.profile ? { name: this.profile.name, summary: this.profile.summary, kind: this.profile.kind } : undefined,
    active: this.settings.active,
    lookahead: this.settings.lookahead,
    length: this.settings.length,
    join: this.settings.join,
    energy: this.settings.energy,
    status: this.status,
    message: [this.message, this.lookaheadHint()].filter(Boolean).join(" · ") || undefined,
    provider: this.deps.provider.name,
    // Each state text is long and the page only shows the latest; the rest are in the details.
    recent: this.recent.map((log, i) => (i === 0 ? log : { ...log, state: undefined })),
    pending: [...this.pending.values()].map(({ bar, prepared }) => ({ bar, ready: !!prepared })).sort((a, b) => a.bar - b.bar),
    stats: {
      decisions: this.decisions,
      misses: this.misses,
      p90Ms: Math.round(this.decisionEstimate()),
      calls: this.calls,
      reused: this.reusedCount,
    },
  });

  /** Everything about the decision for a bar, while it's among the latest. */
  detail = (bar: number) => this.details.get(bar);

  /** The patterns on offer for the loaded instrument, with what they're rendered for. */
  patternSource = (): PatternSource => ({
    settings: this.settings,
    role: this.role(),
    profile: this.profile,
    options: this.patterns(),
    provider: this.deps.provider.name,
  });

  /** Says so when the decision model is too slow for the Lookahead setting. */
  private lookaheadHint = () => {
    const timing = this.deps.timing();
    const { provider, config } = this.deps;
    if (provider.name === "local" || !timing.playing || !this.settings.active) return undefined;
    const needed = this.decisionLead() + this.writeEstimate() + config.timing.fireMarginMs;
    const allowed = this.settings.lookahead * timing.beatsPerBar * timing.msPerBeat;
    if (needed <= allowed) return undefined;
    const bars = Math.ceil(needed / (timing.beatsPerBar * timing.msPerBeat));
    return `${provider.name} takes up to ${Math.round(this.decisionLead())} ms, so local rules decide; set Lookahead to ${bars} to use it`;
  };

  /** Phrases heard within the last `bars` bars (and at least 2 s a bar), newest first. */
  private heard = (timing: Timing, bars: number) => {
    const window = Math.max(bars * timing.beatsPerBar * timing.msPerBeat, bars * 2000);
    const now = Date.now();
    return this.deps.speech().filter((said) => now - said.at <= window);
  };

  /**
   * Someone spoke while the player waits to join ("ok, let's go"): decide for
   * the first bar a decision can still make, and ask the decision model whether
   * to come in now. Local rules don't read speech, so with them the player
   * waits as set.
   */
  private joinWhenCalled = (timing: Timing, lead: number) => {
    if (this.deps.provider.name === "local") return;
    const said = this.heard(timing, HEARD_BARS)[0];
    if (!said || said.at <= this.joinCalledAt) return;
    this.joinCalledAt = said.at;
    let bar = timing.bar + 1;
    while (msUntilBar(bar, timing) < lead) bar++;
    if (bar < this.nextBar) this.nextBar = bar;
  };

  /** What the decision for a bar depends on, to tell whether anything changed since the last call. */
  private fingerprintFor = (bar: number, analysis: BandAnalysis) => {
    const { energy } = this.settings;
    return fingerprint(analysis, this.deps.transport(), {
      instrument: this.role(),
      targetBar: bar,
      direction: this.deps.direction(),
      sound: this.profile?.summary,
      energyOverride: energy === "auto" ? undefined : energy,
    });
  };

  /** Why the decision for a bar can reuse the last answer instead of calling, if it can. */
  private reuseFor = (bar: number, timing: Timing) => {
    if (this.carry || this.deps.provider.name === "local") return undefined;
    const analysis = this.deps.analyze();
    return reuseReason({
      settings: this.deps.config.jev.reuse,
      asked: this.asked,
      lastWasFallback: this.lastWasFallback,
      joined: this.joined,
      speechFresh: this.heard(timing, HEARD_BARS).length > 0,
      quiet: bandQuiet(analysis),
      quietAsks: this.quietAsks,
      bar,
      length: this.settings.length,
      phraseLength: this.deps.config.phraseLength,
      fingerprint: this.fingerprintFor(bar, analysis),
    });
  };

  /** Keeps track of where the decision came from, for reusing it later. */
  private noteSource = (bar: number, decision: Decision, asked: boolean, analysis: BandAnalysis) => {
    const quiet = bandQuiet(analysis);
    if (!quiet) this.quietAsks = 0;
    else if (asked) this.quietAsks++;
    if (decision.reused) return;
    this.lastWasFallback = !!decision.fallbackReason || decision.provider === "local";
    if (asked && !this.lastWasFallback) {
      const { pattern, energy, provider, confidence } = decision;
      this.asked = { bar, pattern, energy, provider, confidence, fingerprint: this.fingerprintFor(bar, analysis) };
    }
  };

  private decisionEstimate = () => p90(this.decisionSamples, this.deps.config.timing.initialDecisionMs);

  /**
   * How long to allow for a decision: the slowest recent one. Network answers
   * have long tails, and an answer that misses its bar is wasted.
   */
  private decisionLead = () => slowest(this.decisionSamples, this.deps.config.timing.initialDecisionMs);

  private writeEstimate = () => p90(this.writeSamples, this.deps.config.timing.initialWriteMs);

  private sample = (samples: number[], value: number) => {
    samples.push(value);
    if (samples.length > 20) samples.shift();
  };

  private patterns = (): Option[] => optionsFor(this.role(), this.profile, this.deps.config.patterns);

  private request = (bar: number, analysis: BandAnalysis): DecisionRequest => {
    const { config, transport } = this.deps;
    const { energy } = this.settings;
    const instrument = this.role();
    // What will be playing just before this bar: an earlier decision still
    // waiting to go out, else the clip playing now.
    const before = [...this.pending.values()].filter((entry) => entry.bar < bar && entry.prepared).sort((a, b) => b.bar - a.bar)[0];
    const previous = before?.prepared
      ? { pattern: before.prepared.decision.pattern, energy: before.prepared.decision.energy }
      : this.playing
        ? { pattern: this.playing.pattern, energy: this.playing.energy }
        : undefined;
    const barsSinceFill = Number.isFinite(this.lastFillBar) ? bar - this.lastFillBar - 1 : bar - 1;
    const timing = this.deps.timing();
    const speech = this.heard(timing, HEARD_BARS)
      .slice(0, MAX_HEARD_LINES)
      .reverse()
      .map((said) => ({ text: said.text, trackName: said.trackName, when: whenSaid(said, timing) }));
    const cue = this.heard(timing, CUE_BARS)[0];
    const state = describeState(analysis, transport(), {
      instrument,
      targetBar: bar,
      phraseLength: config.phraseLength,
      lastPattern: previous?.pattern,
      lastEnergy: previous?.energy,
      barsSinceFill,
      sound: this.profile?.summary,
      direction: this.deps.direction(),
      speech,
    });
    return {
      instrument,
      state,
      analysis,
      patterns: this.patterns(),
      targetBar: bar,
      phraseLength: config.phraseLength,
      previous,
      barsSinceFill,
      energyOverride: energy === "auto" ? undefined : energy,
      direction: this.deps.direction(),
      speech,
      cueAt: cue?.at,
      // Only a decision model reads speech, so only it is asked early.
      joinBar: this.deps.provider.name !== "local" && !this.joined && bar < this.joinBar ? this.joinBar : undefined,
      seed: hashString(`${this.settings.trackId}:${bar}`),
    };
  };

  private decide = async (bar: number, reuse?: string) => {
    const run = this.run;
    const started = performance.now();
    try {
      const analysis = this.deps.analyze();
      const request = this.request(bar, analysis);
      let decision: Decision;
      let asked = false;
      if (this.carry) {
        decision = { ...this.carry };
        this.carry = undefined;
      } else if (reuse && this.asked) {
        const { pattern, energy, provider, confidence } = this.asked;
        decision = { pattern, energy, fill: false, provider, confidence, reused: { from: this.asked.bar, reason: reuse } };
        this.reusedCount++;
      } else {
        decision = await this.ask(request, bar);
        asked = true;
      }
      if (run !== this.run) return;
      this.noteSource(bar, decision, asked, analysis);
      const entry = this.pending.get(bar);
      // Its bar has already begun; the choice can still serve a later bar.
      if (!entry) {
        this.carry = decision;
        return;
      }
      this.decisions++;
      if (request.joinBar !== undefined && decision.join !== true) return this.waitToJoin(bar, request, decision, performance.now() - started);
      entry.prepared = { bar, decision, request, decisionMs: performance.now() - started };
      // Write right away rather than on the next tick.
      this.commitNext(this.deps.timing());
    } catch (error) {
      console.error("[session] Decision failed:", error);
      if (run === this.run) this.pending.delete(bar);
    } finally {
      this.deps.onChange();
    }
  };

  /**
   * Asked early, the decision model chose not to come in yet: wait for the Join
   * bar, or the next phrase heard. Without its answer (too slow, or failed),
   * ask again for the bar after.
   */
  private waitToJoin = (bar: number, request: DecisionRequest, decision: Decision, decisionMs: number) => {
    this.pending.delete(bar);
    if (decision.join === false) this.nextBar = Math.max(this.nextBar, request.joinBar!);
    const log: DecisionLog = {
      bar,
      length: this.settings.length,
      pattern: "–",
      energy: decision.energy,
      fill: false,
      chords: [],
      provider: decision.provider,
      confidence: decision.confidence,
      fallbackReason: decision.join === undefined ? `No answer on coming in early${decision.fallbackReason ? `: ${decision.fallbackReason}` : ""}` : undefined,
      decisionMs: Math.round(decisionMs),
      marginMs: Math.round(msUntilBar(bar, this.deps.timing())),
      outcome: "waited",
      state: request.state,
      ...odds(decision),
    };
    this.remember(log, request, decision);
  };

  /** Writes the earliest pending bar once it's decided and the last clip has started. */
  private commitNext = (timing: Timing) => {
    if (this.committing !== undefined || !this.pending.size) return;
    const entry = this.pending.get(Math.min(...this.pending.keys()))!;
    // Only one clip can wait for its bar: firing another would replace it.
    if (!entry.prepared || (this.playing && timing.bar < this.playing.bar)) return;
    void this.commit(entry.prepared);
  };

  /**
   * Asks the provider, but never past the point where the clip could still be
   * written in time: then local rules answer instead.
   */
  private ask = async (request: DecisionRequest, bar: number): Promise<Decision> => {
    const { provider, config } = this.deps;
    const budget = msUntilBar(bar, this.deps.timing()) - this.writeEstimate() - config.timing.fireMarginMs;
    const started = performance.now();
    if (provider.name === "local") {
      const decision = decideLocally(request);
      this.sample(this.decisionSamples, performance.now() - started);
      return decision;
    }
    // The request may run past the deadline: its answer is then ignored, but
    // its real duration teaches the scheduler to start the next one earlier.
    this.calls++;
    const answer = provider.decide(request, { timeoutMs: Math.max(budget, PROVIDER_TIMEOUT_MS) });
    const measure = () => this.sample(this.decisionSamples, performance.now() - started);
    void answer.then(measure, measure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), Math.max(budget, 0))));
    try {
      const result = await Promise.race([answer, deadline]);
      if (result !== "late") return result;
      return { ...decideLocally(request), fallbackReason: `${provider.name} took longer than ${Math.round(budget)} ms` };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ...decideLocally(request), fallbackReason: `${provider.name} failed: ${reason}` };
    } finally {
      clearTimeout(timer);
    }
  };

  private chordsFor = (bar: number, analysis: BandAnalysis) => {
    const fallback: ChordInfo = analysis.key ? triad(analysis.key.tonic, analysis.key.mode === "minor") : triad(0, false);
    const chords = Array.from({ length: this.settings.length }, (_, i) => analysis.chordAt(bar + i).chord ?? fallback);
    const next = analysis.chordAt(bar + this.settings.length).chord;
    return { chords, next };
  };

  private commit = async (prepared: Prepared) => {
    const run = this.run;
    this.committing = prepared.bar;
    const { decision, request, bar } = prepared;
    const { config, transport } = this.deps;
    const length = this.settings.length;
    const signatureTransport = transport();
    const beatsPerBar = (signatureTransport.signatureNumerator * 4) / signatureTransport.signatureDenominator;

    const patterns = this.patterns();
    // The options can change between deciding and writing (a new kit, say); fall back to what's on offer now.
    const pattern =
      patterns.find((p) => p.id === decision.pattern) ??
      patterns.find((p) => p.id === decideLocally(request).pattern) ??
      patterns[0];
    const { chords, next } = this.chordsFor(bar, request.analysis);
    // Fills belong in the last bar of a phrase, leading into the next one,
    // unless someone just asked for a cue: then one may come right away.
    const endsPhrase = (bar + length - 1) % config.phraseLength === 0;
    const cued = request.cueAt !== undefined && request.cueAt > this.cueUsedAt;
    const fill = decision.fill && (endsPhrase || cued) && bar - this.lastFillBar >= 2;
    const accent = !!this.playing?.fill && this.role() === "drums";
    const signature = [pattern.id, decision.energy, chords.map((c) => c.symbol).join(","), fill, accent, length].join("|");

    const log: DecisionLog = {
      bar,
      length,
      pattern: pattern.id,
      energy: decision.energy,
      fill,
      chords: chords.map((chord) => chord.symbol),
      provider: decision.provider,
      confidence: decision.confidence,
      fallbackReason: decision.fallbackReason,
      decisionMs: Math.round(prepared.decisionMs),
      marginMs: 0,
      outcome: "kept",
      state: request.state,
      ...odds(decision),
      reused: decision.reused,
    };

    try {
      // Same notes as the looping clip, lined up with its loop: let it play on.
      const playing = this.playing;
      if (playing && playing.signature === signature && (bar - playing.bar) % playing.length === 0) {
        this.joined = true;
        log.marginMs = Math.round(msUntilBar(bar, this.deps.timing()));
        this.remember({ ...log, notes: playing.notes }, request, decision);
        return;
      }

      const ops = this.deps.ops();
      if (!ops) throw new Error("Not connected to Live");
      const ring = await this.ensureRing(ops);
      const slot = this.nextSlot(ring);
      const notes = fitNotes(
        pattern.render({
          chords,
          nextChord: next,
          beatsPerBar,
          beatLength: 4 / signatureTransport.signatureDenominator,
          energy: decision.energy,
          fill,
          accent,
          kit: this.profile?.kind === "drums" ? this.profile.kit : STANDARD_KIT,
          random: seededRandom(request.seed),
        }),
        length * beatsPerBar
      );
      const clipName = `SP ${bar} ${pattern.id} ${chords[0].symbol}${chords.length > 1 ? "…" : ""} e${decision.energy}${fill ? " fill" : ""}`;
      const writeStarted = performance.now();
      const clipId = await ops.writeClip(slot, { name: clipName, color: this.settings.color, length: length * beatsPerBar, notes });
      this.sample(this.writeSamples, performance.now() - writeStarted);
      if (run !== this.run) return;

      const margin = msUntilBar(bar, this.deps.timing());
      if (margin < MIN_FIRE_MS || !transport().isPlaying) {
        this.miss({ bar, started: 0, prepared }, "Written too late to fire");
        return;
      }
      await ops.fireClip(clipId);
      if (run !== this.run) return;
      const written = notes.map((note) => compactNote(note.pitch, note.start, note.duration, note.velocity));
      this.playing = { bar, length, pattern: pattern.id, energy: decision.energy, fill, slotIndex: slot.index, signature, notes: written };
      this.joined = true;
      if (fill) this.lastFillBar = bar + length - 1;
      if (fill && !endsPhrase) this.cueUsedAt = request.cueAt!;
      this.setStatus("playing");
      this.remember({ ...log, outcome: "fired", marginMs: Math.round(margin), clipName, notes: written }, request, decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[session] Couldn't play the clip:", message);
      this.ring = undefined;
      if (/clip slots/.test(message)) this.setStatus("error", message);
    } finally {
      if (run === this.run) {
        this.pending.delete(bar);
        this.committing = undefined;
        this.commitNext(this.deps.timing());
      }
      this.deps.onChange();
    }
  };

  /** The current clip keeps looping; a decided choice is kept for a later bar. */
  private miss = (entry: Pending, reason: string) => {
    this.pending.delete(entry.bar);
    const { prepared } = entry;
    if (prepared) this.carry = prepared.decision;
    this.misses++;
    const log: DecisionLog = {
      bar: entry.bar,
      length: this.settings.length,
      pattern: prepared?.decision.pattern ?? "–",
      energy: prepared?.decision.energy ?? 0,
      fill: prepared?.decision.fill ?? false,
      chords: [],
      provider: prepared?.decision.provider ?? this.deps.provider.name,
      confidence: prepared?.decision.confidence,
      fallbackReason: reason,
      decisionMs: Math.round(prepared?.decisionMs ?? performance.now() - entry.started),
      marginMs: Math.round(msUntilBar(entry.bar, this.deps.timing())),
      outcome: "missed",
      state: prepared?.request.state ?? "",
      ...(prepared && odds(prepared.decision)),
    };
    this.remember(log, prepared?.request, prepared?.decision);
  };

  private ensureRing = async (ops: LiveOps) => {
    if (this.ring) return this.ring;
    const slots = await ops.clipSlots(this.settings.trackId);
    const ring = slots.slice(-this.deps.config.slots);
    if (ring.length < 2) throw new Error("The player's track needs at least 2 clip slots (scenes)");
    this.ring = ring;
    return ring;
  };

  /** The next slot in the ring that isn't the one playing now. */
  private nextSlot = (ring: ClipSlotInfo[]) => {
    for (let i = 0; i < ring.length; i++) {
      this.ringCursor = (this.ringCursor + 1) % ring.length;
      if (ring[this.ringCursor].index !== this.playing?.slotIndex) break;
    }
    return ring[this.ringCursor];
  };

  private stopClips = async () => {
    const ops = this.deps.ops();
    this.playing = undefined;
    this.pending.clear();
    if (!ops) return;
    try {
      await ops.stopTrack(this.settings.trackId);
    } catch (error) {
      console.error("[session] Couldn't stop the player's clips:", error);
    }
  };

  /** Logs a decision for the web page, with its request and answer for the detail view. */
  private remember = (log: DecisionLog, request?: DecisionRequest, decision?: Decision) => {
    this.recent = [log, ...this.recent].slice(0, MAX_LOG);
    if (request) {
      const { trace } = decision ?? {};
      this.details.delete(log.bar);
      this.details.set(log.bar, {
        deviceId: this.settings.deviceId,
        trackName: this.settings.trackName,
        instrument: request.instrument,
        log,
        sent: {
          state: request.state,
          options: request.patterns.map(({ id, description, fit }) => ({ id, description, fit })),
          questions: trace?.questions,
        },
        received: trace?.received,
        ranking: trace?.ranking,
      });
      for (const bar of this.details.keys()) {
        if (this.details.size <= MAX_DETAILS) break;
        this.details.delete(bar);
      }
    }
    this.deps.onChange();
  };

  private setStatus = (status: PlayerStatus, message?: string) => {
    if (this.status === status && this.message === message) return;
    this.status = status;
    this.message = message;
    this.deps.onChange();
  };
}

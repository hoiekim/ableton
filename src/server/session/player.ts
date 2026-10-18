import { DecisionLog, Instrument, PlayerState, PlayerStatus, TransportState } from "common";
import { BandAnalysis } from "./analyze";
import { p90, slowest } from "./clock";
import { SessionConfig } from "./config";
import { ChordInfo, ClipNote, clamp, hashString, seededRandom, triad } from "./music";
import { InstrumentProfile, STANDARD_KIT } from "./instrument";
import { ClipSlotInfo, LiveOps } from "./ops";
import { Option, optionsFor } from "./patterns";
import { Decision, DecisionProvider, DecisionRequest, decideLocally } from "./providers";
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
  onChange: () => void;
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
}

const MAX_LOG = 12;
/** Firing closer than this to the bar risks Live starting the clip a bar late. */
const MIN_FIRE_MS = 25;
/** The engine checks every 15 ms, so a decision can start up to that much later than planned. */
const TICK_SLACK_MS = 20;
/** Longest a decision request may take before it's abandoned. */
const PROVIDER_TIMEOUT_MS = 10000;

export const msUntilBar = (bar: number, timing: Timing) => {
  return ((bar - timing.bar) * timing.beatsPerBar - timing.beatInBar) * timing.msPerBeat;
};

const fitNotes = (notes: ClipNote[], length: number) => {
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
  private recent: DecisionLog[] = [];
  private decisions = 0;
  private misses = 0;
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
    if (lengthChanged || this.role() !== role) this.pending.clear();
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
    this.nextBar = Math.max(2, this.settings.join + 1);
    this.pending.clear();
    this.committing = undefined;
    this.carry = undefined;
    this.playing = undefined;
    this.ring = undefined;
    this.lastFillBar = -Infinity;
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
    const earliest = this.settings.lookahead * timing.beatsPerBar * timing.msPerBeat;
    while (this.pending.size < this.settings.lookahead && msUntilBar(this.nextBar, timing) <= Math.min(lead, earliest)) {
      const bar = this.nextBar;
      this.nextBar += this.settings.length;
      this.pending.set(bar, { bar, started: performance.now() });
      void this.decide(bar);
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
    recent: this.recent,
    stats: {
      decisions: this.decisions,
      misses: this.misses,
      p90Ms: Math.round(this.decisionEstimate()),
    },
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
    const state = describeState(analysis, transport(), {
      instrument,
      targetBar: bar,
      phraseLength: config.phraseLength,
      lastPattern: previous?.pattern,
      lastEnergy: previous?.energy,
      barsSinceFill,
      sound: this.profile?.summary,
      direction: this.deps.direction(),
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
      seed: hashString(`${this.settings.trackId}:${bar}`),
    };
  };

  private decide = async (bar: number) => {
    const run = this.run;
    const started = performance.now();
    try {
      const request = this.request(bar, this.deps.analyze());
      let decision: Decision;
      if (this.carry) {
        decision = { ...this.carry };
        this.carry = undefined;
      } else {
        decision = await this.ask(request, bar);
      }
      if (run !== this.run) return;
      const entry = this.pending.get(bar);
      // Its bar has already begun; the choice can still serve a later bar.
      if (!entry) {
        this.carry = decision;
        return;
      }
      this.decisions++;
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
    // Fills belong in the last bar of a phrase, leading into the next one.
    const endsPhrase = (bar + length - 1) % config.phraseLength === 0;
    const fill = decision.fill && endsPhrase && bar - this.lastFillBar >= 2;
    const accent = !!this.playing?.fill && this.role() === "drums";
    const signature = [pattern.id, decision.energy, chords.map((c) => c.symbol).join(","), fill, accent, length].join("|");

    const log: DecisionLog = {
      bar,
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
    };

    try {
      // Same notes as the looping clip, lined up with its loop: let it play on.
      const playing = this.playing;
      if (playing && playing.signature === signature && (bar - playing.bar) % playing.length === 0) {
        log.marginMs = Math.round(msUntilBar(bar, this.deps.timing()));
        this.remember(log);
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
      this.playing = { bar, length, pattern: pattern.id, energy: decision.energy, fill, slotIndex: slot.index, signature };
      if (fill) this.lastFillBar = bar + length - 1;
      this.setStatus("playing");
      this.remember({ ...log, outcome: "fired", marginMs: Math.round(margin), clipName });
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
    this.remember({
      bar: entry.bar,
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
    });
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

  private remember = (log: DecisionLog) => {
    this.recent = [log, ...this.recent].slice(0, MAX_LOG);
    this.deps.onChange();
  };

  private setStatus = (status: PlayerStatus, message?: string) => {
    if (this.status === status && this.message === message) return;
    this.status = status;
    this.message = message;
    this.deps.onChange();
  };
}

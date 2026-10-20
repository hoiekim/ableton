import React, { useEffect, useMemo, useRef, useState } from "react";
import { DecisionLog, PlanState, PlayerState, SessionState, TimelineBar, TransportState } from "common";
import { DecisionDetailView } from "./DecisionDetail";
import { PlanDetailView, endingName, sectionName } from "./PlanDetail";
import { MiniRoll, pitchRange } from "./MiniRoll";
import { DirectionInput } from "./SessionPanel";

/** Bars shown at once; older ones scroll off. */
const MAX_COLUMNS = 16;

const percent = (p: number) => `${Math.round(p * 100)}%`;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface Selection {
  deviceId: number;
  bar: number;
}

/** The bars to show: what's been heard, through the furthest bar a player has decided or is deciding. */
const columnsFor = (session: SessionState) => {
  const { timeline, players } = session;
  const decided = players.flatMap((player) => [
    ...player.recent.map((log) => log.bar + log.length - 1),
    ...player.pending.map((entry) => entry.bar),
  ]);
  const last = Math.max(timeline[timeline.length - 1]?.bar ?? 0, session.bar ? session.bar + 1 : 0, ...decided);
  if (!last) return [];
  const first = Math.max(1, last - MAX_COLUMNS + 1);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
};

const outcomeWord = (log: DecisionLog) => {
  if (log.outcome === "fired") return `${log.marginMs} ms early`;
  if (log.outcome === "kept") return "kept looping";
  if (log.outcome === "waited") return "waits to join";
  return "missed";
};

const DecisionCell = ({
  log,
  row,
  column,
  span,
  beatsPerBar,
  selected,
  onSelect,
}: {
  log: DecisionLog;
  row: number;
  column: number;
  span: number;
  beatsPerBar: number;
  selected: boolean;
  onSelect: () => void;
}) => {
  const notes = log.notes ?? [];
  const [low, high] = pitchRange(notes);
  const played = log.variant ? `${log.pattern} · ${log.variant}` : log.pattern;
  const name = log.outcome === "waited" ? "not yet" : log.outcome === "missed" ? `missed: ${played}` : played;
  return (
    <button
      type="button"
      className={["cell", "decisionCell", log.outcome, log.reused ? "reused" : "", selected ? "selected" : ""].filter(Boolean).join(" ")}
      style={{ gridRow: row, gridColumn: `${column} / span ${span}` }}
      onClick={onSelect}
      title={
        log.fallbackReason ??
        (log.reused
          ? `Bar ${log.bar}: no call. Reused the answer for bar ${log.reused.from} (${log.reused.reason}).`
          : `Bar ${log.bar}: ${log.pattern}, energy ${log.energy}. Click for what was sent and received.`)
      }
    >
      <span className="cellTop">
        <b className="cellPattern">{name}</b>
        {log.fill && <span className="tag">fill</span>}
      </span>
      <span className="cellMeta">
        {log.outcome !== "waited" && `e${log.energy} · `}
        {log.reused ? (
          `reused bar ${log.reused.from}`
        ) : (
          <>
            {log.provider}
            {log.confidence !== undefined && ` ${percent(log.confidence)}`}
            {log.fallbackReason && log.outcome !== "missed" && " · fallback"}
          </>
        )}
      </span>
      {notes.length > 0 && <MiniRoll notes={notes} beats={log.length * beatsPerBar} low={low} high={high} />}
      <span className="cellMeta">
        {log.reused ? "no call" : `${log.decisionMs} ms`} · {outcomeWord(log)}
      </span>
    </button>
  );
};

/** One player's lane: a cell per decision, spanning its clip's bars, and the bars still being decided. */
const PlayerLane = ({
  player,
  row,
  columns,
  beatsPerBar,
  selected,
  onSelect,
}: {
  player: PlayerState;
  row: number;
  columns: number[];
  beatsPerBar: number;
  selected?: Selection;
  onSelect: (selection: Selection) => void;
}) => {
  const logs = new Map<number, DecisionLog>();
  // Oldest first, so the newest entry for a bar wins.
  [...player.recent].reverse().forEach((log) => logs.set(log.bar, log));
  const pending = new Map(player.pending.map((entry) => [entry.bar, entry]));
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < columns.length; ) {
    const bar = columns[i];
    const column = i + 2;
    // A clip that started before the first column still covers it.
    const log = logs.get(bar) ?? (i === 0 ? [...logs.values()].find((l) => l.bar < bar && l.bar + l.length > bar) : undefined);
    if (log) {
      const span = Math.min(log.bar + log.length - bar, columns.length - i);
      cells.push(
        <DecisionCell
          key={bar}
          log={log}
          row={row}
          column={column}
          span={span}
          beatsPerBar={beatsPerBar}
          selected={selected?.deviceId === player.deviceId && selected.bar === log.bar}
          onSelect={() => onSelect({ deviceId: player.deviceId, bar: log.bar })}
        />
      );
      i += span;
      continue;
    }
    const entry = pending.get(bar);
    cells.push(
      entry ? (
        <button
          key={bar}
          type="button"
          className={`cell decisionCell pending${selected?.deviceId === player.deviceId && selected.bar === bar ? " selected" : ""}`}
          style={{ gridRow: row, gridColumn: column }}
          onClick={() => onSelect({ deviceId: player.deviceId, bar })}
        >
          <span className="cellMeta">{entry.ready ? "decided, writing…" : `asking ${player.provider}…`}</span>
        </button>
      ) : (
        <div key={bar} className="cell empty" style={{ gridRow: row, gridColumn: column }} />
      )
    );
    i++;
  }
  return (
    <>
      <div className="laneLabel" style={{ gridRow: row }}>
        <span className="laneName">{player.trackName}</span>
        <span className="laneMeta">
          {capitalize(player.instrument)} · {player.provider} · {player.stats.p90Ms} ms
          {player.stats.misses > 0 && ` · ${player.stats.misses} missed`}
        </span>
        <span className="laneMeta">
          {player.provider === "local"
            ? "local rules: no calls"
            : `${player.stats.calls} call${player.stats.calls === 1 ? "" : "s"} · ${player.stats.reused} reused`}
        </span>
        <span className={`statusPill ${player.status}`}>{player.status}</span>
      </div>
      {cells}
    </>
  );
};

/** The band plan's lane: a block per phrase, with how it ends; click one for what the arranger was asked and answered. */
const PlanLane = ({
  plan,
  row,
  columns,
  selected,
  onSelect,
}: {
  plan: PlanState;
  row: number;
  columns: number[];
  selected?: number;
  onSelect: (decidedAt: number) => void;
}) => {
  const byBar = new Map(plan.bars.map((entry) => [entry.bar, entry]));
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < columns.length; ) {
    const entry = byBar.get(columns[i]);
    if (!entry) {
      cells.push(<div key={columns[i]} className="cell empty" style={{ gridRow: row, gridColumn: i + 2 }} />);
      i++;
      continue;
    }
    // One block per phrase, as far as it's on screen.
    let span = 1;
    while (i + span < columns.length && byBar.get(columns[i + span])?.start === entry.start && byBar.get(columns[i + span])?.section === entry.section) span++;
    const last = byBar.get(columns[i + span - 1]);
    cells.push(
      <button
        key={columns[i]}
        type="button"
        className={`cell planCell planSection ${entry.section}${selected === entry.decidedAt ? " selected" : ""}`}
        style={{ gridRow: row, gridColumn: `${i + 2} / span ${span}` }}
        onClick={() => onSelect(entry.decidedAt)}
        title={`Planned in bar ${entry.decidedAt}. Click for what the arranger was asked and answered.`}
      >
        <b>{sectionName(entry.section)}</b>
        <span className="cellMeta">
          {entry.start === columns[i] ? `from bar ${entry.start}` : "…"}
          {last?.ending && last.ending !== "none" && ` · ${endingName(last.ending)}`}
        </span>
      </button>
    );
    i += span;
  }
  return (
    <>
      <div className="laneLabel" style={{ gridRow: row }}>
        <span className="laneName">Band plan</span>
        <span className="laneMeta">{plan.problem ?? `intensity ${plan.intensity} · ${plan.calls} plan${plan.calls === 1 ? "" : "s"}`}</span>
      </div>
      {cells}
    </>
  );
};

/**
 * The jam bar by bar: what each input played (the bar in progress filling in
 * as notes arrive), what was said, and what each player decided for each bar.
 * Clicking a decision shows what was sent to the decision model and what came
 * back.
 */
export const Dashboard = ({
  session,
  transport,
  onDirection,
}: {
  session: SessionState;
  transport: TransportState;
  onDirection: (text: string) => void;
}) => {
  const { timeline, inputs, players, voices, speech } = session;
  const [selected, setSelected] = useState<Selection>();
  const [selectedPlan, setSelectedPlan] = useState<number>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const beatsPerBar = (transport.signatureNumerator * 4) / transport.signatureDenominator;
  const beatInBar = transport.isPlaying ? transport.songTime - Math.floor(transport.songTime / beatsPerBar + 1e-9) * beatsPerBar : 0;

  const columns = useMemo(() => columnsFor(session), [session]);
  const byBar = useMemo(() => new Map<number, TimelineBar>(timeline.map((bar) => [bar.bar, bar])), [timeline]);
  const lastColumn = columns[columns.length - 1];

  // Follow the newest bar, unless the timeline has been scrolled back to look at something.
  const following = useRef(true);
  useEffect(() => {
    const element = scrollRef.current;
    if (element && following.current) element.scrollLeft = element.scrollWidth;
  }, [lastColumn]);

  if (!players.length && !inputs.length && !voices.length) {
    return (
      <section className="Dashboard">
        <p className="playerMessage">
          No Session devices in this Live Set yet. Add <b>Session Player</b> to a MIDI track and <b>Session Input</b> to the
          tracks it should hear; their bars and decisions show up here.
        </p>
      </section>
    );
  }

  const selectedPlayer = selected && players.find((player) => player.deviceId === selected.deviceId);
  const selectedLog = selectedPlayer && [...selectedPlayer.recent].find((log) => log.bar === selected!.bar);

  let row = 1;
  const nextRow = () => ++row;
  const before = speech.filter((said) => !said.bar);

  return (
    <section className="Dashboard">
      <div className="dashHeader">
        <span className="sessionMeta">{session.bar ? `Bar ${session.bar}` : "Stopped"}</span>
        <span className="sessionMeta">{session.key ?? "Key not clear yet"}</span>
        <DirectionInput direction={session.direction} onDirection={onDirection} />
      </div>
      {columns.length === 0 ? (
        <p className="playerMessage">Press Play in Live: what the band plays and what the players decide line up here, bar by bar.</p>
      ) : (
        <div
          className="timelineScroll"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current = element.scrollLeft + element.clientWidth >= element.scrollWidth - 40;
          }}
        >
          <div className="timeline" style={{ gridTemplateColumns: `var(--lane-label) repeat(${columns.length}, minmax(6.5rem, 1fr))` }}>
            <div className="laneLabel corner" style={{ gridRow: 1 }}>
              Bar
            </div>
            {columns.map((bar, i) => {
              const now = bar === session.bar;
              return (
                <div key={bar} className={`barHead${now ? " now" : bar > session.bar && session.bar ? " future" : ""}`} style={{ gridRow: 1, gridColumn: i + 2 }}>
                  {bar}
                  {now && <span className="barProgress" style={{ width: `${(beatInBar / beatsPerBar) * 100}%` }} />}
                </div>
              );
            })}

            <div className="laneLabel" style={{ gridRow: nextRow() }}>
              <span className="laneName">Chords</span>
              <span className="laneMeta">heard, then predicted</span>
            </div>
            {columns.map((bar, i) => {
              const chord = byBar.get(bar)?.chord;
              const predicted = !chord && bar === session.bar + 1 ? session.predictedChord : undefined;
              return (
                <div key={bar} className={`cell chordCell${predicted ? " predicted" : ""}`} style={{ gridRow: row, gridColumn: i + 2 }}>
                  {chord ?? (predicted ? `${predicted}?` : "")}
                </div>
              );
            })}

            <div className="laneSection" style={{ gridRow: nextRow() }}>
              <span>What the players hear</span>
            </div>
            {inputs.map((input) => {
              const lane = nextRow();
              const visible = columns.flatMap((bar) => byBar.get(bar)?.heard[input.deviceId] ?? []);
              const [low, high] = pitchRange(visible);
              return (
                <React.Fragment key={input.deviceId}>
                  <div className={`laneLabel${input.on ? "" : " off"}`} style={{ gridRow: lane }}>
                    <span className="laneName">
                      <span className={input.connected && input.on ? "inputDot connected" : "inputDot"} />
                      {input.trackName}
                    </span>
                    <span className="laneMeta">
                      {capitalize(input.role)} · {input.kind === "audio" ? "Audio" : "MIDI"}
                      {!input.on && " · off"}
                    </span>
                  </div>
                  {columns.map((bar, i) => {
                    const heard = byBar.get(bar);
                    const notes = heard?.heard[input.deviceId] ?? [];
                    return (
                      <div key={bar} className={`cell inputCell${heard?.partial ? " now" : ""}`} style={{ gridRow: lane, gridColumn: i + 2 }}>
                        {heard && (
                          <MiniRoll notes={notes} beats={heard.beatsPerBar} low={low} high={high} upTo={heard.partial ? beatInBar : undefined} />
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}

            {(voices.length > 0 || speech.length > 0) && (
              <>
                <div className="laneLabel" style={{ gridRow: nextRow() }}>
                  <span className="laneName">Heard</span>
                  <span className="laneMeta">{voices.map((voice) => voice.trackName).join(", ") || "voice"}</span>
                  {before[0] && (
                    <span className="speechBefore" title={before[0].text}>
                      “{before[0].text}” before Play
                    </span>
                  )}
                </div>
                {columns.map((bar, i) => (
                  <div key={bar} className="cell speechCell" style={{ gridRow: row, gridColumn: i + 2 }}>
                    {speech
                      .filter((said) => said.bar === bar)
                      .reverse()
                      .map((said) => (
                        <q key={said.at} title={said.text}>
                          {said.text}
                        </q>
                      ))}
                  </div>
                ))}
              </>
            )}

            {session.plan && (
              <PlanLane
                plan={session.plan}
                row={nextRow()}
                columns={columns}
                selected={selectedPlan}
                onSelect={(decidedAt) => {
                  setSelected(undefined);
                  setSelectedPlan(selectedPlan === decidedAt ? undefined : decidedAt);
                }}
              />
            )}
            <div className="laneSection" style={{ gridRow: nextRow() }}>
              <span>What the players decided, and the notes they wrote</span>
            </div>
            {players.map((player) => (
              <PlayerLane
                key={player.deviceId}
                player={player}
                row={nextRow()}
                columns={columns}
                beatsPerBar={beatsPerBar}
                selected={selected}
                onSelect={(selection) => {
                  setSelectedPlan(undefined);
                  setSelected(selected?.deviceId === selection.deviceId && selected.bar === selection.bar ? undefined : selection);
                }}
              />
            ))}
          </div>
        </div>
      )}
      {selectedPlan !== undefined && <PlanDetailView decidedAt={selectedPlan} onClose={() => setSelectedPlan(undefined)} />}
      {selected && selectedPlayer && (
        <DecisionDetailView
          deviceId={selected.deviceId}
          trackName={selectedPlayer.trackName}
          bar={selected.bar}
          log={selectedLog}
          pending={selectedPlayer.pending.some((entry) => entry.bar === selected.bar)}
          beatsPerBar={beatsPerBar}
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
};

import React, { useEffect, useState } from "react";
import { DecisionDetail, DecisionLog } from "common";
import { fetchJson } from "./api";
import { MiniRoll, pitchRange } from "./MiniRoll";

/** The parts of Jev's answer shown as charts; anything else is in the raw answer. */
interface JevAnswers {
  pattern?: { choice: string; confidence: number; probabilities?: Record<string, number> };
  energy?: { score: number; confidence?: number; legend?: Record<string, string>; probabilities?: Record<string, number> };
  fill?: { noul: number };
  join?: { noul: number };
}

interface JevResponse {
  model?: string;
  answers?: JevAnswers;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface Question {
  type?: string;
  instructions?: string;
}

const percent = (p: number) => `${Math.round(p * 100)}%`;

interface Bar {
  label: string;
  /** 0–1, the bar's length. */
  value: number;
  text: string;
  title?: string;
}

const Bars = ({ items, chosen }: { items: Bar[]; chosen?: string }) => (
  <ul className="probBars">
    {items.map((item) => (
      <li key={item.label} className={item.label === chosen ? "chosen" : undefined} title={item.title}>
        <span className="probLabel">{item.label}</span>
        <span className="probTrack">
          <span className="probFill" style={{ width: `${Math.max(item.value * 100, 1.5)}%` }} />
        </span>
        <span className="probValue">{item.text}</span>
      </li>
    ))}
  </ul>
);

const outcomeText = (log: DecisionLog) => {
  if (log.outcome === "fired") return `Fired, in place ${log.marginMs} ms before the bar`;
  if (log.outcome === "kept") return "Same as the looping clip, so it kept looping";
  if (log.outcome === "waited") return "Chose not to come in yet";
  return `Missed: ${log.fallbackReason ?? "not ready in time"}`;
};

const JevAnswer = ({ response, chosen }: { response: JevResponse; chosen: string }) => {
  const { answers = {}, model, usage } = response;
  const patterns = Object.entries(answers.pattern?.probabilities ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([label, p]) => ({ label, value: p, text: percent(p) }));
  const levels = Object.entries(answers.energy?.probabilities ?? {})
    .map(([index, p]) => ({ label: `${Number(index) + 1}`, value: p, text: percent(p), title: answers.energy?.legend?.[index] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 4);
  return (
    <>
      <p className="detailMeta">
        {model ?? "Jev"}
        {usage?.input_tokens !== undefined && ` · ${usage.input_tokens} tokens in, ${usage.output_tokens ?? 0} out`}
      </p>
      {answers.pattern && (
        <>
          <h5>
            Pattern: {answers.pattern.choice} <span className="detailMeta">({percent(answers.pattern.confidence)} confident)</span>
          </h5>
          <Bars items={patterns} chosen={chosen === answers.pattern.choice ? chosen : answers.pattern.choice} />
        </>
      )}
      {answers.energy && (
        <>
          <h5>Energy: {Math.round(answers.energy.score + 1)} of 10</h5>
          <Bars items={levels} />
        </>
      )}
      {answers.fill && (
        <>
          <h5>Fill</h5>
          <Bars items={[{ label: answers.fill.noul >= 0.5 ? "yes" : "no", value: answers.fill.noul, text: percent(answers.fill.noul) }]} />
        </>
      )}
      {answers.join && (
        <>
          <h5>Come in now</h5>
          <Bars items={[{ label: answers.join.noul >= 0.5 ? "yes" : "no", value: answers.join.noul, text: percent(answers.join.noul) }]} />
        </>
      )}
    </>
  );
};

const Ranking = ({ ranking, chosen }: { ranking: { pattern: string; score: number }[]; chosen: string }) => {
  const scores = ranking.map(({ score }) => score);
  const low = Math.min(...scores);
  const span = Math.max(...scores) - low || 1;
  return <Bars items={ranking.slice(0, 8).map(({ pattern, score }) => ({ label: pattern, value: (score - low) / span, text: score.toFixed(1) }))} chosen={chosen} />;
};

interface Props {
  deviceId: number;
  trackName: string;
  bar: number;
  /** The decision's log entry, once there is one. */
  log?: DecisionLog;
  pending: boolean;
  beatsPerBar: number;
  onClose: () => void;
}

/**
 * Everything about one decision: the text and options sent, what came back,
 * and the notes that went into the clip. Fetched when opened, since it's too
 * big to send with every update.
 */
export const DecisionDetailView = ({ deviceId, trackName, bar, log, pending, beatsPerBar, onClose }: Props) => {
  const [detail, setDetail] = useState<DecisionDetail>();
  const [error, setError] = useState<string>();
  // A bar's entry changes once (decided, then fired or missed): fetch again then.
  const version = log ? `${log.outcome}:${log.decisionMs}:${log.marginMs}` : "";

  useEffect(() => {
    setDetail(undefined);
    setError(undefined);
    if (!version) return;
    let cancelled = false;
    fetchJson<DecisionDetail>(`/api/decisions/${deviceId}/${bar}`)
      .then((value) => !cancelled && setDetail(value))
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
    };
  }, [deviceId, bar, version]);

  const questions = detail?.sent.questions as Record<string, Question> | undefined;
  const received = detail?.received as JevResponse | undefined;
  const notes = log?.notes ?? [];
  const [low, high] = pitchRange(notes);

  return (
    <section className="DecisionDetail" aria-label={`${trackName}, bar ${bar}`}>
      <header className="detailHeader">
        <h3>
          {trackName} · bar {bar}
        </h3>
        {log && (
          <span className="detailMeta">
            {log.provider}
            {log.confidence !== undefined && ` ${percent(log.confidence)}`} · decided in {log.decisionMs} ms
          </span>
        )}
        <button type="button" className="detailClose" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {!log ? (
        <p className="playerMessage">{pending ? "Still deciding this bar…" : "No decision for this bar."}</p>
      ) : !detail ? (
        <p className="playerMessage">{error ?? "Loading…"}</p>
      ) : (
        <div className="detailColumns">
          <div className="detailColumn">
            <h4>
              {log.reused
                ? "Not asked"
                : questions
                  ? `Sent to ${log.provider === "jev" ? "Jev" : "the decision model"}`
                  : "Worked out by the local rules"}
            </h4>
            {log.reused && (
              <p className="detailMeta">
                No call was made: {log.reused.reason}, so the answer for bar {log.reused.from} was reused. This is what the band looked like
                at the time.
              </p>
            )}
            <h5>The band, as text</h5>
            <pre className="detailState">{detail.sent.state}</pre>
            <h5>{detail.sent.options.length} patterns on offer</h5>
            <ul className="detailOptions">
              {detail.sent.options.map((option) => (
                <li key={option.id} className={option.id === log.pattern ? "chosen" : undefined} title={option.description}>
                  <b>{option.id}</b>
                  {option.fit > 0 && <span className="fit good">suits the sound</span>}
                  {option.fit < 0 && <span className="fit poor">poor fit</span>}
                  <span className="optionText">{option.description}</span>
                </li>
              ))}
            </ul>
            {questions && (
              <details>
                <summary>Questions asked ({Object.keys(questions).join(", ")})</summary>
                {Object.entries(questions).map(([name, question]) => (
                  <div key={name} className="detailQuestion">
                    <b>{name}</b> <span className="detailMeta">{question.type}</span>
                    <p>{question.instructions}</p>
                  </div>
                ))}
              </details>
            )}
          </div>
          <div className="detailColumn">
            <h4>Received</h4>
            {received?.answers ? (
              <JevAnswer response={received} chosen={log.pattern} />
            ) : (
              <p className="detailMeta">
                {log.reused ? `Reused from bar ${log.reused.from}: ${log.pattern}, energy ${log.energy}.` : "No answer from a decision model."}
              </p>
            )}
            {detail.ranking && (
              <>
                <h5>{received?.answers ? "Local rules' scores (they stood in)" : "Local rules' scores"}</h5>
                <Ranking ranking={detail.ranking} chosen={log.pattern} />
              </>
            )}
            {log.fallbackReason && <p className="fallback">{log.fallbackReason}</p>}
            {received !== undefined && (
              <details>
                <summary>Raw answer</summary>
                <pre className="detailRaw">{JSON.stringify(received, null, 2)}</pre>
              </details>
            )}
          </div>
          <div className="detailColumn">
            <h4>Played</h4>
            <p className="detailOutcome">{outcomeText(log)}</p>
            {log.outcome !== "waited" && log.outcome !== "missed" && (
              <>
                <p className="detailMeta">
                  {log.pattern} · energy {log.energy}
                  {log.fill && " · fill"} · {log.chords.join(" ")}
                </p>
                {log.clipName && <p className="detailMeta">Clip "{log.clipName}"</p>}
                {notes.length > 0 && (
                  <>
                    <MiniRoll className="large" notes={notes} beats={log.length * beatsPerBar} low={low} high={high} />
                    <p className="detailMeta">{notes.length} notes</p>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

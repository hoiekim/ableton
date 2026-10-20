import React, { useEffect, useState } from "react";
import { PlanDetail } from "common";
import { fetchJson } from "./api";

interface Answer {
  type?: string;
  choice?: string;
  confidence?: number;
  score?: number;
  probabilities?: Record<string, number>;
}

const percent = (p: number) => `${Math.round(p * 100)}%`;

const SECTION_NAMES: Record<string, string> = {
  groove: "Groove",
  build: "Build",
  climax: "Climax",
  breakdown: "Breakdown",
  break: "Break",
  "half-time": "Half-time",
  variation: "Variation",
  outro: "Outro",
};

export const sectionName = (section: string) => SECTION_NAMES[section] ?? section;

const ENDING_NAMES: Record<string, string> = { none: "flows on", fill: "fill", "big-fill": "big fill", stop: "stop" };

export const endingName = (ending: string) => ENDING_NAMES[ending] ?? ending;

/** How the decision model answered one question: its pick and the runners-up. */
const AnswerBars = ({ name, answer }: { name: string; answer: Answer }) => {
  if (answer.score !== undefined) {
    return (
      <li>
        <b>{name}</b> {Math.round(answer.score + 1)} of 10
      </li>
    );
  }
  const odds = Object.entries(answer.probabilities ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .filter(([, p]) => p >= 0.05);
  return (
    <li>
      <b>{name}</b> {answer.choice}
      {odds.length > 1 && <span className="detailMeta"> ({odds.map(([option, p]) => `${option} ${percent(p)}`).join(", ")})</span>}
    </li>
  );
};

/** The band plan made in a bar: what the arranger was told, how it answered, and the plan that came of it. */
export const PlanDetailView = ({ decidedAt, onClose }: { decidedAt: number; onClose: () => void }) => {
  const [detail, setDetail] = useState<PlanDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDetail(undefined);
    setError(undefined);
    let cancelled = false;
    fetchJson<PlanDetail>(`/api/plans/${decidedAt}`)
      .then((value) => !cancelled && setDetail(value))
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
    };
  }, [decidedAt]);

  const answers = ((detail?.received as { answers?: Record<string, Answer> } | undefined)?.answers ?? {}) as Record<string, Answer>;
  return (
    <section className="DecisionDetail" aria-label={`Band plan made in bar ${decidedAt}`}>
      <header className="detailHeader">
        <h3>Band plan · made in bar {decidedAt}</h3>
        {detail && (
          <span className="detailMeta">
            intensity {detail.intensity} · answered in {detail.ms} ms
          </span>
        )}
        <button type="button" className="detailClose" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {!detail ? (
        <p className="playerMessage">{error ?? "Loading…"}</p>
      ) : (
        <div className="detailColumns">
          <div className="detailColumn">
            <h4>Sent to the arranger</h4>
            <pre className="detailState">{detail.sent.state}</pre>
            <details>
              <summary>Questions asked ({Object.keys((detail.sent.questions as object) ?? {}).length})</summary>
              {Object.entries((detail.sent.questions as Record<string, { type?: string; instructions?: string }>) ?? {}).map(([name, question]) => (
                <div key={name} className="detailQuestion">
                  <b>{name}</b> <span className="detailMeta">{question.type}</span>
                  <p>{question.instructions}</p>
                </div>
              ))}
            </details>
          </div>
          <div className="detailColumn">
            <h4>Received</h4>
            <ul className="planAnswers">
              {Object.entries(answers).map(([name, answer]) => (
                <AnswerBars key={name} name={name} answer={answer} />
              ))}
            </ul>
            <details>
              <summary>Raw answer</summary>
              <pre className="detailRaw">{JSON.stringify(detail.received, null, 2)}</pre>
            </details>
          </div>
          <div className="detailColumn">
            <h4>The plan</h4>
            <ol className="planPhrases">
              {detail.phrases.map((phrase) => (
                <li key={phrase.start} className={`planSection ${phrase.section}`}>
                  <b>{sectionName(phrase.section)}</b>
                  <span className="detailMeta">
                    from bar {phrase.start}
                    {phrase.ending !== "none" && ` · ends with a ${endingName(phrase.ending)}`}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
};

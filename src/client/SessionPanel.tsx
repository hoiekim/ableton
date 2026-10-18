import React, { useEffect, useState } from "react";
import { MAX_DIRECTION_LENGTH } from "common";
import { DecisionLog, InputState, PlayerState, PlayerStatus, SessionState } from "common";

const statusLabels: Record<PlayerStatus, string> = {
  off: "Off",
  waiting: "Waiting",
  listening: "Listening",
  playing: "Playing",
  error: "Problem",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const outcomeText = (log: DecisionLog) => {
  if (log.outcome === "kept") return "kept looping";
  if (log.outcome === "missed") return `missed by ${Math.abs(log.marginMs)} ms`;
  return `in place ${log.marginMs} ms early`;
};

const Decision = ({ log }: { log: DecisionLog }) => (
  <div className={`decision ${log.outcome}`}>
    <div className="decisionMain">
      <span className="pattern">{log.pattern}</span>
      {log.chords.length > 0 && <span className="decisionChords">{log.chords.join(" ")}</span>}
      {log.fill && <span className="tag">fill</span>}
    </div>
    <div className="decisionMeta">
      Bar {log.bar} · energy {log.energy} · {log.provider}
      {log.confidence !== undefined && ` ${Math.round(log.confidence * 100)}%`} · decided in {log.decisionMs} ms ·{" "}
      {outcomeText(log)}
    </div>
    {log.fallbackReason && <div className="fallback">{log.fallbackReason}</div>}
  </div>
);

const PlayerCard = ({ player }: { player: PlayerState }) => {
  const [latest, ...older] = player.recent;
  return (
    <article className={`PlayerCard ${player.status}`}>
      <header className="playerHeader">
        <span className="playerTrack">{player.trackName}</span>
        <span className="playerInstrument">
          {player.instrumentSetting === "auto" ? `Auto · ${capitalize(player.instrument)}` : capitalize(player.instrument)}
        </span>
        <span className={`statusPill ${player.status}`}>{statusLabels[player.status]}</span>
      </header>
      <p className="playerSound" title={player.sound?.summary}>
        {player.sound ? player.sound.summary : "No instrument found after the Session Player."}
      </p>
      {player.message && <p className="playerMessage">{player.message}</p>}
      {latest ? <Decision log={latest} /> : <p className="playerMessage">No decisions yet.</p>}
      <dl className="playerStats">
        <div>
          <dt>Decisions</dt>
          <dd>{player.stats.decisions}</dd>
        </div>
        <div>
          <dt>Missed</dt>
          <dd>{player.stats.misses}</dd>
        </div>
        <div>
          <dt>Decision time</dt>
          <dd>{player.stats.p90Ms} ms</dd>
        </div>
        <div>
          <dt>Settings</dt>
          <dd>
            {player.length} bar{player.length > 1 ? "s" : ""}, {player.lookahead} ahead, energy {player.energy}
          </dd>
        </div>
      </dl>
      {latest && (
        <details className="stateText">
          <summary>What the decision model saw</summary>
          <pre>{latest.state}</pre>
        </details>
      )}
      {older.length > 0 && (
        <ol className="history" aria-label="Earlier decisions">
          {older.slice(0, 7).map((log) => (
            <li key={`${log.bar}-${log.outcome}`} className={log.outcome}>
              <span className="historyBar">{log.bar}</span>
              <span>{log.pattern}</span>
              <span className="historyChords">{log.chords.join(" ")}</span>
              <span className="historyOutcome">{log.outcome}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
};

const InputRow = ({ input }: { input: InputState }) => (
  <li className="InputRow">
    <span className={input.connected && input.on ? "inputDot connected" : "inputDot"} title={input.connected ? "Connected" : "Not heard from"} />
    <span className="inputTrack">{input.trackName}</span>
    <span className="inputRole">
      {capitalize(input.role)} · {input.kind === "audio" ? "Audio" : "MIDI"}
      {!input.on && " · off"}
    </span>
    <span className="inputNotes">{input.lastNotes.join(" ") || "–"}</span>
  </li>
);

/** What the musician wants the players to play; sent when submitted. */
const DirectionInput = ({ direction, onDirection }: { direction: string; onDirection: (text: string) => void }) => {
  const [text, setText] = useState(direction);
  const [editing, setEditing] = useState(false);
  // Follow the server's value (set from another window, say) unless it's being edited.
  useEffect(() => {
    if (!editing) setText(direction);
  }, [direction, editing]);
  const changed = text.trim() !== direction;
  return (
    <form
      className="direction"
      onSubmit={(event) => {
        event.preventDefault();
        onDirection(text.trim());
        setEditing(false);
      }}
    >
      <label htmlFor="direction">Style</label>
      <input
        id="direction"
        value={text}
        maxLength={MAX_DIRECTION_LENGTH}
        placeholder='e.g. "funky 70s soul, laid back" or "driving punk rock"'
        onChange={(event) => {
          setText(event.target.value);
          setEditing(true);
        }}
        onBlur={() => !changed && setEditing(false)}
      />
      <button type="submit" disabled={!changed}>
        {text.trim() || !direction ? "Set" : "Clear"}
      </button>
    </form>
  );
};

export const SessionPanel = ({ session, onDirection }: { session: SessionState; onDirection: (text: string) => void }) => {
  const { players, inputs, chords, predictedChord, key, bar } = session;
  if (!players.length && !inputs.length) {
    return (
      <section className="SessionPanel empty">
        <p>
          To jam with an AI player, add <b>Session Player</b> to a MIDI track with an instrument, and <b>Session Input</b> as
          the first device on each track it should listen to. The devices are in <code>devices/dist</code>.
        </p>
      </section>
    );
  }
  return (
    <section className="SessionPanel" aria-label="Session">
      <header className="sessionHeader">
        <h2>Session</h2>
        <span className="sessionMeta">{bar ? `Bar ${bar}` : "Stopped"}</span>
        <span className="sessionMeta">{key ?? "Key not clear yet"}</span>
        {chords.length > 0 && (
          <ol className="chordStrip" aria-label="Recent chords">
            {chords.map((chord, i) => (
              <li key={i}>{chord}</li>
            ))}
            {predictedChord && <li className="predicted">{predictedChord}?</li>}
          </ol>
        )}
      </header>
      <DirectionInput direction={session.direction} onDirection={onDirection} />
      {players.length > 0 && (
        <div className="players">
          {players.map((player) => (
            <PlayerCard key={player.deviceId} player={player} />
          ))}
        </div>
      )}
      {inputs.length > 0 ? (
        <ul className="inputs" aria-label="Inputs">
          {inputs.map((input) => (
            <InputRow key={input.deviceId} input={input} />
          ))}
        </ul>
      ) : (
        <p className="playerMessage">No Session Input devices yet, so the players can't hear the band.</p>
      )}
    </section>
  );
};

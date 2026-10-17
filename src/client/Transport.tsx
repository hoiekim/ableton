import React from "react";
import { TransportCommand, TransportState, getPosition } from "common";

export interface Connection {
  label: string;
  tone: "ok" | "pending" | "off";
}

interface Props {
  transport: TransportState;
  connection: Connection;
  disabled: boolean;
  onCommand: (command: TransportCommand) => void;
}

const icons = {
  play: <path d="M7 4.5v15l12.5-7.5z" />,
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="1" />,
  record: <circle cx="12" cy="12" r="6.5" />,
  loop: (
    <path d="M17 5l3 3-3 3V9H8a3 3 0 0 0-3 3H3a5 5 0 0 1 5-5h9zM7 19l-3-3 3-3v2h9a3 3 0 0 0 3-3h2a5 5 0 0 1-5 5H7z" />
  ),
  metronome: <path d="M9.2 3h5.6l4.7 18h-15zM12 6.5l-.9 5.7 4.6-5.2 1.2 1-5 5.6.1 1.4h-3l1.5-8.5z" />,
};

const Icon = ({ name }: { name: keyof typeof icons }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {icons[name]}
  </svg>
);

export const Transport = ({ transport, connection, disabled, onCommand }: Props) => {
  const { isPlaying, songTime, tempo, signatureNumerator, signatureDenominator } = transport;
  const { bar, beat, sixteenth } = getPosition(songTime, signatureNumerator, signatureDenominator);
  const beats = Array.from({ length: Math.min(Math.max(signatureNumerator, 1), 16) }, (_, i) => i + 1);

  return (
    <header className="Transport">
      <div className="transportButtons">
        <button
          type="button"
          className="transportButton play"
          aria-label="Play"
          aria-pressed={isPlaying}
          disabled={disabled}
          onClick={() => onCommand("play")}
        >
          <Icon name="play" />
        </button>
        <button
          type="button"
          className="transportButton"
          aria-label="Stop"
          disabled={disabled}
          onClick={() => onCommand("stop")}
        >
          <Icon name="stop" />
        </button>
        <button
          type="button"
          className="transportButton record"
          aria-label="Arrangement record"
          aria-pressed={transport.recordMode}
          disabled={disabled}
          onClick={() => onCommand("toggleRecord")}
        >
          <Icon name="record" />
        </button>
      </div>

      <div className="position" aria-label={`Bar ${bar}, beat ${beat}, sixteenth ${sixteenth}`}>
        <div className="positionValue">
          <span className="bar">{bar}</span>
          <span className="separator">.</span>
          <span>{beat}</span>
          <span className="separator">.</span>
          <span>{sixteenth}</span>
        </div>
        <div className="beats" aria-hidden="true">
          {beats.map((n) => (
            <span key={n} className={n === beat ? "beat current" : "beat"} />
          ))}
        </div>
      </div>

      <dl className="readouts">
        <div>
          <dt>Tempo</dt>
          <dd>{tempo.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Signature</dt>
          <dd>
            {signatureNumerator}/{signatureDenominator}
          </dd>
        </div>
      </dl>

      <div className="transportButtons">
        <button
          type="button"
          className="transportButton toggle"
          aria-label="Loop"
          aria-pressed={transport.loop}
          disabled={disabled}
          onClick={() => onCommand("toggleLoop")}
        >
          <Icon name="loop" />
        </button>
        <button
          type="button"
          className="transportButton toggle"
          aria-label="Metronome"
          aria-pressed={transport.metronome}
          disabled={disabled}
          onClick={() => onCommand("toggleMetronome")}
        >
          <Icon name="metronome" />
        </button>
      </div>

      <div className={`connection ${connection.tone}`} role="status">
        <span className="connectionDot" />
        {connection.label}
      </div>
    </header>
  );
};

import React, { useEffect, useState } from "react";
import { AuditionResult, CompactNote, PatternPreview, PatternReview, PlayerState, SessionState, TransportState } from "common";
import { fetchJson } from "./api";
import { MiniRoll, pitchRange } from "./MiniRoll";

/** Energies each pattern is shown at. */
const ENERGIES = [3, 6, 9];
const SAMPLE_PROGRESSION = "Am7 Fmaj7 C G";
/** Height of one drum lane in the rolls, in pixels. */
const LANE_HEIGHT = 13;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const providerName = (provider: string) => (provider === "local" ? "the local rules" : provider === "jev" ? "Jev" : provider);

type Sound = NonNullable<PatternReview["sounds"]>[number];

const query = (params: Record<string, string | number>) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

/** A player's patterns at each energy, fetched again when its instrument or the Set's time signature changes. */
const useReviews = (deviceId: number, fill: boolean, chords: string, version: string) => {
  const [reviews, setReviews] = useState<PatternReview[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const load = (energy: number) => fetchJson<PatternReview>(`/api/patterns/${deviceId}?${query({ energy, fill: fill ? 1 : 0, chords })}`);
    Promise.all(ENERGIES.map(load))
      .then((value) => {
        if (cancelled) return;
        setReviews(value);
        setError(undefined);
      })
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
    };
  }, [deviceId, fill, chords, version]);
  return { reviews, error };
};

/** Bar lines and chord names over a roll's bars. */
const Bars = ({ chords, chordNames }: { chords: string[]; chordNames: boolean }) => (
  <div className="rollBars" aria-hidden="true">
    {chords.map((chord, i) => (
      <span key={i} className="rollBar">
        {chordNames && chord}
      </span>
    ))}
  </div>
);

/**
 * Drum notes as lanes, one per sound the pattern plays (highest note on top),
 * each labeled with the kit's name for it.
 */
const DrumRoll = ({ notes, lanes, sounds, beats, chords }: { notes: CompactNote[]; lanes: number[]; sounds: Map<number, Sound>; beats: number; chords: string[] }) => {
  const laneOf = new Map(lanes.map((pitch, i) => [pitch, lanes.length - 1 - i]));
  const laneNotes = notes.map(([pitch, ...rest]): CompactNote => [laneOf.get(pitch) ?? 0, ...rest]);
  const height = Math.max(lanes.length, 2) * LANE_HEIGHT;
  return (
    <div className="drumRoll" style={{ height }}>
      <ul className="laneNames">
        {lanes.map((pitch) => {
          const sound = sounds.get(pitch);
          const title = sound ? `${sound.name} · ${sound.note} · plays ${sound.roles.join(", ")}` : String(pitch);
          return (
            <li key={pitch} title={title}>
              {sound?.name ?? pitch}
            </li>
          );
        })}
      </ul>
      <div className="rollArea">
        <MiniRoll notes={laneNotes} beats={beats} low={0} high={Math.max(lanes.length - 1, 0)} />
        <Bars chords={chords} chordNames={false} />
      </div>
    </div>
  );
};

const FitBadge = ({ fit }: { fit: number }) => {
  if (fit > 0) return <span className="fit good" title={`Fit ${fit}`}>suits the sound</span>;
  if (fit < 0) return <span className="fit poor" title={`Fit ${fit}`}>poor fit</span>;
  return null;
};

const PatternCard = ({
  pattern,
  renders,
  review,
  sounds,
  busy,
  onAudition,
}: {
  pattern: PatternPreview;
  /** The pattern at each energy. */
  renders: (PatternPreview | undefined)[];
  review: PatternReview;
  sounds: Map<number, Sound>;
  busy: boolean;
  onAudition: (energy: number) => void;
}) => {
  const beats = review.chords.length * review.beatsPerBar;
  const all = renders.flatMap((render) => render?.notes ?? []);
  const drums = review.instrument === "drums";
  const lanes = [...new Set(all.map(([pitch]) => pitch))].sort((a, b) => b - a);
  // The same pitch range at every energy, so they compare.
  const [low, high] = pitchRange(all);
  return (
    <article className="PatternCard">
      <div className="patternInfo">
        <header className="patternTitle">
          <b>{pattern.id}</b>
          <span className="patternTag" title="The energy levels the local rules play it at">
            energy {pattern.energy[0]}–{pattern.energy[1]}
          </span>
          {pattern.suits !== "any" && (
            <span className="patternTag" title="How busy the rest of the band should be for it to fit">
              {pattern.suits} band
            </span>
          )}
          {pattern.articulation && <span className="patternTag">{pattern.articulation}</span>}
          <FitBadge fit={pattern.fit} />
        </header>
        <p className="patternDescription">{pattern.description}</p>
      </div>
      <div className="patternRolls">
        {!all.length ? (
          <p className="playerMessage">Plays nothing.</p>
        ) : (
          ENERGIES.map((energy, i) => {
            const notes = renders[i]?.notes ?? [];
            return (
              <div key={energy} className="patternRow">
                <div className="rowHead">
                  <span>Energy {energy}</span>
                  <span className="detailMeta">{notes.length} notes</span>
                  <button
                    type="button"
                    className="audition"
                    disabled={busy}
                    onClick={() => onAudition(energy)}
                    aria-label={`Audition ${pattern.id} at energy ${energy} in Live`}
                    title={`Write this into a free clip slot on ${review.trackName}, without launching it`}
                  >
                    Audition in Live
                  </button>
                </div>
                {drums ? (
                  <DrumRoll notes={notes} lanes={lanes} sounds={sounds} beats={beats} chords={review.chords} />
                ) : (
                  <div className="rollArea melodic">
                    <MiniRoll notes={notes} beats={beats} low={low} high={high} />
                    <Bars chords={review.chords} chordNames />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </article>
  );
};

/** One player's patterns for its current instrument, each at a few energies. */
const PlayerPatterns = ({ player, fill, chords, signature }: { player: PlayerState; fill: boolean; chords: string; signature: string }) => {
  const version = [player.instrument, player.sound?.name, player.sound?.summary, player.provider, signature].join("|");
  const { reviews, error } = useReviews(player.deviceId, fill, chords, version);
  const [audition, setAudition] = useState<{ busy?: boolean; result?: AuditionResult; error?: string }>({});
  const review = reviews?.[0];
  const sounds = new Map((reviews ?? []).flatMap((r) => r.sounds ?? []).map((sound) => [sound.pitch, sound]));

  const onAudition = (pattern: string, energy: number) => {
    setAudition({ busy: true });
    fetchJson<AuditionResult>(`/api/patterns/${player.deviceId}/audition?${query({ pattern, energy, fill: fill ? 1 : 0, chords })}`, {
      method: "POST",
    })
      .then((result) => setAudition({ result }))
      .catch((reason) => setAudition({ error: reason instanceof Error ? reason.message : String(reason) }));
  };

  return (
    <section className="PatternSet" aria-label={`${player.trackName}'s patterns`}>
      <header className="patternSetHeader">
        <h3>{player.trackName}</h3>
        <span className="playerInstrument">
          {player.instrumentSetting === "auto" ? `Auto · ${capitalize(player.instrument)}` : capitalize(player.instrument)}
        </span>
        {review && (
          <span className="sessionMeta">
            {review.patterns.length} patterns offered to {providerName(review.provider)}
          </span>
        )}
      </header>
      <p className="playerSound" title={player.sound?.summary}>
        {player.sound ? player.sound.summary : "No instrument found after the Session Player, so the patterns aren't adapted to a sound."}
      </p>
      {review?.hold && (
        <p className="playerMessage">
          Once it plays, {providerName(review.provider)} can also choose <b>hold</b>: “{review.hold}”
        </p>
      )}
      {audition.result && (
        <p className="auditionNote">
          Wrote “{audition.result.clipName}” into slot {audition.result.slot + 1} on {audition.result.trackName}. Launch it in Live
          {player.active ? "; turn the player off first, or it takes over once it joins." : "."}
        </p>
      )}
      {audition.error && <p className="fallback">{audition.error}</p>}
      {error && <p className="fallback">{error}</p>}
      {!review ? (
        !error && <p className="playerMessage">Loading…</p>
      ) : (
        review.patterns.map((pattern) => (
          <PatternCard
            key={pattern.id}
            pattern={pattern}
            renders={(reviews ?? []).map((r) => r.patterns.find((p) => p.id === pattern.id))}
            review={review}
            sounds={sounds}
            busy={!!audition.busy}
            onAudition={(energy) => onAudition(pattern.id, energy)}
          />
        ))
      )}
    </section>
  );
};

/**
 * The patterns each Session Player chooses from, as the decision model reads
 * them, and what each plays at a few energies, with or without a fill.
 */
export const Patterns = ({ session, transport }: { session: SessionState; transport: TransportState }) => {
  const [fill, setFill] = useState(false);
  const [chords, setChords] = useState(SAMPLE_PROGRESSION);
  const [text, setText] = useState(SAMPLE_PROGRESSION);
  const signature = `${transport.signatureNumerator}/${transport.signatureDenominator}`;
  const { players } = session;

  if (!players.length) {
    return (
      <section className="Patterns">
        <p className="playerMessage">
          No Session Players in this Live Set yet. Add <b>Session Player</b> to a MIDI track, before an instrument, and the patterns it
          chooses from show up here.
        </p>
      </section>
    );
  }

  return (
    <section className="Patterns">
      <div className="patternsHeader">
        <div className="fillSwitch" role="group" aria-label="Fill">
          <button type="button" aria-pressed={!fill} onClick={() => setFill(false)}>
            Without fill
          </button>
          <button type="button" aria-pressed={fill} onClick={() => setFill(true)}>
            With fill
          </button>
        </div>
        <form
          className="direction"
          onSubmit={(event) => {
            event.preventDefault();
            setChords(text.trim() || SAMPLE_PROGRESSION);
          }}
        >
          <label htmlFor="progression">Chords</label>
          <input id="progression" value={text} placeholder={SAMPLE_PROGRESSION} onChange={(event) => setText(event.target.value)} />
          <button type="submit" disabled={(text.trim() || SAMPLE_PROGRESSION) === chords}>
            Render
          </button>
        </form>
        <p className="sessionMeta">
          Each pattern as {signature} bars over these chords, one bar each, the way the player writes it. The description is exactly what
          the decision model reads.
        </p>
      </div>
      {players.map((player) => (
        <PlayerPatterns key={player.deviceId} player={player} fill={fill} chords={chords} signature={signature} />
      ))}
    </section>
  );
};

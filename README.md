# Ableton Live Controller

A web controller for Ableton Live. The server talks to Live through the
LiveAPI.amxd Max for Live device from the `ableton-live` package
(`node_modules/ableton-live/external/LiveAPI.amxd`), which has to be loaded on a
track in Live, and shows each track's devices and the transport in the browser.

Requires [Bun](https://bun.sh), which installs, builds and runs everything:

```bash
bun install
bun run build && bun run start
```

The server listens on `PORT` (default 3005) and looks for the bridge on
`LIVE_HOST:LIVE_PORT` (default 127.0.0.1:9001).

## Session Player

An AI band member: it listens to what the other tracks play and plays its own
part (drums, bass, keys or guitar), deciding bar by bar and writing each
decision as a MIDI clip that Live starts on the next bar.

1. Put **Session Player** (`devices/Session Player.amxd`) on a MIDI track,
   before an instrument, and pick what it plays, or leave it on Auto: it reads
   the instrument (a Drum Rack's pads, a synth's preset and envelope) and plays
   drums, bass, guitar or keys to match, telling the decision model which
   sound is on which note. Keep the track for the player:
   it writes into its last 4 clip slots, and launching a scene also launches
   that row's slot.
2. Put **Session Input** (`devices/Session Input.amxd`) first on each MIDI track
   it should hear, or **Session Input Audio** first on audio tracks (one note at
   a time: bass, vocals, lead). First in the chain means the player hears the
   part before any effects. Set each input's Role if Auto guesses wrong.
3. Optionally, put **Session Voice** (`devices/Session Voice.amxd`) first on a
   vocal track so the players hear what's said or sung there (see
   [Talking to the players](#talking-to-the-players)).
4. Start the server, open the web page and press Play. The player listens for
   a bar (Join after), then joins. The Session panel shows each decision, what
   the decision model was told, how long it took and how early the clip was in
   place.

Each track row on the web page has a **Listen** switch: it turns that track's
Session Input and Session Voice on or off (their On switch in Live), so you
can take a part out of what the players hear without touching Live. Tracks
without either device show it greyed out.

How it decides: the server sums up the band as text (chords, predicted next
chord, key, rhythm, energy, where the phrase is) and asks a decision model to
pick one of the instrument's patterns, an energy level and whether to fill. The
pattern is then played on the right chords.

The next bar's chord comes from the band's clips when it plays them: for each
MIDI track with a Session Input, the server reads the clip that's playing (and
reads it again when its notes or loop change), so the player is on the right
chord from its first bar. What's played live can only be predicted from what's
been heard, so there the player follows once the progression has come round
once. A clip the band launches mid-jam is read when it starts, so its first bar
is still a guess.

By default fast local rules decide; with `TYPESAFE_API_KEY` set (for example
in a `.env` file in the project folder, which Bun reads at startup), TypeSafe's
[Jev](https://docs.typesafe.ai) does, falling back to the rules when it's unsure
or too slow. If Jev takes longer than a bar, raise the device's Lookahead.

To steer the style, type it in the Session panel's **Style** box, for example
"funky 70s soul, laid back" or "driving punk rock". Jev reads it with every
decision. Without Jev, the local rules pick up common genre words (funk, jazz,
house, rock, reggae, latin…) and mood words (laid back, intense…). The box
applies to all players and resets when the server restarts.

### Talking to the players

With Session Voice on a vocal track, what you say or sing there goes to the
players as text: "are you ready?", "ok let's go, give me a cue", "take it down",
or just the lyrics. It's transcribed on this Mac by
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), offline. Set it up once:

```bash
brew install whisper-cpp
```

```bash
mkdir -p models && curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

The server starts whisper-server itself when it finds a Session Voice device
(on port 9103; `SESSION_WHISPER_PORT` moves it) and stops it on exit. The
Session panel's **Heard** line shows whether speech-to-text is ready and the
latest phrases.

Jev decides what to do with what it hears; the local rules ignore it. A phrase
reaches Jev about a second after you stop talking (0.7 s to be sure you've
stopped, then ~0.3 s to transcribe), and stays in what it reads for 4 bars.
- **Coming in:** while a player waits to join, anything said makes the server
  ask Jev whether to start now. "Ok let's go" brings it in at the next bar it
  can make; "are you ready?" usually doesn't.
- **Cues:** right after someone asks for a cue or a change, Jev may play a fill
  straight away rather than waiting for the end of the phrase (once per phrase
  said).
- **Everything else**, like "take it down" or the lyrics' mood, steers its
  choice of pattern and energy.

Set the device's Threshold just above the band's spill into the mic, using its
meter: louder than that counts as a phrase. Phrases longer than 10 s are split.

How it all fits together, and how it was tested: [docs/DESIGN.md](docs/DESIGN.md).

Everything is adjustable in [session.config.ts](session.config.ts): the
decision model, timing margins, clip slots, phrase length, and your own
patterns (see [src/server/session/patterns](src/server/session/patterns)).
`SESSION_PROVIDER=local|jev` overrides the config, and `SESSION_WHISPER_MODEL`
picks another whisper.cpp model.

The devices are generated by `bun run build:devices` from
[scripts/build-devices.ts](scripts/build-devices.ts). They send notes to the
server over OSC on UDP 9101 (`SESSION_OSC_PORT` moves it).

## Developing without Live

`bun run mock` serves a stand-in for the LiveAPI.amxd bridge on
`ws://127.0.0.1:9001/ableton-live` with a sample Live Set. Run it next to the
server:

```bash
bun run mock
```

```bash
bun run build && PORT=3006 bun run start
```

Then open http://localhost:3006. Set `LIVE_PORT` for both processes to move the
mock off 9001. `MOCK_VERBOSE=1` logs every request, and `MOCK_LATENCY=<ms>`
delays every reply.

The mock logs a warning whenever the server asks for a property an object
doesn't have, which real Live only reports as an error in Max's console.

To change the Set while the UI is open, use the control endpoint. With no
`action` it lists every action and the current tracks and devices:

```bash
curl http://127.0.0.1:9001/mock
```

```bash
curl 'http://127.0.0.1:9001/mock?action=add-device&track=1&class=Reverb'
```

```bash
curl 'http://127.0.0.1:9001/mock?action=drop'
```

`drop` cuts the connection the way a Live crash would, and `down&seconds=5`
stops listening for a while the way quitting Live would.

The mock's Set has two Session Players (AI Drums and AI Guitar), Session
Inputs on Bass, Keys and Vocals, and a Session Voice on Vocals. While it plays, a scripted band sends those
inputs' notes to the server (Vocals as pitch readings, like the audio device),
and each clip the players write is logged per bar, so you can watch them jam:

```bash
curl 'http://127.0.0.1:9001/mock?action=play'
```

```bash
curl 'http://127.0.0.1:9001/mock?action=band-chords&chords=Dm7,G7,Cmaj7,Cmaj7'
```

```bash
curl 'http://127.0.0.1:9001/mock?action=clips'
```

The band can also play from clips, the way the server reads ahead: `band-clips`
writes its parts as looping clips on Bass and Keys (Vocals stays scripted), and
`scene` launches them; launched while stopped, the clips and the transport
start together. Each Session Input then forwards what its track's clip plays.
Running `band-clips` again while they play edits the clips in place.

```bash
curl 'http://127.0.0.1:9001/mock?action=band-clips&chords=Am7,Fmaj7,C,G'
```

```bash
curl 'http://127.0.0.1:9001/mock?action=scene&scene=0'
```

`MOCK_BAND=0` silences the scripted band (clips still play) and
`MOCK_CLIP_LOG=0` the clip log.

`say` speaks a phrase into the Session Voice device with macOS's `say`, the
way singing into it would. It needs the whisper.cpp setup above.

```bash
curl 'http://127.0.0.1:9001/mock?action=say&text=ok%20lets%20go%2C%20give%20me%20a%20cue'
```

`bun run jam-check` does all of this on its own ports (9201, 9202, 9203 and
3201, so it can run next to Live or another mock): it starts the mock and the server,
has the band play, and checks the chord of every clip the AI Guitar fires
against the band's. `--band live` uses the scripted band instead of clips,
`--tempo 80,120,160` runs several tempos, `--bars`, `--chords` and
`--edit 6:Dm7,G7,Cmaj7,Am7` (rewrite the clips mid-jam) set up the jam, and
`--log` prints the mock's clip log.

```bash
bun run jam-check -- --tempo 80,120,160 --bars 12
```

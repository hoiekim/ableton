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

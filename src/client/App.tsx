import React, { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { Patterns } from "./Patterns";
import { SessionPanel } from "./SessionPanel";
import { Connection, Transport } from "./Transport";
import { TrackRow } from "./TrackRow";
import { useLiveSocket } from "./useLiveSocket";

type View = "tracks" | "dashboard" | "patterns";

const viewFromHash = (): View => {
  if (window.location.hash === "#dashboard") return "dashboard";
  return window.location.hash === "#patterns" ? "patterns" : "tracks";
};

/** Which view is open, kept in the address so it survives a reload. */
const useView = () => {
  const [view, setView] = useState(viewFromHash);
  useEffect(() => {
    const onChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return view;
};

export const App = () => {
  const { isOnline, state, sendCommand, sendDirection, sendListen } = useLiveSocket();
  const view = useView();
  const { status, transport, tracks } = state;

  let connection: Connection;
  let notice: string | undefined;
  if (!isOnline) {
    connection = { label: "Server offline", tone: "off" };
    notice = "Can't reach the controller server. Retrying…";
  } else if (status === "disconnected") {
    connection = { label: "Waiting for Live", tone: "off" };
    notice =
      "Waiting for Ableton Live. Open your Live Set and drop LiveAPI.amxd " +
      "(from node_modules/ableton-live/external) onto any track.";
  } else if (status === "connecting") {
    connection = { label: "Connecting", tone: "pending" };
    if (!tracks.length) notice = "Loading Live Set…";
  } else {
    connection = { label: "Live connected", tone: "ok" };
    if (!tracks.length) notice = "This Live Set has no tracks.";
  }

  return (
    <div className="App">
      <Transport
        transport={transport}
        connection={connection}
        disabled={status !== "connected"}
        onCommand={sendCommand}
      />
      {status === "connected" && (
        <nav className="viewTabs" aria-label="Views">
          <a href="#" className={view === "tracks" ? "active" : undefined} aria-current={view === "tracks" ? "page" : undefined}>
            Tracks
          </a>
          <a href="#dashboard" className={view === "dashboard" ? "active" : undefined} aria-current={view === "dashboard" ? "page" : undefined}>
            Dashboard
          </a>
          <a href="#patterns" className={view === "patterns" ? "active" : undefined} aria-current={view === "patterns" ? "page" : undefined}>
            Patterns
          </a>
        </nav>
      )}
      {status === "connected" && view === "dashboard" ? (
        <Dashboard session={state.session} transport={transport} onDirection={sendDirection} />
      ) : status === "connected" && view === "patterns" ? (
        <Patterns session={state.session} transport={transport} />
      ) : (
        <>
          {status === "connected" && <SessionPanel session={state.session} onDirection={sendDirection} />}
          <main className="tracks">
            {tracks.map((track) => (
              <TrackRow key={track.id} track={track} onListen={sendListen} />
            ))}
            {notice && <p className="notice">{notice}</p>}
          </main>
        </>
      )}
    </div>
  );
};

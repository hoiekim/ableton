import React from "react";
import { SessionPanel } from "./SessionPanel";
import { Connection, Transport } from "./Transport";
import { TrackRow } from "./TrackRow";
import { useLiveSocket } from "./useLiveSocket";

export const App = () => {
  const { isOnline, state, sendCommand } = useLiveSocket();
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
      {status === "connected" && <SessionPanel session={state.session} />}
      <main className="tracks">
        {tracks.map((track) => (
          <TrackRow key={track.id} track={track} />
        ))}
        {notice && <p className="notice">{notice}</p>}
      </main>
    </div>
  );
};

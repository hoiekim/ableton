import React from "react";
import { DeviceState, DeviceType, TrackState, TrackType, isDeviceStash } from "common";

const trackTypeLabels: Record<TrackType, string> = {
  audio: "Audio",
  midi: "MIDI",
  group: "Group",
  return: "Return",
  master: "Master",
};

const deviceTypeLabels: Record<DeviceType, string> = {
  instrument: "Instrument",
  audio_effect: "Audio Effect",
  midi_effect: "MIDI Effect",
  undefined: "Device",
};

/** "Session Player · Bass", "Session Input · Chords" or "Session Voice · On", from the device's parameters. */
const sessionLabel = (device: DeviceState) => {
  const { session } = device;
  if (!session) return undefined;
  if (session.kind === "player") return `Session Player · ${session.params["SP Instrument"]?.label ?? ""}`;
  if (session.kind === "voice") return `Session Voice · ${(session.params["SPV On"]?.value ?? 1) >= 1 ? "On" : "Off"}`;
  return `Session Input · ${session.params["SPI Role"]?.label ?? ""}`;
};

const DeviceCard = ({ device }: { device: DeviceState }) => {
  const { name, classDisplayName, type, isActive } = device;
  const session = sessionLabel(device);
  const className = ["DeviceCard", type, isActive ? "" : "inactive", session ? "session" : ""].filter(Boolean).join(" ");
  return (
    <li className={className}>
      <span className="deviceName">{name}</span>
      {session ? (
        <span className="deviceClass">{session}</span>
      ) : (
        classDisplayName && classDisplayName !== name && <span className="deviceClass">{classDisplayName}</span>
      )}
      <span className="deviceType">
        {deviceTypeLabels[type]}
        {!isActive && " · Off"}
      </span>
    </li>
  );
};

const Flag = ({ label, title, on }: { label: string; title: string; on: boolean }) => (
  <span className={on ? "flag on" : "flag"} title={title}>
    {label}
  </span>
);

/**
 * Whether the Session Players hear this track: the On switch of its Session
 * Input and Session Voice devices. Tracks without one can't be heard until it's added.
 */
/** The Session device that lets the players hear a track of this type. */
export const inputFor = (type: TrackType) => (type === "audio" ? "Session Input Audio" : "Session Input");

/** Whether the Session Devices track holds a spare input for a track of this type. */
export const canAddInput = (tracks: TrackState[], type: TrackType) => {
  const kind: DeviceType = type === "audio" ? "audio_effect" : "midi_effect";
  return tracks.some((t) => isDeviceStash(t.name) && t.devices.some((d) => d.session?.kind === "input" && d.type === kind));
};

const ListenSwitch = ({
  track,
  canAdd,
  onListen,
}: {
  track: TrackState;
  /** A spare input is on the Session Devices track, ready to be copied here. */
  canAdd: boolean;
  onListen: (trackId: number, on: boolean) => void;
}) => {
  if (track.type === "return" || track.type === "master" || track.type === "group") return null;
  if (isDeviceStash(track.name)) return <span className="listenNote">Spare Session devices</span>;
  if (track.devices.some((device) => device.session?.kind === "player")) return <span className="listenNote">AI player</span>;
  const listeners = track.devices.filter((device) => device.session?.kind === "input" || device.session?.kind === "voice");
  if (!listeners.length) {
    const device = inputFor(track.type);
    return canAdd ? (
      <label className="listen" title={`Adds ${device} as this track's first device (copied from the Session Devices track), so the players hear it`}>
        <input type="checkbox" checked={false} onChange={(event) => event.target.checked && onListen(track.id, true)} />
        <span>Listen</span>
      </label>
    ) : (
      <span className="listen unavailable">
        <label title={`The players can't hear this track: it needs ${device} as its first device.`}>
          <input type="checkbox" disabled checked={false} readOnly />
          <span>Listen</span>
        </label>
        <span className="listenHint">Needs {device}</span>
      </span>
    );
  }
  const on = listeners.every((device) => {
    const param = device.session!.kind === "voice" ? "SPV On" : "SPI On";
    return device.isActive && (device.session!.params[param]?.value ?? 1) >= 1;
  });
  return (
    <label className="listen" title={on ? "The Session Players hear this track" : "The Session Players ignore this track"}>
      <input type="checkbox" checked={on} onChange={(event) => onListen(track.id, event.target.checked)} />
      <span>Listen</span>
    </label>
  );
};

export const TrackRow = ({
  track,
  canAdd,
  onListen,
}: {
  track: TrackState;
  canAdd: boolean;
  onListen: (trackId: number, on: boolean) => void;
}) => {
  const { name, type, color, mute, solo, arm, devices } = track;
  const style = { "--track-color": color } as React.CSSProperties;
  return (
    <section className={`TrackRow ${type}`} style={style} aria-label={name}>
      <div className="trackHeader">
        <span className="trackName">{name}</span>
        <span className="trackMeta">
          <span className="trackType">{trackTypeLabels[type]}</span>
          {type !== "master" && (
            <span className="flags">
              <Flag label="M" title="Muted" on={mute} />
              <Flag label="S" title="Soloed" on={solo} />
              {(type === "audio" || type === "midi") && <Flag label="●" title="Armed" on={arm} />}
            </span>
          )}
        </span>
        <ListenSwitch track={track} canAdd={canAdd} onListen={onListen} />
      </div>
      <ol className="devices">
        {devices.length ? (
          devices.map((device) => <DeviceCard key={device.id} device={device} />)
        ) : (
          <li className="noDevices">No devices</li>
        )}
      </ol>
    </section>
  );
};

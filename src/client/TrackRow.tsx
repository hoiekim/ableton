import React from "react";
import { DeviceState, DeviceType, TrackState, TrackType } from "common";

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

/** "Session Player · Bass" or "Session Input · Chords", from the device's parameters. */
const sessionLabel = (device: DeviceState) => {
  const { session } = device;
  if (!session) return undefined;
  if (session.kind === "player") return `Session Player · ${session.params["SP Instrument"]?.label ?? ""}`;
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

export const TrackRow = ({ track }: { track: TrackState }) => {
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

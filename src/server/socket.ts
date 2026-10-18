import type { ServerWebSocket, WebSocketHandler } from "bun";
import { ClientMessage, ServerMessage, TransportCommand, isTransportCommand } from "common";
import { LiveStore, StoreChange } from "./store";

// Changes are batched so a burst of updates from Live goes out as one message per kind.
const FLUSH_INTERVAL = 30;

type ClientChange = Exclude<StoreChange, "clips">;

const allChanges: ClientChange[] = ["status", "tracks", "transport", "session"];

const toMessage = (change: ClientChange, store: LiveStore): ServerMessage => {
  const { status, tracks, transport } = store.state;
  switch (change) {
    case "status":
      return { type: "status", status };
    case "tracks":
      return { type: "tracks", tracks };
    case "transport":
      return { type: "transport", transport };
    case "session":
      return { type: "session", session: store.session };
  }
};

const parseMessage = (data: string): ClientMessage | undefined => {
  try {
    const message = JSON.parse(data);
    if (message?.type === "command" && isTransportCommand(message.command)) return message;
  } catch {
    // Ignore malformed messages.
  }
  return undefined;
};

/**
 * WebSocket handlers for Bun.serve: sends every client the full state on
 * connect, then streams changes and forwards transport commands.
 */
export const createSocketHandler = (
  store: LiveStore,
  onCommand: (command: TransportCommand) => void
): WebSocketHandler => {
  const sockets = new Set<ServerWebSocket>();
  const changes = new Set<ClientChange>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    flushTimer = undefined;
    changes.forEach((change) => {
      const data = JSON.stringify(toMessage(change, store));
      sockets.forEach((socket) => socket.send(data));
    });
    changes.clear();
  };

  store.subscribe((change) => {
    if (change === "clips") return;
    changes.add(change);
    flushTimer ??= setTimeout(flush, FLUSH_INTERVAL);
  });

  return {
    open: (socket) => {
      sockets.add(socket);
      allChanges.forEach((change) => socket.send(JSON.stringify(toMessage(change, store))));
    },
    message: (_socket, data) => {
      const message = parseMessage(data.toString());
      if (message) onCommand(message.command);
    },
    close: (socket) => {
      sockets.delete(socket);
    },
  };
};

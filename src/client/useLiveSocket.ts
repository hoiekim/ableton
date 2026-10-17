import { useCallback, useEffect, useRef, useState } from "react";
import { ClientMessage, LiveState, SOCKET_PATH, ServerMessage, TransportCommand, initialLiveState } from "common";

const RECONNECT_INTERVAL = 1000;

const applyMessage = (state: LiveState, message: ServerMessage): LiveState => {
  switch (message.type) {
    case "status":
      return { ...state, status: message.status };
    case "tracks":
      return { ...state, tracks: message.tracks };
    case "transport":
      return { ...state, transport: message.transport };
    default:
      return state;
  }
};

/**
 * Mirrors the server's view of the Live Set over a WebSocket and reconnects
 * whenever the server goes away.
 */
export const useLiveSocket = () => {
  const [isOnline, setIsOnline] = useState(false);
  const [state, setState] = useState<LiveState>(initialLiveState);
  const socketRef = useRef<WebSocket>();

  useEffect(() => {
    let socket: WebSocket;
    let retryTimer: number | undefined;
    let isClosed = false;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}${SOCKET_PATH}`);
      socketRef.current = socket;

      socket.onopen = () => setIsOnline(true);
      socket.onmessage = (event) => {
        const message: ServerMessage = JSON.parse(event.data);
        setState((previous) => applyMessage(previous, message));
      };
      socket.onclose = () => {
        setIsOnline(false);
        setState(initialLiveState);
        if (!isClosed) retryTimer = window.setTimeout(connect, RECONNECT_INTERVAL);
      };
    };

    connect();

    return () => {
      isClosed = true;
      window.clearTimeout(retryTimer);
      socket.close();
    };
  }, []);

  const sendCommand = useCallback((command: TransportCommand) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const message: ClientMessage = { type: "command", command };
    socket.send(JSON.stringify(message));
  }, []);

  return { isOnline, state, sendCommand };
};

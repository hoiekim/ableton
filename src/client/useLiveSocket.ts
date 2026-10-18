import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClientMessage,
  LiveState,
  SOCKET_PATH,
  ServerMessage,
  SessionState,
  TransportCommand,
  initialLiveState,
  initialSessionState,
} from "common";

const RECONNECT_INTERVAL = 1000;

export type ClientState = LiveState & { session: SessionState };

const initialState: ClientState = { ...initialLiveState, session: initialSessionState };

const applyMessage = (state: ClientState, message: ServerMessage): ClientState => {
  switch (message.type) {
    case "status":
      return { ...state, status: message.status };
    case "tracks":
      return { ...state, tracks: message.tracks };
    case "transport":
      return { ...state, transport: message.transport };
    case "session":
      return { ...state, session: message.session };
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
  const [state, setState] = useState<ClientState>(initialState);
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
        setState(initialState);
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

import path from "path";
import { stat } from "fs/promises";
import { SOCKET_PATH } from "common";
import { LiveBridge } from "./live";
import { SessionEngine } from "./session/engine";
import { createSocketHandler } from "./socket";
import { LiveStore } from "./store";

// Bun's bundler inlines __dirname as the source directory, so resolve from the
// running script (dist/server/index.js) instead.
const clientPath = path.resolve(path.dirname(process.argv[1]), "..", "client");
const indexPath = path.join(clientPath, "index.html");

const isFile = async (filePath: string) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

/** Serves files from dist/client, falling back to index.html for any other path. */
const serveClient = async (pathname: string) => {
  let filePath: string | undefined;
  try {
    filePath = path.join(clientPath, decodeURIComponent(pathname));
  } catch {
    // Malformed escape sequence.
  }
  const isInside = filePath?.startsWith(clientPath + path.sep);
  if (filePath && isInside && (await isFile(filePath))) return new Response(Bun.file(filePath));
  return new Response(Bun.file(indexPath));
};

const store = new LiveStore();
const bridge = new LiveBridge(store);

const websocket = createSocketHandler(store, (command) => {
  bridge.command(command).catch((error) => {
    console.error(`[live] Command "${command}" failed:`, error);
  });
});

Bun.serve({
  port: Number(process.env.PORT) || 3005,
  fetch: (req, server) => {
    const { pathname } = new URL(req.url);
    if (pathname === SOCKET_PATH) {
      if (server.upgrade(req)) return;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    return serveClient(pathname);
  },
  websocket,
});

console.info("ableton-live-controller server is up.");

bridge.start();

new SessionEngine(store, bridge.ops).start();

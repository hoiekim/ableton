import path from "path";
import { stat } from "fs/promises";
import { SOCKET_PATH } from "common";
import { LiveBridge } from "./live";
import { SessionEngine } from "./session/engine";
import { AuditionError, parseReviewRequest } from "./session/review";
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

const session = new SessionEngine(store, bridge.ops);

const websocket = createSocketHandler(store, {
  onCommand: (command) => {
    bridge.command(command).catch((error) => {
      console.error(`[live] Command "${command}" failed:`, error);
    });
  },
  onDirection: session.setDirection,
  onListen: session.setListening,
});

Bun.serve({
  port: Number(process.env.PORT) || 3005,
  fetch: (req, server) => {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === SOCKET_PATH) {
      if (server.upgrade(req)) return;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    // /api/decisions/<deviceId>/<bar>: what a player sent and got back for that bar.
    const decision = pathname.match(/^\/api\/decisions\/(\d+)\/(\d+)$/);
    if (decision) {
      const detail = session.decisionDetail(Number(decision[1]), Number(decision[2]));
      return detail ? Response.json(detail) : new Response("No such decision (only the latest are kept)", { status: 404 });
    }
    // /api/patterns/<deviceId>?energy=6&fill=0&chords=Am7,Fmaj7,C,G: a player's patterns, rendered.
    // POST /api/patterns/<deviceId>/audition?pattern=<id>&…: one of them written into a clip slot.
    const patterns = pathname.match(/^\/api\/patterns\/(\d+)(\/audition)?$/);
    if (patterns) {
      const request = parseReviewRequest(searchParams);
      if (typeof request === "string") return new Response(request, { status: 400 });
      const deviceId = Number(patterns[1]);
      if (!patterns[2]) {
        const review = session.patternReview(deviceId, request);
        return review ? Response.json(review) : new Response("No such Session Player", { status: 404 });
      }
      if (req.method !== "POST") return new Response("Audition with POST", { status: 405 });
      return session.auditionPattern(deviceId, searchParams.get("pattern") ?? "", request).then(
        (result) => Response.json(result),
        (error) => {
          const status = error instanceof AuditionError ? error.status : 500;
          if (status === 500) console.error("[session] Audition failed:", error);
          return new Response(error instanceof Error ? error.message : String(error), { status });
        }
      );
    }
    // An API route this server doesn't have: say so, rather than answering with the page.
    if (pathname.startsWith("/api/")) return new Response(`No such API route: ${pathname}`, { status: 404 });
    return serveClient(pathname);
  },
  websocket,
});

console.info("ableton-live-controller server is up.");

bridge.start();

session.start();

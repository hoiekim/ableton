import fs from "fs";
import path from "path";
import packageJson from "./package.json";

const DOT = ".";
const SRC = "src";
const PUBLIC = "public";
const DIST = "dist";
const CLIENT = "client";
const SERVER = "server";

const SRC_PATH = path.join(DOT, SRC);
const DIST_PATH = path.join(DOT, DIST);

const SRC_CLIENT_PATH = path.join(SRC_PATH, CLIENT);
const DIST_CLIENT_PATH = path.join(DIST_PATH, CLIENT);
const PUBLIC_PATH = path.join(DOT, PUBLIC);
const SRC_CLIENT_ENTRY = path.join(SRC_CLIENT_PATH, "index.tsx");
const DIST_CLIENT_HTML = path.join(DIST_CLIENT_PATH, "index.html");

const SRC_SERVER_PATH = path.join(SRC_PATH, SERVER);
const DIST_SERVER_PATH = path.join(DIST_PATH, SERVER);
const SRC_SERVER_ENTRY = path.join(SRC_SERVER_PATH, "index.ts");

const assertSuccess = (output: Awaited<ReturnType<typeof Bun.build>>, label: string) => {
  if (output.success) return;
  output.logs.forEach((log) => console.error(log));
  throw new Error(`Failed to build ${label}`);
};

const main = async () => {
  fs.rmSync(DIST_CLIENT_PATH, { recursive: true, force: true });
  fs.cpSync(PUBLIC_PATH, DIST_CLIENT_PATH, { recursive: true });

  const builtClient = await Bun.build({
    entrypoints: [SRC_CLIENT_ENTRY],
    outdir: DIST_CLIENT_PATH,
    naming: "[dir]/[name].[hash].[ext]",
  });
  assertSuccess(builtClient, "client");

  const clientEntry = builtClient.outputs.find((output) => output.kind === "entry-point");
  if (!clientEntry) throw new Error("Client build produced no entry point");
  const clientFilename = path.basename(clientEntry.path);
  console.log(clientFilename);

  const script = `<script type="module" src="/${clientFilename}"></script>\n`;
  const html = fs.readFileSync(DIST_CLIENT_HTML, "utf8");
  fs.writeFileSync(DIST_CLIENT_HTML, html.replace("</body>", `  ${script}  </body>`));

  // Runtime dependencies stay in node_modules so Bun can use its native
  // implementations (e.g. of "ws") instead of bundled copies.
  fs.rmSync(DIST_SERVER_PATH, { recursive: true, force: true });
  const builtServer = await Bun.build({
    entrypoints: [SRC_SERVER_ENTRY],
    outdir: DIST_SERVER_PATH,
    naming: "[dir]/[name].[ext]",
    target: "bun",
    external: Object.keys(packageJson.dependencies),
  });
  assertSuccess(builtServer, "server");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import { createExports } from "./exports";
import { mountMcp } from "./mcp";
import { LockedError, openDataDir } from "./persist";
import { createRenderBroker } from "./render";
import { createWorkspace } from "./workspace";
import { attachWebSocket } from "./ws";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", short: "p" },
    data: { type: "string", short: "d" },
    host: { type: "string", short: "h" },
  },
  strict: false,
});

const HOST = (values.host as string | undefined) ?? process.env.HOST ?? "127.0.0.1";
const requestedPort = values.port ? Number(values.port) : Number(process.env.PORT ?? 5170);
const rawDataDir = (values.data as string | undefined) ?? process.env.DATA_DIR ?? "data";
const DATA_DIR = path.resolve(rawDataDir);

let data;
try {
  data = openDataDir(DATA_DIR);
} catch (err) {
  if (!(err instanceof LockedError)) throw err;
  console.error(err.message);
  process.exit(1);
}
const dataDir = data;
const workspace = createWorkspace(dataDir);
process.on("exit", () => {
  workspace.flush();
  dataDir.release();
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));

workspace.restore();

// Pre-configured with JSON body parsing and DNS-rebinding protection for localhost.
const app = createMcpExpressApp({ host: HOST });
const httpServer = createHttpServer(app);

// render_view (09.3): the editor tabs render for the agent.
const renders = createRenderBroker();
// The Unity export (15.2): each scene's folder, Export now, and exporting after every step.
const exports = createExports(workspace, dataDir);
mountMcp(app, workspace, renders, exports);

const distWeb = path.resolve(fileURLToPath(new URL("../../dist/web", import.meta.url)));
const isProd = process.env.NODE_ENV === "production" || (fs.existsSync(distWeb) && process.env.NODE_ENV !== "development");

let activePort = requestedPort;

// Health check endpoint for the companion app and automation
app.get("/api/health", (_req, res) => {
  const open = workspace.getOpen();
  res.json({
    status: "ok",
    mode: isProd ? "production" : "development",
    port: activePort,
    host: HOST,
    dataDir: DATA_DIR,
    open: open ? { project: open.project, scene: open.scene } : null,
  });
});

// Shot images (09.1), for the editor's thumbnails and downloads. Revalidated each time (IDs are never reused, but a
// scene can be deleted by hand and made again with the same name).
app.get("/shots/:project/:kind/:doc/:file", (req, res) => {
  const { project, kind, doc, file } = req.params;
  const match = /^(shot_\d+)\.png$/.exec(file);
  const found = match && (kind === "scenes" || kind === "entities") ? workspace.shotImageFile(project, kind, doc, match[1]) : null;
  if (!found) return void res.status(404).send("No such shot");
  res.sendFile(found, { headers: { "Cache-Control": "no-cache" } });
});
// The open scene as a 3D file (15.2), for the editor to save where the human says.
app.get("/api/export.glb", async (_req, res) => {
  try {
    const { name, glb } = await exports.glbOpen();
    res.set({ "Content-Type": "model/gltf-binary", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
    res.send(glb);
  } catch (err) {
    res.status(409).type("text/plain").send((err as Error).message);
  }
});
attachWebSocket(httpServer, workspace, renders, exports);

if (isProd && fs.existsSync(distWeb)) {
  app.use(express.static(distWeb));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/shots") || req.path.startsWith("/mcp") || req.path.startsWith("/ws")) {
      return next();
    }
    res.sendFile(path.join(distWeb, "index.html"));
  });
} else {
  const react = (await import("@vitejs/plugin-react")).default;
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: false,
    root: fileURLToPath(new URL("../web", import.meta.url)),
    plugins: [react()],
    appType: "spa",
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  app.use(vite.middlewares);
}

function listenWithFallback(server: HttpServer, startPort: number, host: string, maxAttempts = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    let currentPort = startPort;
    let attempts = 0;

    const tryListen = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);
        if (err.code === "EADDRINUSE" && attempts < maxAttempts) {
          attempts++;
          currentPort++;
          tryListen();
        } else {
          reject(err);
        }
      };

      server.once("error", onError);
      server.listen(currentPort, host, () => {
        server.removeListener("error", onError);
        resolve(currentPort);
      });
    };

    tryListen();
  });
}

try {
  activePort = await listenWithFallback(httpServer, requestedPort, HOST);
  console.log(`orlablocks editor (${isProd ? "production" : "development"}): http://${HOST}:${activePort}`);
  console.log(`MCP endpoint:            http://${HOST}:${activePort}/mcp`);
  const open = workspace.getOpen();
  console.log(`Data folder:             ${DATA_DIR}`);
  console.log(`Open scene:              ${open ? `${open.project.name} ▸ ${open.scene.name}` : "none (create a project in the editor)"}`);
} catch (err) {
  console.error(`Failed to start server on ${HOST} (ports ${requestedPort}..${requestedPort + 10}):`, err);
  process.exit(1);
}

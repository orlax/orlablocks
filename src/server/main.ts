import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { mountMcp } from "./mcp";
import { LockedError, openDataDir } from "./persist";
import { createWorkspace } from "./workspace";
import { attachWebSocket } from "./ws";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 5170);

// The data folder: ./data where the server runs, or DATA_DIR. Scripted checks must point DATA_DIR elsewhere.
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");

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

mountMcp(app, workspace);

// Shot images (09.1), for the editor's thumbnails and downloads. Revalidated each time (IDs are never reused, but a
// scene can be deleted by hand and made again with the same name).
app.get("/shots/:project/:kind/:doc/:file", (req, res) => {
  const { project, kind, doc, file } = req.params;
  const match = /^(shot_\d+)\.png$/.exec(file);
  const found = match && (kind === "scenes" || kind === "entities") ? workspace.shotImageFile(project, kind, doc, match[1]) : null;
  if (!found) return void res.status(404).send("No such shot");
  res.sendFile(found, { headers: { "Cache-Control": "no-cache" } });
});
attachWebSocket(httpServer, workspace);

const vite = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("../web", import.meta.url)),
  plugins: [react()],
  appType: "spa",
  server: { middlewareMode: true, hmr: { server: httpServer } },
});
app.use(vite.middlewares);

httpServer.listen(PORT, HOST, () => {
  console.log(`orlablocks editor: http://${HOST}:${PORT}`);
  console.log(`MCP endpoint:            http://${HOST}:${PORT}/mcp`);
  const open = workspace.getOpen();
  console.log(`Data folder:             ${DATA_DIR}`);
  console.log(`Open scene:              ${open ? `${open.project.name} ▸ ${open.scene.name}` : "none (create a project in the editor)"}`);
});

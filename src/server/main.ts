import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { mountMcp } from "./mcp";
import { createSceneStore } from "./scene";
import { attachWebSocket } from "./ws";

const HOST = "127.0.0.1";
const PORT = 5170;

const store = createSceneStore();

// Pre-configured with JSON body parsing and DNS-rebinding protection for localhost.
const app = createMcpExpressApp({ host: HOST });
const httpServer = createHttpServer(app);

mountMcp(app, store);
attachWebSocket(httpServer, store);

const vite = await createViteServer({
  configFile: false,
  root: fileURLToPath(new URL("../web", import.meta.url)),
  plugins: [react()],
  appType: "spa",
  server: { middlewareMode: true, hmr: { server: httpServer } },
});
app.use(vite.middlewares);

httpServer.listen(PORT, HOST, () => {
  console.log(`Dungeon Designer editor: http://${HOST}:${PORT}`);
  console.log(`MCP endpoint:            http://${HOST}:${PORT}/mcp`);
});

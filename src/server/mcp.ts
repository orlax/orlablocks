import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { RectInputSchema } from "../shared/scene.types";
import type { SceneStore } from "./scene";

const COORDS =
  "Coordinates are continuous world units (u), not pixels or grid cells; decimals are allowed and kept to 2 places. " +
  "A rect is axis-aligned: x/y is its top-left corner (+x right, +y down), width/height its extent. " +
  "The scene's `view` is the area currently visible in the editor window (it follows the window size; 1 u = 20 px); " +
  "rects outside it are valid but off-screen.";

function buildServer(store: SceneStore) {
  const server = new McpServer({ name: "dungeon-designer", version: "0.0.1" });

  server.registerTool(
    "get_scene",
    {
      title: "Get scene",
      description: `Return the current scene as JSON: the visible view and every rect, with who created it (human or agent). ${COORDS}`,
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(store.getScene(), null, 2) }],
    }),
  );

  server.registerTool(
    "draw_rects",
    {
      title: "Draw rects",
      description:
        `Add one or more rectangles to the scene in a single batch; they appear live in the editor. ` +
        `For a square, pass equal width and height. ` +
        `The batch is all-or-nothing: if any rect is invalid, nothing is drawn and the error says which one. ${COORDS}`,
      inputSchema: { rects: z.array(RectInputSchema).min(1) },
    },
    async ({ rects }) => {
      const created = store.addRects(rects, "agent");
      const total = store.getScene().rects.length;
      return {
        content: [{ type: "text", text: JSON.stringify({ created, totalRects: total }, null, 2) }],
      };
    },
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, all sharing one scene store. */
export function mountMcp(app: Express, store: SceneStore) {
  app.post("/mcp", async (req, res) => {
    const server = buildServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless mode has no server-initiated streams or sessions to delete.
  const notAllowed = (_req: unknown, res: import("express").Response) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}

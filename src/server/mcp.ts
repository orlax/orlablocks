import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BoxInputSchema, DEFAULT_HEIGHT, MIN_HEIGHT } from "../shared/scene.types";
import type { SceneStore } from "./scene";

const CONVENTIONS =
  "Units are meters; decimals are allowed and kept to 2 places. The world is 3D with y up and the ground at y = 0. " +
  "A box stands on the ground: its footprint is axis-aligned on the x/z plane, with x/z at the min corner (smallest x and z), " +
  "width along +x and depth along +z, and it rises from y = 0 to `height`. " +
  `A box is either a room (hollow: floor and walls, no ceiling; default height ${DEFAULT_HEIGHT.room} m) ` +
  `or a volume (solid, e.g. a platform or pillar; default height ${DEFAULT_HEIGHT.volume} m). Minimum height is ${MIN_HEIGHT} m. ` +
  "Each box has a server-assigned ID per kind (room_1, volume_1, ...) and records who created it (human or agent). " +
  "The scene's `view` is what the editor window currently shows: `focus` is the ground point at the screen center, " +
  "`yaw` the camera rotation in degrees, and `bounds` (x, z, width, depth) the axis-aligned area around the visible ground. " +
  "The visible ground is a rotated quad, so keep drawings near `focus` and well inside `bounds` to be sure they are on screen; " +
  "boxes outside it are valid but off-screen.";

function buildServer(store: SceneStore) {
  const server = new McpServer({ name: "dungeon-designer", version: "0.0.2" });

  server.registerTool(
    "get_scene",
    {
      title: "Get scene",
      description: `Return the current scene as JSON: the visible view and every box (rooms and volumes). ${CONVENTIONS}`,
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(store.getScene(), null, 2) }],
    }),
  );

  server.registerTool(
    "draw_boxes",
    {
      title: "Draw boxes",
      description:
        `Add one or more boxes (rooms and/or volumes) to the scene in a single batch; they appear live in the editor. ` +
        `Omit height to use the kind's default. ` +
        `The batch is all-or-nothing: if any box is invalid, nothing is drawn and the error says which one. ${CONVENTIONS}`,
      inputSchema: { boxes: z.array(BoxInputSchema).min(1) },
    },
    async ({ boxes }) => {
      const created = store.drawBoxes(boxes, "agent");
      const all = store.getScene().boxes;
      const totals = {
        rooms: all.filter((b) => b.kind === "room").length,
        volumes: all.filter((b) => b.kind === "volume").length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify({ created, totals }, null, 2) }],
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

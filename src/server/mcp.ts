import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  BOX_COLORS,
  BoxInputSchema,
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  MIN_HEIGHT,
  NodeUpdateSchema,
  WALL_THICKNESS,
} from "../shared/scene.types";
import type { SceneStore } from "./scene";

const CONVENTIONS =
  "Units are meters; decimals are allowed and kept to 2 places. The world is 3D with y up and the ground at y = 0. " +
  "The scene is a list of boxes. A box's footprint is CENTERED at (x, z), with `width` along the box's local x and " +
  "`depth` along its local z. It rises from its elevation `y` (its bottom: 0 = on the ground, negative = below ground) " +
  "to y + height, so to stack box B on box A, set B.y = A.y + A.height. " +
  "`rotation` turns a box around the vertical axis through its center, in degrees, counterclockwise seen from above " +
  "(0 = grid-aligned: width along world +x, depth along world +z). Rotating never moves the center. " +
  `A box is either a room (hollow: floor and walls, no ceiling; default height ${DEFAULT_HEIGHT.room} m; ` +
  `walls are ${WALL_THICKNESS} m thick, centered on the footprint edge, so rooms that share an edge share a wall) ` +
  `or a volume (solid, e.g. a platform or pillar; default height ${DEFAULT_HEIGHT.volume} m). Minimum height is ${MIN_HEIGHT} m. ` +
  `\`color\` is a palette key: ${BOX_COLORS.join(", ")} (default ${DEFAULT_COLOR}). ` +
  "Each box has a server-assigned ID (box_1, box_2, ..., never reused), an optional `name` for people " +
  '("lobby"; not unique, tools always take IDs, so resolve names to IDs with get_scene), and records who created it (human or agent). ' +
  "The scene's `selection` lists the IDs of the boxes the human has selected in the editor: when they say " +
  '"this" or "these", they mean the selection. ' +
  "The scene's `view` is what the editor window currently shows: `focus` is the ground point at the screen center, " +
  "`yaw` the camera rotation in degrees, and `bounds` (x, z, width, depth; x/z is its min corner) the axis-aligned area around the visible ground. " +
  "The visible ground is a rotated quad, so keep drawings near `focus` and well inside `bounds` to be sure they are on screen; " +
  "boxes outside it are valid but off-screen. " +
  "Every tool call that changes the scene is one step in the undo history shared with the human.";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function buildServer(store: SceneStore) {
  const server = new McpServer({ name: "dungeon-designer", version: "0.0.3" });

  server.registerTool(
    "get_scene",
    {
      title: "Get scene",
      description: `Return the current scene as JSON: the visible view, the editor's selection and every box. ${CONVENTIONS}`,
    },
    async () => json(store.getScene()),
  );

  server.registerTool(
    "draw_boxes",
    {
      title: "Draw boxes",
      description:
        `Add one or more boxes (rooms and/or volumes) to the scene in a single batch; they appear live in the editor. ` +
        `Only kind, x, z, width and depth are required; the rest have defaults (the kind's height, y 0, rotation 0, color ${DEFAULT_COLOR}, no name). ` +
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
      return json({ created, totals });
    },
  );

  server.registerTool(
    "update_nodes",
    {
      title: "Update nodes",
      description:
        `Change existing boxes by ID in a single batch; changes appear live in the editor. ` +
        `Each change gives an id plus any of: name, kind, x, z, y, width, depth, height, rotation, color. ` +
        `Values are absolute (x: 4 moves the center to x = 4). An empty name removes the name. ` +
        `The batch is all-or-nothing: an unknown ID or an invalid value rejects it and nothing changes. ${CONVENTIONS}`,
      inputSchema: { changes: z.array(NodeUpdateSchema).min(1) },
    },
    async ({ changes }) => json({ updated: store.updateNodes(changes, "agent") }),
  );

  server.registerTool(
    "remove_nodes",
    {
      title: "Remove nodes",
      description:
        `Delete boxes by ID in a single batch; they disappear live in the editor, and the human can undo it. ` +
        `The batch is all-or-nothing: an unknown ID rejects it and nothing is removed. ${CONVENTIONS}`,
      inputSchema: { ids: z.array(z.string()).min(1).describe("IDs of existing boxes, e.g. box_3") },
    },
    async ({ ids }) => {
      store.removeNodes(ids, "agent");
      return json({ removed: ids, remaining: store.getScene().boxes.length });
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

import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { boundsOf, round2 } from "../shared/geometry";
import {
  BOX_COLORS,
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  DuplicateNodesSchema,
  GroupNodesSchema,
  MAX_COPIES,
  MirrorNodesSchema,
  MIN_HEIGHT,
  MoveNodesSchema,
  NodeUpdateSchema,
  RotateNodesSchema,
  ShapeInputSchema,
  UngroupSchema,
  WALL_THICKNESS,
  type OpenScene,
  type Scene,
} from "../shared/scene.types";
import { boxesUnder, isGroup } from "../shared/tree";
import { SceneError } from "./scene";
import type { Workspace } from "./workspace";

/** Sent once when a client connects (the server's `instructions`), instead of repeating it in every tool description. */
const INSTRUCTIONS =
  "Dungeon Designer: an ideation tool for dungeon layouts. The human edits the same scene in a local 3D editor, " +
  "and you read and edit it with these tools. " +
  "The scene is one scene of a project (a project holds several scenes, e.g. one per level); get_scene reports " +
  "which project and scene are open, and the project's description gives the context. You only see the open scene: " +
  "the human opens and switches scenes in the editor. Every change is saved as it happens (there's no save step), " +
  "and the undo history survives server restarts. " +
  "Units are meters; decimals are allowed and kept to 2 places. The world is 3D with y up and the ground at y = 0. " +
  "The scene is a flat list of nodes: shapes and groups. The only shape so far is the box (type: box). " +
  "A box's footprint is CENTERED at (x, z), with `width` along the box's local x and " +
  "`depth` along its local z. It rises from its elevation `y` (its bottom: 0 = on the ground, negative = below ground) " +
  "to y + height, so to stack box B on box A, set B.y = A.y + A.height. " +
  "`rotation` turns a box around the vertical axis through its center, in degrees, counterclockwise seen from above " +
  "(0 = grid-aligned: width along world +x, depth along world +z). Rotating never moves the center. " +
  `A box is either a room (hollow: floor and walls, no ceiling; default height ${DEFAULT_HEIGHT.room} m; ` +
  `walls are ${WALL_THICKNESS} m thick, centered on the footprint edge, so rooms that share an edge share a wall) ` +
  `or a volume (solid, e.g. a platform or pillar; default height ${DEFAULT_HEIGHT.volume} m). Minimum height is ${MIN_HEIGHT} m. ` +
  `\`color\` is a palette key: ${BOX_COLORS.join(", ")} (default ${DEFAULT_COLOR}). ` +
  "A group (type: group) is a container with NO position of its own: its boxes keep absolute world coordinates, " +
  "and a node is in a group when its `parent` is that group's ID (groups can nest). get_scene adds each group's " +
  "derived `bounds` (center x/z, bottom y, width, depth, height, axis-aligned) for reference. Groups are a unit of " +
  "action: move_nodes, rotate_nodes and remove_nodes on a group act on everything in it. A group left empty disappears. " +
  "Every node has a server-assigned ID (box_1, group_1, ..., never reused), an optional `name` for people " +
  '("lobby"; not unique, tools always take IDs, so resolve names to IDs with get_scene), and records who created it (human or agent). ' +
  "To repeat things (a row of pillars, a second wing, another floor), copy them with move_nodes and copy: true " +
  "(count for several, each offset further) instead of retyping boxes with draw_shapes: copies get new IDs and keep " +
  "their names, structure and parent group. " +
  "For symmetry, mirror_nodes flips nodes in place on a WORLD axis (x or z, not the camera's view): copy a wing " +
  "with move_nodes, then mirror the copy, instead of computing reflected positions and angles by hand. " +
  "The scene's `selection` lists the IDs of the nodes the human has selected in the editor: when they say " +
  '"this" or "these", they mean the selection. ' +
  "The scene's `view` is what the editor window currently shows: `focus` is the ground point at the screen center, " +
  "`yaw` the camera rotation in degrees, and `bounds` (x, z, width, depth; x/z is its min corner) the axis-aligned area around the visible ground. " +
  "The visible ground is a rotated quad, so keep drawings near `focus` and well inside `bounds` to be sure they are on screen; " +
  "boxes outside it are valid but off-screen. " +
  "Every tool call that changes the scene is one step in the undo history shared with the human.";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/** The scene for the agent: which project and scene it is, and each group gets its derived bounds (center x/z, bottom y, sizes). */
function describeScene(open: OpenScene, scene: Scene) {
  return {
    ...open,
    ...scene,
    nodes: scene.nodes.map((n) => {
      if (!isGroup(n)) return n;
      const boxes = boxesUnder(scene.nodes, [n.id]);
      if (boxes.length === 0) return n;
      const b = boundsOf(boxes);
      const bounds = {
        x: round2((b.minX + b.maxX) / 2),
        z: round2((b.minZ + b.maxZ) / 2),
        y: round2(b.minY),
        width: round2(b.maxX - b.minX),
        depth: round2(b.maxZ - b.minZ),
        height: round2(b.maxY - b.minY),
      };
      return { ...n, bounds };
    }),
  };
}

function buildServer(workspace: Workspace) {
  const server = new McpServer({ name: "dungeon-designer", version: "0.0.7" }, { instructions: INSTRUCTIONS });
  // Every tool reads or edits the open scene, and fails with a clear message while nothing is open.
  const store = () => workspace.requireScene();

  server.registerTool(
    "get_scene",
    {
      title: "Get scene",
      description: `Return the open scene as JSON: its project (id, name, description) and scene (id, name), the visible view, the editor's selection and every node (boxes and groups).`,
    },
    async () => {
      const scene = store().getScene();
      return json(describeScene(workspace.getOpen()!, scene));
    },
  );

  server.registerTool(
    "draw_shapes",
    {
      title: "Draw shapes",
      description:
        `Add one or more shapes to the scene in a single batch; they appear live in the editor. Each has a \`type\` ` +
        `(box, the default) and that type's fields. For a box (a room or a volume) only kind, x, z, width and depth are ` +
        `required; the rest have defaults (the kind's height, y 0, rotation 0, color ${DEFAULT_COLOR}, no name, top level). ` +
        `Set \`parent\` to a group's ID to draw straight into that group. ` +
        `The batch is all-or-nothing: if any shape is invalid, nothing is drawn and the error says which one.`,
      inputSchema: { shapes: z.array(ShapeInputSchema).min(1) },
    },
    async ({ shapes }) => {
      const created = store().drawShapes(shapes, "agent");
      const all = store().getScene().nodes;
      const totals = {
        rooms: all.filter((n) => n.type === "box" && n.kind === "room").length,
        volumes: all.filter((n) => n.type === "box" && n.kind === "volume").length,
        groups: all.filter(isGroup).length,
      };
      return json({ created, totals });
    },
  );

  server.registerTool(
    "update_nodes",
    {
      title: "Update nodes",
      description:
        `Change existing nodes by ID in a single batch; changes appear live in the editor. ` +
        `A box takes any of: name, parent, kind, x, z, y, width, depth, height, rotation, color. A group takes only name and parent. ` +
        `Values are absolute (x: 4 moves the center to x = 4); to shift boxes or whole groups by an offset, use move_nodes instead. ` +
        `An empty name removes the name; parent null moves a node to the top level. ` +
        `The batch is all-or-nothing: an unknown ID or an invalid value rejects it and nothing changes.`,
      inputSchema: { changes: z.array(NodeUpdateSchema).min(1) },
    },
    async ({ changes }) => json({ updated: store().updateNodes(changes, "agent") }),
  );

  server.registerTool(
    "remove_nodes",
    {
      title: "Remove nodes",
      description:
        `Delete nodes by ID in a single batch; a group is deleted with everything in it. They disappear live in the editor, ` +
        `and the human can undo it. All-or-nothing: an unknown ID rejects it and nothing is removed.`,
      inputSchema: { ids: z.array(z.string()).min(1).describe("IDs of existing nodes, e.g. box_3 or group_1") },
    },
    async ({ ids }) => {
      store().removeNodes(ids, "agent");
      return json({ removed: ids, remaining: store().getScene().nodes.length });
    },
  );

  server.registerTool(
    "move_nodes",
    {
      title: "Move nodes",
      description:
        `Shift boxes and/or whole groups by a relative offset (dx, dy, dz in meters; +x is east). ` +
        `This is the way to move a group: one call moves everything in it, keeping its layout. ` +
        `With copy: true the nodes stay in place and \`count\` copies are added instead (default 1), copy i offset by ` +
        `i × (dx, dy, dz), so count makes a row; a zero offset copies in place. Copies get new IDs, keep their names, ` +
        `nesting and parent group, and are returned (their roots).`,
      inputSchema: MoveNodesSchema.extend({
        copy: z.boolean().optional().describe("Leave the nodes in place and add copies at the offset"),
        count: DuplicateNodesSchema.shape.count.describe(`With copy: how many copies, 1..${MAX_COPIES}, default 1`),
      }).shape,
    },
    async ({ copy, count, ...move }) => {
      if (copy) return json({ copies: store().duplicateNodes({ ...move, count }, "agent") });
      if (count !== undefined) throw new SceneError("count only applies with copy: true. Nothing was moved.");
      return json({ moved: store().moveNodes(move, "agent") });
    },
  );

  server.registerTool(
    "rotate_nodes",
    {
      title: "Rotate nodes",
      description:
        `Turn boxes and/or whole groups by \`degrees\` (counterclockwise seen from above) around the vertical axis through ` +
        `the center of their combined bounds: every box's center orbits that point and its rotation grows by the same angle.`,
      inputSchema: RotateNodesSchema.shape,
    },
    async (input) => json({ rotated: store().rotateNodes(input, "agent") }),
  );

  server.registerTool(
    "mirror_nodes",
    {
      title: "Mirror nodes",
      description:
        `Flip boxes and/or whole groups in place on a world axis, across the center of their combined bounds: ` +
        `axis x swaps east and west (every x reflects), axis z swaps +z and -z. y never changes, and every rotation ` +
        `becomes -rotation. A group mirrors as a unit. Mirroring twice restores the original exactly.`,
      inputSchema: MirrorNodesSchema.shape,
    },
    async (input) => json({ mirrored: store().mirrorNodes(input, "agent") }),
  );

  server.registerTool(
    "group_nodes",
    {
      title: "Group nodes",
      description:
        `Put boxes and/or groups in a new group, optionally named. The group is created inside the deepest group that ` +
        `held them all. Returns the new group (use its ID with move_nodes, rotate_nodes, or as a parent in draw_shapes).`,
      inputSchema: GroupNodesSchema.shape,
    },
    async (input) => json({ group: store().groupNodes(input, "agent") }),
  );

  server.registerTool(
    "ungroup",
    {
      title: "Ungroup",
      description: "Dissolve groups; their contents stay where they are and move up to the group's parent.",
      inputSchema: UngroupSchema.shape,
    },
    async (input) => json({ freed: store().ungroup(input, "agent") }),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, all sharing one scene store(). */
export function mountMcp(app: Express, workspace: Workspace) {
  app.post("/mcp", async (req, res) => {
    const server = buildServer(workspace);
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

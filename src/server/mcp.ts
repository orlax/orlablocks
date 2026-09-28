import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { isClosed } from "../shared/geometry";
import { holeWarnings } from "../shared/holes";
import {
  DEFAULT_COLOR,
  DEFAULT_LINE_COLOR,
  DEFAULT_THICKNESS,
  DEFAULT_WALL,
  DuplicateNodesSchema,
  GroupNodesSchema,
  MAX_COPIES,
  MirrorNodesSchema,
  MoveNodesSchema,
  NodeUpdateSchema,
  DEFAULT_RENDER_SIZE,
  MAX_RENDER_SIZE,
  RenderRequestSchema,
  RotateNodesSchema,
  ShapeInputSchema,
  UngroupSchema,
} from "../shared/scene.types";
import { EMPTY_LIBRARY, LibraryEditSchema, unknownRefs, type Library } from "../shared/library";
import { isGroup, isShape } from "../shared/tree";
import { GUIDE_TOPICS, guideTopic, INSTRUCTIONS, topicList } from "./guide";
import { describeScene, entitySize, findNodes, FULL_SCENE_MAX, MAX_MATCHES } from "./outline";
import { definitionOf } from "../shared/entities";
import { prepareRender, type RenderBroker } from "./render";
import { SceneError } from "./scene";
import type { Workspace } from "./workspace";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/** Which guide topic helps with a warning, named at its end. */
const withTopic = (warning: string) => (/\bhole\b/.test(warning) ? `${warning} (see get_guide holes)` : warning);

/**
 * Runs an edit, and when it's refused, points at the guide: the refusal names the field, and the topic has the rules
 * for it.
 */
function guided<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof SceneError) {
      throw new SceneError(`${err.message}\nThe rules for each type and field: get_guide shapes, volumes, holes, ramps or lines.`);
    }
    throw err;
  }
}

const R = RenderRequestSchema.shape;
/** render_view's input, each field described for the agent. */
const RENDER_INPUT = {
  view: R.view.describe(
    "sheet (default: a labeled top-down plan plus views from the northeast, south and west, in one image), plan (top-down, north up, with a scale bar), " +
      "node (a close-up of ids), eye (what a player sees from a point), walk (frames at eye height along a path), shot (a stored shot's camera again, now), " +
      "shots (the human's captioned shots, as taken and now, side by side: are their claims still true?) or entities (a model sheet of the library's entities, or ids, with the human for scale)",
  ),
  ids: R.ids.describe("plan / sheet: only these (and what's in them); node: what to frame; entities: entity IDs"),
  from: R.from.describe('eye: the feet {x, y?, z} (y from the floor there when left out), or "human" for where the human is walking'),
  at: R.at.describe("eye: a point {x, y, z} or a node ID to look at (default: along yaw / pitch)"),
  yaw: R.yaw.describe("node: the direction to look from (the view's by default); eye: where to look without at (degrees, 0 = north, counterclockwise)"),
  pitch: R.pitch.describe("eye: up (+) or down (-), in degrees, without at"),
  path: R.path.describe("walk: a line or ramp ID (e.g. the critical path), or at least 2 points (y from the floor when left out)"),
  frames: R.frames.describe("walk: how many frames, 3 to 8 (default 5)"),
  preset: R.preset.describe("eye / walk: first (default) or third person, with the project's player camera"),
  shot: R.shot.describe("shot: the shot to take again (see get_shots)"),
  shots: R.shots.describe("shots: which shots to re-check, as taken and now (default: the captioned ones taken before the last change, the latest 6)"),
  labels: R.labels.describe("plan / sheet / node: letter labels on the image, with the legend in the text (default true)"),
  size: R.size.describe(`the image's long edge in pixels (default ${DEFAULT_RENDER_SIZE}, at most ${MAX_RENDER_SIZE})`),
  save: R.save.describe("keep the image as a shot (by the agent) in the human's Shots panel: node, eye and shot views only"),
};

function buildServer(workspace: Workspace, renders: RenderBroker) {
  /** A result with the scene's hole warnings added (holes that cut nothing), when there are any. */
  const warned = <T extends object>(result: T) => {
    const own = (result as { warnings?: string[] }).warnings ?? [];
    const nodes = store().getScene().nodes;
    const missing = nodes.flatMap((n) =>
      n.type === "instance" && !(definitionOf(n.entity) && library().entities.some((e) => e.id === n.entity))
        ? [`${n.id} shows entity "${n.entity}", which isn't in the library (it shows as a red block): swap its entity or remove it`]
        : [],
    );
    // In an entity's definition a top-level hole is fine: every instance puts it in a group.
    const holes = store().getDocument() === "entity" ? [] : holeWarnings(nodes).map(withTopic);
    const warnings = [...own, ...holes, ...missing];
    return warnings.length > 0 ? { ...result, warnings } : result;
  };
  const server = new McpServer({ name: "orlablocks", version: "0.0.20" }, { instructions: INSTRUCTIONS });
  // Every tool reads or edits the open scene, and fails with a clear message while nothing is open.
  const store = () => workspace.requireScene();
  const library = (): Library => (workspace.getOpen() ? workspace.library.get() : EMPTY_LIBRARY);
  /** The outline's line about the design guide: its size and when it last changed, as a reminder to read it. */
  const guideLine = () => {
    const text = library().guide.trim();
    if (!text) return "no design guide yet";
    const at = workspace.guideChangedAt();
    return `design guide, ${(text.length / 1000).toFixed(1)} kB${at ? `, changed ${at.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}: read it with get_guide design`;
  };
  /** Warnings for references to nothing in the descriptions an edit set. */
  const refWarnings = (described: { id: string; description?: string | null }[]) =>
    described.flatMap(({ id, description }) =>
      description ? unknownRefs(library(), description).map((r) => `${id}: ${r} names nothing in the library (get_guide library)`) : [],
    );

  server.registerTool(
    "get_scene",
    {
      title: "Get scene",
      description:
        `Return the open scene: its project (id, name, description) and scene, the compass (north is -z), the visible view, ` +
        `the editor's selection, \`counts\`, and the nodes as an OUTLINE: the children of \`root\` (a group's ID; default the top ` +
        `level) down to \`depth\` levels (default 1), each group with its description, bounds and \`contains\` (counts), and ` +
        `\`collapsed: true\` when its contents aren't listed. \`full: true\` lists every node under the root instead; a scene of ` +
        `${FULL_SCENE_MAX} nodes or fewer comes back in full anyway. Selected nodes the outline doesn't list come in \`selected\`.`,
      inputSchema: {
        root: z.string().optional().describe("ID of a group to list the contents of (a shape's ID returns just that shape). Default: the top level"),
        depth: z.number().int().min(1).max(20).optional().describe("How many levels of groups to open, default 1"),
        full: z.boolean().optional().describe("List every node under the root, with no depth limit"),
      },
    },
    async (query) => {
      const scene = store().getScene();
      const open = workspace.getOpen()!;
      const outline = describeScene(open, scene, query, { library: library(), guide: guideLine() });
      if (!open.entity) return json(warned(outline));
      // Edit entity mode: the nodes are the entity's definition.
      const meta = library().entities.find((e) => e.id === open.entity!.id);
      const placed = workspace.uses().entities[open.entity.id];
      return json(
        warned({
          editing: {
            entity: open.entity.id,
            name: meta?.name,
            ...(meta?.description ? { description: meta.description } : {}),
            ...(meta?.tags ? { tags: meta.tags } : {}),
            placed: placed ? `${placed.nodes} times, in ${placed.sceneNames.join(", ")}` : "nowhere yet",
            about:
              "The human is editing this ENTITY's definition, not a scene: the nodes are its shapes around its pivot (the " +
              "origin, its bottom center: keep its bottom at y = 0), and every change reaches every instance of it. Notes " +
              "and instances can't go in it, and a hole at its top level is fine (each instance is a group). Its name, " +
              "description and tags change with update_library { entities }. The human goes back to the scene in the editor.",
          },
          ...outline,
        }),
      );
    },
  );

  server.registerTool(
    "find_nodes",
    {
      title: "Find nodes",
      description:
        `Look nodes up without reading the whole scene: the nodes matching every filter given, one compact line each ` +
        `(id, type, kind, name, parent, path of group names, bounds), at most ${MAX_MATCHES}. Use it to resolve a name to an ` +
        `ID ("entry_window"), or to find what's in or near an area.`,
      inputSchema: {
        name: z.string().optional().describe("Part of the name (or of a note's text, or an instance's entity's name), any case"),
        tag: z.string().optional().describe("A library tag (without #): only nodes carrying it"),
        type: z.enum(["box", "cylinder", "freeform", "line", "ramp", "note", "instance", "group"]).optional(),
        entity: z.string().optional().describe("An entity's ID: only its instances"),
        status: z.enum(["open", "done"]).optional().describe("Notes only: open (the default outline lists these anyway) or done"),
        kind: z.enum(["room", "volume", "hole"]).optional().describe("Closed shapes and ramps only"),
        under: z.string().optional().describe("ID of a group: only nodes inside it, at any depth"),
        near: z
          .strictObject({ x: z.number(), z: z.number(), radius: z.number().min(0) })
          .optional()
          .describe("Only nodes whose bounds come within radius meters of the point x, z (on the ground)"),
      },
    },
    async (query) => json(findNodes(store().getScene().nodes, query, library())),
  );

  server.registerTool(
    "get_guide",
    {
      title: "Get guide",
      description: `Return one topic of the detailed guide. Read a topic before using its types or fields for the first time in a session. Topics:\n${topicList()}`,
      inputSchema: { topic: z.enum(GUIDE_TOPICS) },
    },
    async ({ topic }) => {
      if (topic === "design") store();
      return { content: [{ type: "text" as const, text: guideTopic(topic, library().guide) }] };
    },
  );

  server.registerTool(
    "make_entity",
    {
      title: "Make entity",
      description:
        "Turn shapes and/or groups into a new ENTITY (a prefab in the project library) and put one instance of it in " +
        "their place, as one scene step (undo puts the shapes back; the entity stays in the library). Its pivot is the " +
        "bottom center of their bounds. A single group is unwrapped: its contents become the entity, and its name, " +
        "description and tags are the entity's unless given. Instances and notes can't go in an entity. Returns the " +
        "entity (its ID, for draw_shapes' type: instance) and the instance.",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("IDs of the shapes and/or groups (with what's in them)"),
        name: z.string().max(80).optional().describe('What it is, e.g. "tree tall" (its ID is a slug of this: tree-tall)'),
        description: z.string().optional().describe("What it is and does in the game, for the human and you; it can refer to @skills and #tags"),
        tags: z.array(z.string()).optional().describe("Library tags every instance carries (without #), e.g. [\"climbable\"]"),
      },
    },
    async (input) => {
      const made = workspace.makeEntity(input, "agent");
      return json(warned({ ...made, ...(made.entity.description ? { warnings: refWarnings([{ id: made.entity.id, description: made.entity.description }]) } : {}) }));
    },
  );

  server.registerTool(
    "detach_instances",
    {
      title: "Detach instances",
      description:
        "Turn instances back into plain groups of shapes (world copies of their entity's shapes, with new IDs), each " +
        "where its instance was, as one step. The group is named after the instance (else the entity). Do this only to " +
        "make one copy different: a detached group no longer changes with its entity.",
      inputSchema: { ids: z.array(z.string()).min(1).describe("IDs of instances") },
    },
    async ({ ids }) => json({ groups: store().detachInstances(ids, "agent") }),
  );

  server.registerTool(
    "get_library",
    {
      title: "Get library",
      description:
        "Return the open project's library: every tag and skill with its description (a skill with its tags), their " +
        "aliases (old names), every entity (its ID, name, description, tags and size), how many nodes use each and in " +
        "how many scenes, and the design guide's line (read the guide itself with get_guide design). With `entity`, " +
        "return that entity's definition: its nodes around its pivot (the origin, at its bottom center). The outline's " +
        "glossary already explains the tags, skills and entities it shows.",
      inputSchema: { entity: z.string().optional().describe("An entity's ID, for its definition's nodes") },
    },
    async ({ entity }) => {
      store();
      const lib = library();
      if (entity !== undefined) {
        const meta = lib.entities.find((e) => e.id === entity);
        const nodes = definitionOf(entity);
        if (!meta || !nodes) throw new SceneError(`entity: no entity "${entity}" (get_library lists them)`);
        return json({ ...meta, size: entitySize(entity), nodes });
      }
      const uses = workspace.uses();
      return json({
        tags: lib.tags.map((t) => ({ ...t, ...(uses.tags[t.name] ? { used: uses.tags[t.name] } : {}) })),
        skills: lib.skills.map((k) => ({ ...k, ...(uses.skills[k.name] ? { used: uses.skills[k.name] } : {}) })),
        entities: lib.entities.map((e) => {
          const u = uses.entities[e.id];
          return { ...e, size: entitySize(e.id), ...(u ? { used: { nodes: u.nodes, scenes: u.scenes } } : {}) };
        }),
        guide: guideLine(),
      });
    },
  );

  server.registerTool(
    "update_library",
    {
      title: "Update library",
      description:
        "Change the open project's library, as one step in the library's own undo history (not the scene's): add or " +
        "change tags and skills (`upsert`: only the fields given change), `rename` them (the old name stays as an alias), " +
        "change an entity's name, description or tags (`entities`), `remove` tags, skills or unplaced entities, or " +
        "replace the design guide's text (`guide`, only when the human asks). All-or-nothing. " +
        "Returns what changed, and warnings for references in the descriptions to nothing in the library.",
      inputSchema: LibraryEditSchema.shape,
    },
    async (edit) => json(workspace.editLibrary(edit, "agent")),
  );

  server.registerTool(
    "draw_shapes",
    {
      title: "Draw shapes",
      description:
        `Add one or more shapes to the scene in a single batch; they appear live in the editor. Each has a \`type\` ` +
        `(box, the default, cylinder, freeform, line, ramp, note or instance) and that type's fields. For a box or cylinder (a room, a volume or a hole) only ` +
        `kind, x, z, width and depth are required; for a free-form, kind and points; for a line, points; for a ramp, points or spiral; for a note, x, z and text; for an instance of an entity, entity, x and z. The rest have defaults (the kind's ` +
        `height, y 0, rotation 0, color ${DEFAULT_COLOR} (${DEFAULT_LINE_COLOR} for a line), ${DEFAULT_WALL} m room walls, no taper or bevel, no name, top level, a smooth cylinder, ` +
        `and a solid ${DEFAULT_THICKNESS} px line with no arrow). ` +
        `Set \`parent\` to a group's ID to draw straight into that group. ` +
        `The batch is all-or-nothing: if any shape is invalid, nothing is drawn and the error says which one.`,
      inputSchema: { shapes: z.array(ShapeInputSchema).min(1) },
    },
    async ({ shapes }) => {
      const created = guided(() => store().drawShapes(shapes, "agent"));
      const refs = refWarnings(created.flatMap((c) => (c.type === "note" ? [{ id: c.id, description: c.text }] : [])));
      const all = store().getScene().nodes;
      // Rooms, volumes and holes of every closed shape; a ramp counts as a ramp.
      const count = (kind: string) => all.filter((n) => isShape(n) && isClosed(n) && n.kind === kind).length;
      const totals = {
        rooms: count("room"),
        volumes: count("volume"),
        holes: count("hole"),
        ramps: all.filter((n) => n.type === "ramp").length,
        lines: all.filter((n) => n.type === "line").length,
        notes: all.filter((n) => n.type === "note" && n.status === "open").length,
        instances: all.filter((n) => n.type === "instance").length,
        groups: all.filter(isGroup).length,
      };
      return json(warned({ created, totals, ...(refs.length > 0 ? { warnings: refs } : {}) }));
    },
  );

  server.registerTool(
    "update_nodes",
    {
      title: "Update nodes",
      description:
        `Change existing nodes by ID in a single batch; changes appear live in the editor. ` +
        `A box takes any of: name, parent, kind, x, z, y, width, depth, height, rotation, color, wall (a room's; null = the default), ` +
        `taper and bevel (a volume's; 0 clears them), pitch and roll (a box or cylinder volume's; 0 levels it); ` +
        `a cylinder those and sides; a free-form name, parent, kind, y, height, color, wall, taper, bevel and points (the whole outline); a line name, parent, color, ` +
        `points (the whole path, with y), thickness, dashed and arrow; a ramp name, parent, color, ` +
        `points (with y), width, step (null = smooth) and base; a note name, parent, x, y, z, color, text, label (null removes it) and status (open or done); an instance name, parent, x, y, z, rotation and entity (another entity's ID, to swap it). ` +
        `A group takes only name, description (what that part of the level is; null removes it), parent, locked and hidden (any node takes those two). ` +
        `{ id, type: "freeform" } alone converts a box or cylinder into a free-form with a new ID; a call that converts ` +
        `only converts (edit the new free-form in a second call). ` +
        `Values are absolute (x: 4 moves the center to x = 4); to shift boxes or whole groups by an offset, use move_nodes instead. ` +
        `An empty name removes the name; parent null moves a node to the top level. ` +
        `The batch is all-or-nothing: an unknown ID or an invalid value rejects it and nothing changes.`,
      inputSchema: { changes: z.array(NodeUpdateSchema).min(1) },
    },
    async ({ changes }) => {
      const updated = guided(() => store().updateNodes(changes, "agent"));
      const refs = refWarnings(changes.map((c) => ({ id: c.id, description: c.description ?? c.text })));
      if (!changes.some((c) => c.type !== undefined)) return json(warned({ updated, ...(refs.length > 0 ? { warnings: refs } : {}) }));
      return json(warned({ converted: changes.map((c, i) => ({ from: c.id, to: updated[i].id })), updated }));
    },
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
        `Turn shapes and/or whole groups by \`degrees\` (counterclockwise seen from above) around the vertical axis through ` +
        `\`pivot\` (default: the center of their combined bounds): every box's or cylinder's center orbits that point and ` +
        `its rotation grows by the same angle; a free-form's points orbit it. The result gives the pivot used. The ` +
        `bounds' center moves as shapes turn, so to turn something back (or in several steps), pass that same pivot.`,
      inputSchema: RotateNodesSchema.shape,
    },
    async (input) => {
      const { shapes, pivot } = store().rotateNodes(input, "agent");
      return json({ rotated: shapes, pivot });
    },
  );

  server.registerTool(
    "mirror_nodes",
    {
      title: "Mirror nodes",
      description:
        `Flip boxes and/or whole groups in place on a world axis, across the center of their combined bounds: ` +
        `axis x swaps east and west (every x reflects), axis z swaps north (-z) and south (+z). y never changes, and every rotation ` +
        `becomes -rotation (an odd-sided cylinder mirrored on x: 180 - rotation; a free-form's points reflect). A group mirrors as a unit. ` +
        `Mirroring twice restores the original exactly.`,
      inputSchema: MirrorNodesSchema.shape,
    },
    async (input) => json({ mirrored: store().mirrorNodes(input, "agent") }),
  );

  server.registerTool(
    "group_nodes",
    {
      title: "Group nodes",
      description:
        `Put boxes and/or groups in a new group, optionally named and described. The group is created inside the deepest group that ` +
        `held them all. Returns the new group (use its ID with move_nodes, rotate_nodes, or as a parent in draw_shapes).`,
      inputSchema: GroupNodesSchema.shape,
    },
    async (input) => {
      const group = store().groupNodes(input, "agent");
      const refs = refWarnings([{ id: group.id, description: group.description }]);
      return json(warned({ group, ...(refs.length > 0 ? { warnings: refs } : {}) }));
    },
  );

  server.registerTool(
    "render_view",
    {
      title: "Render view",
      description:
        "Render the open document as an image, to see your work as a player would (get_guide review says what to check, and when): " +
        "the human's captioned shots, reveals, wayfinding along the critical path, landmarks, stairs that end in walls, doors that cut nothing, " +
        "floating shapes, scale against the human. The editor draws it (it must be open in a browser), without moving the human's view. " +
        "Labels are letters, and the text result is their legend. Hidden nodes are left out, and notes aren't drawn (read them in get_scene).",
      inputSchema: RENDER_INPUT,
    },
    async (input) => {
      const scene = store().getScene();
      const request = RenderRequestSchema.parse(input);
      const job = prepareRender(request, {
        nodes: scene.nodes,
        view: scene.view,
        shot: (id) => workspace.shots.get(id),
        shots: workspace.shots.list(),
        seq: workspace.documentSeq() ?? 0,
        entities: library().entities,
      });
      if (job.pairs?.length === 0) {
        return { content: [{ type: "text" as const, text: "No captioned shot was taken before the last change: nothing to re-check." }] };
      }
      const result = await renders.request(job);
      const lines = [result.text];
      if (job.view === "shots" && !request.shots) {
        const changed = workspace.shots.list().filter((s) => s.caption && s.seq < (workspace.documentSeq() ?? 0)).length;
        if (changed > job.pairs!.length) lines.push(`${changed - job.pairs!.length} older captioned shots weren't re-checked: pass shots: [...] for them.`);
      }
      if (job.view === "entities" && !request.ids && library().entities.length > job.entities!.length) {
        lines.push(`${library().entities.length - job.entities!.length} more entities weren't drawn: pass ids for them.`);
      }
      if (job.view === "shot") {
        const shot = workspace.shots.get(job.shot!)!;
        const since = (workspace.documentSeq() ?? shot.seq) - shot.seq;
        lines.push(since === 0 ? `Nothing has changed since ${shot.id} was taken.` : `${since} step${since === 1 ? "" : "s"} since ${shot.id} was taken: compare with its image (get_shots id).`);
      }
      if (request.save && result.camera) {
        const kept = workspace.addShot({ camera: result.camera, image: result.image }, "agent");
        lines.push(`Kept as ${kept.id} in the Shots panel.`);
      }
      return { content: [{ type: "image" as const, data: result.image, mimeType: "image/png" }, { type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "get_shots",
    {
      title: "Get shots",
      description:
        "The human's shots of the open document (captures of the editor's view, or of a walk, each with its camera and an optional caption), " +
        "oldest first, with `changedSince`: the steps since each was taken. With `id`, that shot's record and its image as it was taken. " +
        "To see the same view now, render_view { view: \"shot\", shot }.",
      inputSchema: { id: z.string().optional().describe("a shot's ID, for its image") },
    },
    async ({ id }) => {
      store();
      const seq = workspace.documentSeq() ?? 0;
      const summary = (s: ReturnType<typeof workspace.shots.list>[number]) => ({
        id: s.id,
        ...(s.caption ? { caption: s.caption } : {}),
        createdBy: s.createdBy,
        createdAt: s.createdAt,
        size: `${s.width} × ${s.height}`,
        camera: s.camera,
        changedSince: seq - s.seq,
      });
      if (!id) return json({ shots: workspace.shots.list().map(summary) });
      const shot = workspace.shots.list().find((s) => s.id === id);
      if (!shot) throw new SceneError(`No shot "${id}" in the open document. get_shots lists them.`);
      const image = workspace.shots.image(id);
      if (!image) throw new SceneError(`${id}'s image is missing from the data folder.`);
      return {
        content: [
          { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" },
          { type: "text" as const, text: JSON.stringify(summary(shot)) },
        ],
      };
    },
  );

  server.registerTool(
    "ungroup",
    {
      title: "Ungroup",
      description: "Dissolve groups; their contents stay where they are and move up to the group's parent.",
      inputSchema: UngroupSchema.shape,
    },
    async (input) => json(warned({ freed: store().ungroup(input, "agent") })),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, all sharing one scene store(). */
export function mountMcp(app: Express, workspace: Workspace, renders: RenderBroker) {
  app.post("/mcp", async (req, res) => {
    const server = buildServer(workspace, renders);
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

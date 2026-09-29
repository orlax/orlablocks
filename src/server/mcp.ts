import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { isClosed } from "../shared/geometry";
import { holeWarnings } from "../shared/holes";
import { arrayShortfall, followPath, isFollowing } from "../shared/arrays";
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
  type SceneNode,
} from "../shared/scene.types";
import { EMPTY_LIBRARY, LibraryEditSchema, unknownRefs, type Library } from "../shared/library";
import { isGroup, isShape } from "../shared/tree";
import { GUIDE_TOPICS, guideTopic, INSTRUCTIONS, topicList } from "./guide";
import { describeScene, entitySize, findNodes, FULL_SCENE_MAX, MAX_MATCHES } from "./outline";
import { definitionOf } from "../shared/entities";
import { prepareRender, type RenderBroker } from "./render";
import { compactNodes } from "./results";
import { checkSight } from "../shared/sight";
import { expandShapes } from "../shared/entities";
import { surfaceAt, topOf } from "../shared/surfaces";
import { SceneError } from "./scene";
import type { Workspace } from "./workspace";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/** Where check_sight's eye is (13.5): a point (the feet), a node or item to stand on, or "human". */
const SightFromSchema = z.union([z.strictObject({ x: z.number(), y: z.number().optional(), z: z.number() }), z.string()]);

/** Every edit tool's `verbose` (plan 13 §4): its result is compact unless asked. */
const VERBOSE = z
  .boolean()
  .optional()
  .describe("Return the nodes in full (every field, points included) instead of the compact result: only to read back what you're about to edit point by point");

/** Every edit tool's `items` (14.2): an array's item lines only when asked. */
const ITEMS = z
  .boolean()
  .optional()
  .describe("List every array's item lines (where each item stands, its top and its turn) in the result; by default an array says how many items and their range of tops");

/** Every edit tool's `dry_run` (14.2): check and build it, return the result it would have, and change nothing. */
const DRY_RUN = z
  .boolean()
  .optional()
  .describe("Check the whole call and return what it would do (and every error), changing nothing: before a big batch, or to test a ramp's curve");

/** Which guide topic helps with a warning, named at its end. */
const withTopic = (warning: string) =>
  /\bhole\b/.test(warning) ? `${warning} (see get_guide holes)` : /\barray\b/.test(warning) ? `${warning} (see get_guide arrays)` : warning;

/**
 * Runs an edit, and when it's refused, points at the guide: the refusal names the field, and the topic has the rules
 * for it.
 */
function guided<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof SceneError) {
      throw new SceneError(`${err.message}\nThe rules for each type and field: get_guide shapes, volumes, holes, ramps, lines, entities or arrays.`);
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
  hide: R.hide.describe(
    "for this render only, leave these nodes out (with what's in them; a hidden hole cuts nothing): an enclosed room's walls, to see inside from outside. The scene's own hidden flags are the human's: this never changes them",
  ),
  clip: R.clip.describe("for this render only, cut away everything above this height (a section): the walls cut, the floors and what's on them in view"),
};

function buildServer(workspace: Workspace, renders: RenderBroker) {
  /** A result with the scene's hole warnings added (holes that cut nothing), when there are any. */
  const warned = <T extends object>(result: T) => {
    const own = (result as { warnings?: string[] }).warnings ?? [];
    const nodes = store().getScene().nodes;
    // A following array whose target can't be followed any more keeps its last path.
    const followWarning = (n: SceneNode) => {
      if (!isFollowing(n)) return [];
      const f = followPath(nodes.find((t) => t.id === n.layout.along.id), n.layout.along);
      return "problem" in f ? [`${n.id} can't follow ${n.layout.along.id} any more (${f.problem}): it keeps its last path`] : [];
    };
    const known = (entity: string) => !!definitionOf(entity) && library().entities.some((e) => e.id === entity);
    const missing = nodes.flatMap((n) =>
      n.type === "instance" && !known(n.entity)
        ? [`${n.id} shows entity "${n.entity}", which isn't in the library (it shows as a red block): swap its entity or remove it`]
        : n.type === "array"
          ? [
              ...n.entities
                .filter((e) => !known(e.entity))
                .map((e) => `${n.id} repeats entity "${e.entity}", which isn't in the library (its items show as red blocks): change its entities or remove it`),
              ...(arrayShortfall(n) ? [`${n.id}: ${arrayShortfall(n)}`] : []),
              ...followWarning(n),
            ]
          : [],
    );
    // In an entity's definition a top-level hole is fine: every instance puts it in a group.
    const holes = store().getDocument() === "entity" ? [] : holeWarnings(nodes).map(withTopic);
    const warnings = [...own, ...holes, ...missing];
    return warnings.length > 0 ? { ...result, warnings } : result;
  };
  /** Runs an edit tool's body for real, or as a dry run (14.2): the same result, marked, with nothing changed. */
  const edit = <T extends object>(dryRun: boolean | undefined, run: () => T) =>
    dryRun ? { dryRun: "nothing was changed: this is what the call would do", ...store().dryRun(run) } : run();
  const server = new McpServer({ name: "orlablocks", version: "0.0.30" }, { instructions: INSTRUCTIONS });
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
        root: z
          .string()
          .optional()
          .describe("ID of a group to list the contents of (a shape's ID returns just that shape; an array's, with every item's line). Default: the top level"),
        depth: z.number().int().min(1).max(20).optional().describe("How many levels of groups to open, default 1"),
        full: z.boolean().optional().describe("List every node under the root, with no depth limit"),
        notes: z
          .union([z.enum(["short", "full"]), z.literal(false)])
          .optional()
          .describe('Open notes (those in the root, with one): "short" (default: id, label, point, the start of the text), "full" (every field), or false (only a count)'),
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
        `ID ("entry_window"), or to find what's in or near an area. Array ITEMS are found with type: "item" (with near, ` +
        `nearest first: "the column nearest the door") or under an array's ID: each as array_5/3 with its item line ` +
        `(where it stands, its top and its turn), the IDs skip and item references use.`,
      inputSchema: {
        name: z.string().optional().describe("Part of the name (or of a note's text, or an instance's or array's entity's name), any case"),
        tag: z.string().optional().describe("A library tag (without #): only nodes carrying it"),
        type: z
          .enum(["box", "cylinder", "freeform", "line", "ramp", "note", "instance", "array", "group", "item"])
          .optional()
          .describe("item: array items (array_5/3), not nodes"),
        entity: z.string().optional().describe("An entity's ID: only its instances and the arrays that repeat it"),
        status: z.enum(["open", "done"]).optional().describe("Notes only: open (the default outline lists these anyway) or done"),
        kind: z.enum(["room", "volume", "hole"]).optional().describe("Closed shapes and ramps only"),
        under: z.string().optional().describe("ID of a group: only nodes inside it, at any depth; or of an array: its items"),
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
        "entity (its ID, for draw_shapes' type: instance) and the instance. With keep: false, nothing is left in their " +
        "place. To make an entity without drawing it in the scene first, use define_entity.",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("IDs of the shapes and/or groups (with what's in them)"),
        keep: z.boolean().optional().describe("Leave an instance in their place (default true); false: the shapes become the entity and leave nothing"),
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
    "define_entity",
    {
      title: "Define entity",
      description:
        "Make a new ENTITY (a prefab in the project library) from shapes given around its PIVOT, without drawing them in " +
        "the scene: no scene step, no instance to clean up, no need for an empty spot. The pivot is the entity's bottom " +
        "center, at the origin: build it standing on y = 0, centered on x = 0, z = 0 (a 2 × 2 × 0.5 slab is a volume at " +
        "x 0, z 0, y 0). `shapes` are draw_shapes' entries (boxes, cylinders, free-forms, ramps, lines and groups, with " +
        "batch refs), but no instances, arrays or notes. Returns the entity (its ID, for draw_shapes' type: instance or " +
        "array), and warnings when it doesn't stand on the origin.",
      inputSchema: {
        name: z.string().max(80).describe('What it is, e.g. "ruin slab" (its ID is a slug of this: ruin-slab)'),
        description: z.string().optional().describe("What it is and does in the game, for the human and you; it can refer to @skills and #tags"),
        tags: z.array(z.string()).optional().describe("Library tags every instance carries (without #)"),
        shapes: z.array(ShapeInputSchema).min(1).describe("Its shapes, around the pivot (the origin, at its bottom center), as draw_shapes takes them"),
      },
    },
    async (input) => {
      const made = guided(() => workspace.defineEntity(input, "agent"));
      const refs = made.entity.description ? refWarnings([{ id: made.entity.id, description: made.entity.description }]) : [];
      const warnings = [...(made.warnings ?? []), ...refs];
      return json({ entity: { ...made.entity, size: entitySize(made.entity.id) }, ...(warnings.length > 0 ? { warnings } : {}) });
    },
  );

  server.registerTool(
    "detach_instances",
    {
      title: "Detach instances",
      description:
        "Turn instances back into plain groups of shapes (world copies of their entity's shapes, with new IDs), and " +
        "arrays into groups of plain instances (one where each item was), each where it was, as one step. The group is " +
        "named after the instance or array (else the entity). Do this only to make one copy different: a detached group " +
        "no longer changes with its entity, or its layout.",
      inputSchema: { ids: z.array(z.string()).min(1).describe("IDs of instances and/or arrays") },
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
        `(box, the default, cylinder, freeform, line, ramp, note, instance, array or group) and that type's fields. For a box or cylinder (a room, a volume or a hole) only ` +
        `kind, x, z, width and depth are required; for a free-form, kind and points; for a line, points; for a ramp, points or spiral; for a note, x, z and text; for an instance of an entity, entity, x and z; ` +
        `for an array (get_guide arrays), entity (or entities) and layout. The rest have defaults (the kind's ` +
        `height, y 0, rotation 0, color ${DEFAULT_COLOR} (${DEFAULT_LINE_COLOR} for a line), ${DEFAULT_WALL} m room walls, no taper or bevel, no name, top level, a smooth cylinder, ` +
        `and a solid ${DEFAULT_THICKNESS} px line with no arrow). ` +
        `Set \`parent\` to a group's ID to draw straight into that group. ` +
        `ONE BATCH, ONE CALL: give an entry a \`ref\` ("chamber") and later entries use "$chamber" where an ID goes (parent, ` +
        `layout.along.id), so a line and the array that follows it, or a group (type: group, with name, description, tags) ` +
        `and everything in it, arrive in one call: a door hole drawn into the room's group cuts it from the start. A ref ` +
        `only names entries before it; the result maps each ref to its ID. ` +
        `STANDING ON: an instance or array with on: { id } stands on that node's walking surface (instead of y), kept up to ` +
        `date; an array on an array stands item on item. THROUGH: a line with through: { stops, style?, apex? } instead ` +
        `of points goes through its stops (node IDs, items array_3/5, array_3/* for all of them, array_3/2..6), each the ` +
        `center of its walking surface, as jump arcs (the default) or straight, kept up to date: the critical path. ` +
        `The batch is all-or-nothing: if any shape is invalid, nothing is drawn and the error says which one. ` +
        `The result is compact: each new node's id, type, kind, name, parent and bounds (a count instead of points; an array's layout, item count and range of tops, with items: true its item lines). dry_run: true checks the batch and returns this result, and every error, drawing nothing.`,
      inputSchema: { shapes: z.array(ShapeInputSchema).min(1), verbose: VERBOSE, items: ITEMS, dry_run: DRY_RUN },
    },
    async ({ shapes, verbose, items, dry_run }) => json(edit(dry_run, () => {
      const created = guided(() => store().drawShapes(shapes, "agent"));
      const refs = refWarnings(created.flatMap((c) => (c.type === "note" ? [{ id: c.id, description: c.text }] : c.type === "group" ? [{ id: c.id, description: c.description }] : [])));
      // Each batch ref's ID (the entries are created in order).
      const named = shapes.flatMap((sh, i) => (sh.ref !== undefined ? [[sh.ref, created[i].id] as const] : []));
      const batchRefs = named.length > 0 ? { refs: Object.fromEntries(named) } : {};
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
        arrays: all.filter((n) => n.type === "array").length,
        groups: all.filter(isGroup).length,
      };
      const warnings = refs.length > 0 ? { warnings: refs } : {};
      if (!verbose) return warned({ ...batchRefs, created: compactNodes(all, created.map((c) => c.id), { items }), ...warnings });
      return warned({ ...batchRefs, created, totals, ...warnings });
    })),
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
        `points (with y), width, step (null = smooth) and base; a note name, parent, x, y, z, color, text, label (null removes it) and status (open or done); an instance name, parent, x, y, z, rotation and entity (another entity's ID, to swap it); ` +
        `an array name, parent, entities, layout (fields merge into it; another type replaces it), facing, rotation, jitter, turnJitter, seed and skip. ` +
        `An instance or array takes on ({ id } to stand on a node, null to stop), a line through (new stops, or null to unlink it). ` +
        `Giving a through line points, or something standing a height (y, or an array's layout y), unlinks it. ` +
        `A group takes only name, description (what that part of the level is; null removes it), parent, locked and hidden (any node takes those two). ` +
        `{ id, type: "freeform" } alone converts a box or cylinder into a free-form with a new ID; a call that converts ` +
        `only converts (edit the new free-form in a second call). ` +
        `Values are absolute (x: 4 moves the center to x = 4); to shift boxes or whole groups by an offset, use move_nodes instead. ` +
        `An empty name removes the name; parent null moves a node to the top level. ` +
        `The batch is all-or-nothing: an unknown ID or an invalid value rejects it and nothing changes. ` +
        `The result is compact (as draw_shapes'), unless verbose.`,
      inputSchema: { changes: z.array(NodeUpdateSchema).min(1), verbose: VERBOSE, items: ITEMS, dry_run: DRY_RUN },
    },
    async ({ changes, verbose, items, dry_run }) => json(edit(dry_run, () => {
      const full = guided(() => store().updateNodes(changes, "agent"));
      const updated = verbose ? full : compactNodes(store().getScene().nodes, full.map((n) => n.id), { items });
      const refs = refWarnings(changes.map((c) => ({ id: c.id, description: c.description ?? c.text })));
      if (!changes.some((c) => c.type !== undefined)) return warned({ updated, ...(refs.length > 0 ? { warnings: refs } : {}) });
      return warned({ converted: changes.map((c, i) => ({ from: c.id, to: full[i].id })), updated });
    })),
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
      // What follows, stands on or goes through something (10.3, 13.4).
      const linked = (n: SceneNode) => isFollowing(n) || ((n.type === "instance" || n.type === "array") && !!n.on) || (n.type === "line" && !!n.through);
      const following = (nodes: SceneNode[]) => new Set(nodes.filter(linked).map((n) => n.id));
      const before = following(store().getScene().nodes);
      store().removeNodes(ids, "agent");
      const after = following(store().getScene().nodes);
      const kept = new Set(store().getScene().nodes.map((n) => n.id));
      // What followed, stood on or went through a removed node keeps what it had, unlinked.
      const unlinked = [...before].filter((id) => !after.has(id) && kept.has(id));
      return json({ removed: ids, remaining: store().getScene().nodes.length, ...(unlinked.length > 0 ? { unlinked } : {}) });
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
        `nesting and parent group, and are returned (their roots). The result is compact, unless verbose.`,
      inputSchema: MoveNodesSchema.extend({
        copy: z.boolean().optional().describe("Leave the nodes in place and add copies at the offset"),
        count: DuplicateNodesSchema.shape.count.describe(`With copy: how many copies, 1..${MAX_COPIES}, default 1`),
        verbose: VERBOSE,
        items: ITEMS,
        dry_run: DRY_RUN,
      }).shape,
    },
    async ({ copy, count, verbose, items, dry_run, ...move }) => json(edit(dry_run, () => {
      const compact = (nodes: SceneNode[]) => (verbose ? nodes : compactNodes(store().getScene().nodes, nodes.map((n) => n.id), { items }));
      if (copy) return { copies: compact(store().duplicateNodes({ ...move, count }, "agent")) };
      if (count !== undefined) throw new SceneError("count only applies with copy: true. Nothing was moved.");
      return { moved: compact(store().moveNodes(move, "agent")) };
    })),
  );

  server.registerTool(
    "rotate_nodes",
    {
      title: "Rotate nodes",
      description:
        `Turn shapes and/or whole groups by \`degrees\` (counterclockwise seen from above) around the vertical axis through ` +
        `\`pivot\` (default: the center of their combined bounds): every box's or cylinder's center orbits that point and ` +
        `its rotation grows by the same angle; a free-form's points orbit it. The result gives the pivot used. The ` +
        `bounds' center moves as shapes turn, so to turn something back (or in several steps), pass that same pivot. ` +
        `The result is compact, unless verbose.`,
      inputSchema: RotateNodesSchema.extend({ verbose: VERBOSE, items: ITEMS, dry_run: DRY_RUN }).shape,
    },
    async ({ verbose, items, dry_run, ...input }) => json(edit(dry_run, () => {
      const { shapes, pivot } = store().rotateNodes(input, "agent");
      return { rotated: verbose ? shapes : compactNodes(store().getScene().nodes, shapes.map((n) => n.id), { items }), pivot };
    })),
  );

  server.registerTool(
    "mirror_nodes",
    {
      title: "Mirror nodes",
      description:
        `Flip boxes and/or whole groups in place on a world axis, across the center of their combined bounds: ` +
        `axis x swaps east and west (every x reflects), axis z swaps north (-z) and south (+z). y never changes, and every rotation ` +
        `becomes -rotation (an odd-sided cylinder mirrored on x: 180 - rotation; a free-form's points reflect). A group mirrors as a unit. ` +
        `Mirroring twice restores the original exactly. The result is compact, unless verbose.`,
      inputSchema: MirrorNodesSchema.extend({ verbose: VERBOSE, items: ITEMS, dry_run: DRY_RUN }).shape,
    },
    async ({ verbose, items, dry_run, ...input }) => json(edit(dry_run, () => {
      const mirrored = store().mirrorNodes(input, "agent");
      return { mirrored: verbose ? mirrored : compactNodes(store().getScene().nodes, mirrored.map((n) => n.id), { items }) };
    })),
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
      const made = store().groupNodes(input, "agent");
      const [group] = compactNodes(store().getScene().nodes, [made.id]);
      const refs = refWarnings([{ id: made.id, description: made.description }]);
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
        "Labels are letters, and the text result is their legend. Hidden nodes are left out, and notes aren't drawn (read them in get_scene). " +
        "For an enclosed room, hide its walls or clip at eye height instead of rendering the outside of a wall.",
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
    "check_sight",
    {
      title: "Check sight",
      description:
        "Check what can be SEEN, in text, without rendering: from each eye to each target, how much of the target is " +
        "visible (the share of about 15 points over it that rays reach) and what blocks the rest, nearest first (items " +
        "as array_1/12). Rays pass through holes (doors, windows) and leave out hidden nodes and `ignore`. Use it for " +
        "landmarks and goals: from the entrance and from each beat's standing point, is the relic in view? Render when " +
        "you need to see how it looks, not whether it's visible.",
      inputSchema: {
        from: z
          .union([SightFromSchema, z.array(SightFromSchema).min(1).max(20)])
          .describe('Where the eye is: a point {x, y?, z} (the feet; y from the surface there when left out), a node or item ID (someone standing on its top), or "human" (where the human is walking); or a list of them'),
        to: z.union([z.string(), z.array(z.string()).min(1).max(20)]).describe("The target(s): node or item IDs (a landmark, a goal, a door)"),
        ignore: z.array(z.string()).optional().describe("Nodes that don't block sight (light shafts, decor, glass), with what's in them"),
      },
    },
    async ({ from, to, ignore }) => {
      const scene = store().getScene();
      const nodes = scene.nodes;
      const eyeHeight = workspace.player().eyeHeight;
      const solids = expandShapes(nodes.filter(isShape));
      const eyes = (Array.isArray(from) ? from : [from]).map((f) => {
        if (f === "human") {
          if (!scene.view.walking) throw new SceneError('from: "human": the human isn\'t walking right now (view.walking is only there while they use the Walk tool). Give a point or a node instead.');
          return { label: "human", eye: scene.view.walking.eye };
        }
        if (typeof f === "string") {
          const top = topOf(nodes, f);
          if (!top) throw new SceneError(`from: "${f}" has nothing to stand on (no such node or item, or a line or an array: its items do)`);
          return { label: f, eye: { x: top.x, y: top.y + eyeHeight, z: top.z } };
        }
        const y = f.y ?? surfaceAt(solids, f.x, f.z) ?? 0;
        return { label: `${f.x}, ${f.z}`, eye: { x: f.x, y: y + eyeHeight, z: f.z } };
      });
      let pairs;
      try {
        pairs = checkSight(nodes, eyes, Array.isArray(to) ? to : [to], ignore ?? []);
      } catch (err) {
        throw new SceneError(`${(err as Error).message}. Nothing was checked.`);
      }
      const lines = pairs.map(
        (p) => `${p.from} → ${p.to}: ${Math.round(p.visible * 100)}%${p.blockers.length > 0 ? ` · blocked by ${p.blockers.join(", then ")}` : ""}`,
      );
      return json({ eyeHeight, sight: lines });
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

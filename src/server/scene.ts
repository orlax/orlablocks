import type { z } from "zod";
import {
  boundsOf,
  isFootprinted,
  mirrorAcross,
  moveShape,
  normalizeDeg,
  lineProblem,
  outlineProblem,
  rotateAround,
  round2,
  roundPoints,
  sameValue,
  toFreeformPoints,
} from "../shared/geometry";
import {
  ConvertNodesSchema,
  DEFAULT_COLOR,
  DEFAULT_WALL,
  DEFAULT_HEIGHT,
  DEFAULT_LINE_COLOR,
  DEFAULT_THICKNESS,
  DEFAULT_VIEW,
  DuplicateNodesSchema,
  GroupNodesSchema,
  MIN_HEIGHT,
  MIN_WALL,
  MirrorNodesSchema,
  MoveNodesSchema,
  NodeUpdateSchema,
  PasteNodesSchema,
  PlaceNodesSchema,
  RotateNodesSchema,
  ShapeInputSchema,
  SNAP,
  UngroupSchema,
  type Actor,
  type Box,
  type Cylinder,
  type Freeform,
  type LinePoint,
  type Shape,
  type FootPoint,
  type ShapePatch,
  type Group,
  type HistorySummary,
  type NodePatch,
  type NodeUpdate,
  type Scene,
  type SceneNode,
  type ShapeInput,
  type View,
} from "../shared/scene.types";
import { firstIds, type NextId } from "../shared/project.types";
import { shapesUnder, commonParent, copyNodes, isShape, isGroup, subtreeIds, topmost } from "../shared/tree";
import { applyOp, createHistory, invertOp, runOps, type History, type HistoryEntry, type Op } from "./commands";

export class SceneError extends Error {}

/** A change to the nodes that the history records: a new step, or moving through the existing ones. */
export type Step = { type: "commit"; entry: HistoryEntry } | { type: "undo"; entry: HistoryEntry } | { type: "redo"; entry: HistoryEntry };

/** Degrees in 0..360, 2 decimals. */
const normalizeRotation = (deg: number) => round2(normalizeDeg(deg)) % 360;

/** "box_3", "box_4, group_1" or "5 nodes". */
const listIds = (ids: string[], plural = "nodes") => (ids.length <= 3 ? ids.join(", ") : `${ids.length} ${plural}`);

/** "Draw box_3", or for the agent "Agent: draw box_4, box_5". Same shape for every label. */
function label(verb: string, what: string, actor: Actor): string {
  const text = `${verb} ${what}`;
  return actor === "agent" ? `Agent: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

/** "lobby (group_1)" for one named node, else as `listIds`. */
function describeIds(nodes: SceneNode[], ids: string[]): string {
  const name = ids.length === 1 ? nodes.find((n) => n.id === ids[0])?.name : undefined;
  return name ? `${name} (${ids[0]})` : listIds(ids);
}

const FIELD_VERBS: Record<keyof NodePatch, string> = {
  name: "rename",
  parent: "regroup",
  kind: "change kind of",
  x: "move",
  z: "move",
  y: "change elevation of",
  width: "resize",
  depth: "resize",
  height: "change height of",
  rotation: "rotate",
  color: "recolor",
  sides: "change sides of",
  wall: "change walls of",
  points: "reshape",
  thickness: "restyle",
  dashed: "restyle",
  arrow: "restyle",
};

/**
 * One verb when every change is the same kind of edit ("move", "recolor"), "edit" otherwise. A kind change that
 * drops the fields the new kind doesn't have (a room's `wall`) is still "change kind of".
 */
function updateVerb(patches: NodePatch[]): string {
  const keys = (p: NodePatch) => Object.keys(p).filter((k) => !("kind" in p && k === "wall" && p.wall === undefined));
  const verbs = new Set(patches.flatMap((p) => keys(p).map((k) => FIELD_VERBS[k as keyof NodePatch])));
  return verbs.size === 1 ? [...verbs][0] : "edit";
}

/** Turns zod issues into "changes[1].height: ..." lines. */
function issueLines(prefix: string, issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => `${prefix}.${issue.path.map(String).join(".") || "(item)"}: ${issue.message}`);
}

/** Parses with a zod schema or throws a SceneError listing every issue. */
function parse<T extends z.ZodType>(schema: T, input: unknown, failure: string): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new SceneError(`${failure}\n${issueLines("", result.error.issues).map((l) => l.slice(1)).join("\n")}`);
  return result.data;
}

export function createSceneStore() {
  const scene: Scene = { view: { ...DEFAULT_VIEW }, selection: [], nodes: [] };
  const listeners = new Set<(scene: Scene) => void>();
  const stepListeners = new Set<(step: Step) => void>();
  // Only go up, so IDs are never reused.
  const nextId: NextId = firstIds();

  let history = createHistory();

  /** The next ID for a new node of `type`. */
  const newId = (type: SceneNode["type"]) => `${type}_${nextId[type]++}`;

  /** Tells step listeners (persistence) first, so a step is on disk before anyone sees it. */
  const step = (s: Step) => stepListeners.forEach((l) => l(s));

  const byId = () => new Map(scene.nodes.map((n) => [n.id, n]));

  /** After every change to the nodes: drop selected IDs that no longer exist, then broadcast. */
  const emit = () => {
    const ids = new Set(scene.nodes.map((n) => n.id));
    scene.selection = scene.selection.filter((id) => ids.has(id));
    listeners.forEach((l) => l(scene));
  };

  /**
   * The single path for edits: apply ops, record one undo step, broadcast. Groups the ops leave empty are removed
   * as part of the same step (a group never outlives its contents).
   */
  const commit = (label: string, actor: Actor, ops: Op[]) => {
    const all = [...ops];
    let { nodes, inverse } = runOps(scene.nodes, ops);
    for (;;) {
      const empty = nodes.filter((n) => isGroup(n) && !nodes.some((c) => c.parent === n.id)).map((n) => n.id);
      if (empty.length === 0) break;
      const prune: Op = { op: "remove", ids: empty };
      inverse = [invertOp(nodes, prune), ...inverse];
      nodes = applyOp(nodes, prune);
      all.push(prune);
    }
    scene.nodes = nodes;
    const entry: HistoryEntry = { label, actor, at: Date.now(), ops: all, inverse };
    history.push(entry);
    step({ type: "commit", entry });
    emit();
  };

  /** Errors for IDs that don't exist or repeat. `prefix` is e.g. "ids". */
  const checkIds = (prefix: string, ids: string[], errors: string[]) => {
    const nodes = byId();
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (!nodes.has(id)) errors.push(`${prefix}[${i}]: no node "${id}"`);
      if (seen.has(id)) errors.push(`${prefix}[${i}]: "${id}" appears more than once`);
      seen.add(id);
    });
  };

  const failIf = (errors: string[], what: string) => {
    if (errors.length > 0) throw new SceneError(`${what}\n${errors.join("\n")}`);
  };

  /** An error message if `parent` can't hold nodes (unknown, or not a group), else null. */
  const parentError = (parent: string) => {
    const node = byId().get(parent);
    if (!node) return `no group "${parent}"`;
    if (!isGroup(node)) return `"${parent}" is a ${node.type}, not a group`;
    return null;
  };

  /** Reports sizes that fall out of range once rounded to 2 decimals. */
  const checkSizes = (prefix: string, r: { width?: number; depth?: number; height?: number }, errors: string[]) => {
    if (r.width !== undefined && round2(r.width) <= 0) errors.push(`${prefix}.width: ${r.width} rounds to 0 at 2 decimals`);
    if (r.depth !== undefined && round2(r.depth) <= 0) errors.push(`${prefix}.depth: ${r.depth} rounds to 0 at 2 decimals`);
    if (r.height !== undefined && round2(r.height) < MIN_HEIGHT) {
      errors.push(`${prefix}.height: ${r.height} rounds below ${MIN_HEIGHT} at 2 decimals`);
    }
  };

  /** A wall thickness as stored: 2 decimals, and none (undefined) for the default. */
  const wallValue = (prefix: string, wall: number, errors: string[]) => {
    const w = round2(wall);
    if (w < MIN_WALL) errors.push(`${prefix}: ${wall} rounds below ${MIN_WALL} at 2 decimals`);
    return w === DEFAULT_WALL ? undefined : w;
  };

  /** A free-form's points rounded to 2 decimals, or an error (as `prefix: ...`) if the outline isn't valid. */
  const checkPoints = (prefix: string, points: FootPoint[], errors: string[]) => {
    const rounded = roundPoints(points);
    const problem = outlineProblem(rounded);
    if (problem) errors.push(`${prefix}.points: ${problem}`);
    return rounded;
  };

  /**
   * Converts boxes and cylinders into free-forms with the same outline, as one step (see `convertNodes`). `prefix`
   * names the input in errors ("ids", or "changes" for update_nodes).
   */
  const convert = (ids: string[], actor: Actor, prefix: string): Freeform[] => {
    const errors: string[] = [];
    checkIds(prefix, ids, errors);
    const nodes = byId();
    const sources = ids.map((id, i) => {
      const node = nodes.get(id);
      if (node && node.type !== "box" && node.type !== "cylinder") {
        errors.push(`${prefix}[${i}]: "${id}" is a ${node.type}; only boxes and cylinders convert to free-forms`);
      }
      return node as Box | Cylinder;
    });
    const outlines = sources.map((n, i) =>
      n?.type === "box" || n?.type === "cylinder" ? checkPoints(`${prefix}[${i}]`, toFreeformPoints(n), errors) : [],
    );
    failIf(errors, "Nothing was converted.");

    const made = sources.map(
      (n, i): Freeform => ({
        id: newId("freeform"),
        type: "freeform",
        ...(n.name !== undefined ? { name: n.name } : {}),
        ...(n.parent !== undefined ? { parent: n.parent } : {}),
        kind: n.kind,
        y: n.y,
        height: n.height,
        color: n.color,
        ...(n.wall !== undefined ? { wall: n.wall } : {}),
        points: outlines[i],
        createdBy: n.createdBy,
      }),
    );
    // Each takes its original's place in the list.
    const indices = ids.map((id) => scene.nodes.findIndex((n) => n.id === id));
    const to = listIds(
      made.map((n) => n.id),
      "free-forms",
    );
    commit(label("convert", `${listIds(ids)} to ${to}`, actor), actor, [
      { op: "remove", ids },
      { op: "add", nodes: made, indices },
    ]);
    return made;
  };

  /** A line's points rounded to 2 decimals, or an error (as `prefix: ...`) if the path isn't valid. */
  const checkLinePoints = (prefix: string, points: LinePoint[], errors: string[]) => {
    const rounded = roundPoints(points);
    const problem = lineProblem(rounded);
    if (problem) errors.push(`${prefix}.points: ${problem}`);
    return rounded;
  };

  /** Shape patches that change something, as update changes. */
  const effectiveShapeChanges = (boxes: Shape[], patches: Record<string, ShapePatch>) =>
    boxes.flatMap((box) => {
      const patch = patches[box.id];
      const changed = patch && (Object.keys(patch) as (keyof ShapePatch)[]).some((k) => !sameValue(patch[k], (box as ShapePatch)[k]));
      return changed ? [{ id: box.id, patch }] : [];
    });

  return {
    getScene(): Scene {
      return scene;
    },

    getHistory(): HistorySummary {
      return history.summary();
    },

    /** The next number for each kind of ID. */
    getNextId(): NextId {
      return { ...nextId };
    },

    /**
     * Replaces the whole scene with a saved one (opening a scene): its nodes, ID counters and history (rebuilt from
     * the log; empty if none), and no selection. Broadcasts; isn't a step.
     */
    load(saved: { nodes: SceneNode[]; nextId: NextId; history?: History }): void {
      scene.nodes = saved.nodes;
      scene.selection = [];
      Object.assign(nextId, saved.nextId);
      history = saved.history ?? createHistory();
      emit();
    },

    /**
     * Validates every input first; applies all or nothing. Missing fields get their defaults: a box, the kind's
     * height, y 0, rotation 0, the default color, no name, the top level (and a smooth cylinder).
     */
    drawShapes(inputs: ShapeInput[], actor: Actor): Shape[] {
      if (inputs.length === 0) throw new SceneError("shapes: at least one shape is required");

      const errors: string[] = [];
      const valid = inputs.map((input, i) => {
        const result = ShapeInputSchema.safeParse(input);
        if (!result.success) {
          errors.push(...issueLines(`shapes[${i}]`, result.error.issues));
          return null;
        }
        const d = result.data;
        const prefix = `shapes[${i}]`;
        if (d.parent !== undefined) {
          const e = parentError(d.parent);
          if (e) errors.push(`${prefix}.parent: ${e}`);
        }
        const name = d.name?.trim();
        if (d.type === "line") {
          return {
            type: "line" as const,
            ...(name ? { name } : {}),
            ...(d.parent !== undefined ? { parent: d.parent } : {}),
            color: d.color ?? DEFAULT_LINE_COLOR,
            points: checkLinePoints(prefix, d.points, errors),
            thickness: round2(d.thickness ?? DEFAULT_THICKNESS),
            dashed: d.dashed ?? false,
            arrow: d.arrow ?? "none",
          };
        }
        const height = d.height ?? DEFAULT_HEIGHT[d.kind];
        checkSizes(prefix, { ...(d.type === "freeform" ? {} : { width: d.width, depth: d.depth }), height }, errors);
        if (d.wall !== undefined && d.kind !== "room") errors.push(`${prefix}.wall: only a room has walls (this is a ${d.kind})`);
        const wall = d.wall !== undefined ? wallValue(`${prefix}.wall`, d.wall, errors) : undefined;
        const common = {
          ...(name ? { name } : {}),
          ...(d.parent !== undefined ? { parent: d.parent } : {}),
          kind: d.kind,
          y: round2(d.y ?? 0),
          height: round2(height),
          color: d.color ?? DEFAULT_COLOR,
          ...(wall !== undefined ? { wall } : {}),
        };
        if (d.type === "freeform") return { type: "freeform" as const, ...common, points: checkPoints(prefix, d.points, errors) };
        const type = d.type ?? "box";
        if (d.sides !== undefined && type !== "cylinder") errors.push(`${prefix}.sides: only a cylinder has sides (this is a ${type})`);
        return {
          type,
          ...(type === "cylinder" && d.sides !== undefined ? { sides: d.sides } : {}),
          ...common,
          x: round2(d.x),
          z: round2(d.z),
          width: round2(d.width),
          depth: round2(d.depth),
          rotation: normalizeRotation(d.rotation ?? 0),
        };
      });
      failIf(errors, "Nothing was drawn.");

      const created = valid.map((b) => ({ id: newId(b!.type), ...b!, createdBy: actor }) as Shape);
      const ids = created.map((b) => b.id);
      commit(label("draw", listIds(ids, "shapes"), actor), actor, [{ op: "add", nodes: created }]);
      return created;
    },

    /**
     * Changes existing nodes by ID. A box or cylinder takes any of name, parent, kind, x, z, y, width, depth, height,
     * rotation, color, and a cylinder also sides (null = smooth); a free-form takes name, parent, kind, y, height,
     * color and points (the whole outline); a group takes only name and parent. Validates every change first;
     * applies all or nothing. Fields that don't actually change are dropped, and if nothing is left no step is
     * recorded. An empty name removes the name, and a null (or empty) parent moves the node to the top level.
     * `type: "freeform"` converts a box or cylinder instead (see `convertNodes`): then every change in the call must
     * be a conversion, on its own, and the result is the new free-forms in the same order.
     */
    updateNodes(changes: NodeUpdate[], actor: Actor): SceneNode[] {
      if (changes.length === 0) throw new SceneError("changes: at least one change is required");
      if (changes.some((c) => c.type !== undefined)) {
        const errors: string[] = [];
        changes.forEach((c, i) => {
          const result = NodeUpdateSchema.safeParse(c);
          if (!result.success) return errors.push(...issueLines(`changes[${i}]`, result.error.issues));
          const { id: _id, type, ...others } = result.data;
          const fields = Object.keys(others);
          if (type === undefined) errors.push(`changes[${i}]: a call that converts (type: "freeform") can only convert; update the new free-forms in a second call`);
          else if (fields.length > 0) errors.push(`changes[${i}]: type converts on its own; change ${fields.join(", ")} in a second call, on the new free-form`);
        });
        failIf(errors, "Nothing was changed.");
        return convert(
          changes.map((c) => c.id),
          actor,
          "changes",
        );
      }

      const nodes = byId();
      const seen = new Set<string>();
      const errors: string[] = [];
      const valid = changes.map((change, i) => {
        const result = NodeUpdateSchema.safeParse(change);
        if (!result.success) {
          errors.push(...issueLines(`changes[${i}]`, result.error.issues));
          return null;
        }
        const { id, ...fields } = result.data;
        const node = nodes.get(id);
        if (!node) errors.push(`changes[${i}].id: no node "${id}"`);
        if (seen.has(id)) errors.push(`changes[${i}].id: "${id}" appears more than once`);
        seen.add(id);
        if (Object.keys(fields).length === 0) errors.push(`changes[${i}]: nothing to change`);
        if (node && isGroup(node)) {
          const shapeOnly = Object.keys(fields).filter((k) => k !== "name" && k !== "parent");
          if (shapeOnly.length > 0) errors.push(`changes[${i}]: "${id}" is a group; only name and parent can change (not ${shapeOnly.join(", ")})`);
        } else if (node) {
          if (fields.sides !== undefined && node.type !== "cylinder") {
            errors.push(`changes[${i}].sides: only a cylinder has sides ("${id}" is a ${node.type})`);
          }
          if (fields.points !== undefined && node.type !== "freeform" && node.type !== "line") {
            errors.push(`changes[${i}].points: only free-forms and lines have points ("${id}" is a ${node.type})`);
          }
          const lineOnly = (["thickness", "dashed", "arrow"] as const).filter((k) => fields[k] !== undefined);
          if (node.type !== "line" && lineOnly.length > 0) {
            errors.push(`changes[${i}]: only a line has ${lineOnly.join(", ")} ("${id}" is a ${node.type})`);
          }
          if (node.type === "line") {
            const closedOnly = (["kind", "x", "z", "y", "width", "depth", "height", "rotation", "wall"] as const).filter((k) => fields[k] !== undefined);
            if (closedOnly.length > 0) {
              errors.push(
                `changes[${i}]: "${id}" is a line, with no ${closedOnly.join(", ")}: change its points (they carry their own y), ` +
                  `or use move_nodes / rotate_nodes`,
              );
            }
          }
          if (node.type !== "line" && fields.wall !== undefined && fields.wall !== null && (fields.kind ?? node.kind) !== "room") {
            errors.push(`changes[${i}].wall: only a room has walls ("${id}" is a ${fields.kind ?? node.kind})`);
          }
          if (node.type === "freeform") {
            const footprinted = (["x", "z", "width", "depth", "rotation"] as const).filter((k) => fields[k] !== undefined);
            if (footprinted.length > 0) {
              errors.push(
                `changes[${i}]: "${id}" is a free-form, with no ${footprinted.join(", ")} of its own: change its points, ` +
                  `or use move_nodes / rotate_nodes`,
              );
            }
          }
        }
        checkSizes(`changes[${i}]`, fields, errors);
        const parent = fields.parent === null || fields.parent === "" ? undefined : fields.parent;
        if (parent !== undefined) {
          const e = parentError(parent);
          if (e) errors.push(`changes[${i}].parent: ${e}`);
        }
        if (!node) return null;

        const patch: NodePatch = {};
        for (const key of ["x", "z", "y", "width", "depth", "height"] as const) {
          if (fields[key] !== undefined) patch[key] = round2(fields[key]);
        }
        if (fields.rotation !== undefined) patch.rotation = normalizeRotation(fields.rotation);
        if (fields.kind !== undefined) patch.kind = fields.kind;
        if (fields.color !== undefined) patch.color = fields.color;
        if (fields.sides !== undefined) patch.sides = fields.sides ?? undefined;
        if (fields.wall !== undefined) patch.wall = fields.wall === null ? undefined : wallValue(`changes[${i}].wall`, fields.wall, errors);
        // A room that becomes something else loses its walls' thickness (undo brings it back).
        if (fields.kind !== undefined && fields.kind !== "room" && isShape(node) && node.type !== "line" && node.wall !== undefined) patch.wall = undefined;
        if (fields.points !== undefined && node?.type === "freeform") {
          if (fields.points.some((p) => p.y !== undefined || p.in?.y !== undefined || p.out?.y !== undefined)) {
            errors.push(`changes[${i}].points: a free-form's points have no y (the free-form has its own y)`);
          }
          const flat = fields.points.map(({ y: _y, in: pin, out: pout, ...p }) => ({
            ...p,
            ...(pin ? { in: { x: pin.x, z: pin.z } } : {}),
            ...(pout ? { out: { x: pout.x, z: pout.z } } : {}),
          }));
          patch.points = checkPoints(`changes[${i}]`, flat, errors);
        }
        if (fields.points !== undefined && node?.type === "line") {
          const missing = fields.points.findIndex((p) => p.y === undefined || (p.in && p.in.y === undefined) || (p.out && p.out.y === undefined));
          if (missing >= 0) errors.push(`changes[${i}].points[${missing}]: a line's points (and handles) need a y`);
          else patch.points = checkLinePoints(`changes[${i}]`, fields.points as LinePoint[], errors);
        }
        if (fields.thickness !== undefined) patch.thickness = round2(fields.thickness);
        if (fields.dashed !== undefined) patch.dashed = fields.dashed;
        if (fields.arrow !== undefined) patch.arrow = fields.arrow;
        if (fields.name !== undefined) patch.name = fields.name.trim() || undefined;
        if (fields.parent !== undefined) patch.parent = parent;

        // Keep only what differs from the node as it is.
        const effective: NodePatch = {};
        for (const key of Object.keys(patch) as (keyof NodePatch)[]) {
          if (!sameValue(patch[key], (node as Record<string, unknown>)[key])) (effective as Record<string, unknown>)[key] = patch[key];
        }
        return { id, patch: effective, index: i };
      });
      failIf(errors, "Nothing was changed.");

      // No node may end up inside itself.
      const next = runOps(scene.nodes, [{ op: "update", changes: valid.map((c) => ({ id: c!.id, patch: c!.patch })) }]).nodes;
      for (const c of valid) {
        if (c!.patch.parent !== undefined && isCycle(next, c!.id)) {
          errors.push(`changes[${c!.index}].parent: "${c!.patch.parent}" is inside "${c!.id}"`);
        }
      }
      failIf(errors, "Nothing was changed.");

      const effective = valid.filter((c) => Object.keys(c!.patch).length > 0).map((c) => ({ id: c!.id, patch: c!.patch }));
      if (effective.length > 0) {
        const verb = updateVerb(effective.map((c) => c.patch));
        commit(label(verb, listIds(effective.map((c) => c.id)), actor), actor, [{ op: "update", changes: effective }]);
      }
      const ids = new Set(valid.map((c) => c!.id));
      return scene.nodes.filter((n) => ids.has(n.id));
    },

    /**
     * Converts boxes and cylinders into free-forms with the same outline, as one step: a box gives its 4 corners, a
     * sided cylinder its corners, a smooth one 4 smooth points (still a true circle or oval). Each free-form gets a
     * new ID and takes its original's place in the list, keeping its name, parent, kind, y, height, color and
     * creator. Returns the free-forms, in the order of `ids`.
     */
    convertNodes(input: z.input<typeof ConvertNodesSchema>, actor: Actor): Freeform[] {
      const { ids } = parse(ConvertNodesSchema, input, "Nothing was converted.");
      return convert(ids, actor, "ids");
    },

    /**
     * Removes nodes by ID as one undoable step; a group takes everything in it. Unknown or repeated IDs reject all.
     * `cut` only changes the label (the editor put the nodes on the clipboard first).
     */
    removeNodes(ids: string[], actor: Actor, { cut = false }: { cut?: boolean } = {}): void {
      if (ids.length === 0) throw new SceneError("ids: at least one ID is required");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was removed.");
      const all = new Set(ids.flatMap((id) => [...subtreeIds(scene.nodes, id)]));
      const remove = scene.nodes.filter((n) => all.has(n.id)).map((n) => n.id);
      commit(label(cut ? "cut" : "delete", listIds(ids), actor), actor, [{ op: "remove", ids: remove }]);
    },

    /** Moves boxes and whole groups by a relative offset, as one step. Returns the boxes that moved. */
    moveNodes(input: z.input<typeof MoveNodesSchema>, actor: Actor): Shape[] {
      const { ids, dx = 0, dy = 0, dz = 0 } = parse(MoveNodesSchema, input, "Nothing was moved.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was moved.");
      const boxes = shapesUnder(scene.nodes, ids);
      const patches = Object.fromEntries(boxes.map((b) => [b.id, moveShape(b, dx, dy, dz)]));
      const changes = effectiveShapeChanges(boxes, patches);
      if (changes.length > 0) commit(label("move", listIds(ids), actor), actor, [{ op: "update", changes }]);
      const moved = new Set(boxes.map((b) => b.id));
      return scene.nodes.filter((n): n is Shape => moved.has(n.id));
    },

    /**
     * Copies boxes and whole groups with fresh IDs, as one step: copy i (1..count) is offset by i × (dx, dy, dz).
     * A listed node inside another listed node is copied as part of it. Copies keep their names and their
     * original's parent, and go right after the original's subtree in the list (copy 1, copy 2, ...). Returns the
     * copied roots.
     */
    duplicateNodes(input: z.input<typeof DuplicateNodesSchema>, actor: Actor): SceneNode[] {
      const { ids, dx = 0, dy = 0, dz = 0, count = 1 } = parse(DuplicateNodesSchema, input, "Nothing was copied.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was copied.");

      const roots = topmost(scene.nodes, ids);
      // After which original each root's copies go: the last node of its subtree in the list.
      const copiesAfter = new Map<string, SceneNode[]>();
      const copiedRoots: SceneNode[] = [];
      const subtrees = roots.map((id) => {
        const inside = subtreeIds(scene.nodes, id);
        return { id, nodes: scene.nodes.filter((n) => inside.has(n.id)) };
      });
      for (let i = 1; i <= count; i++) {
        for (const { id, nodes } of subtrees) {
          const copies = copyNodes(nodes, newId, { dx: dx * i, dy: dy * i, dz: dz * i }).map((n) => ({ ...n, createdBy: actor }));
          copiedRoots.push(copies[nodes.findIndex((n) => n.id === id)]);
          const last = nodes.at(-1)!.id;
          copiesAfter.set(last, [...(copiesAfter.get(last) ?? []), ...copies]);
        }
      }
      const next = scene.nodes.flatMap((n) => [n, ...(copiesAfter.get(n.id) ?? [])]);
      const added = new Set([...copiesAfter.values()].flat().map((n) => n.id));
      const indices: number[] = [];
      const nodes = next.filter((n, index) => added.has(n.id) && indices.push(index));

      const times = count > 1 ? ` ×${count}` : "";
      commit(label("copy", describeIds(scene.nodes, roots) + times, actor), actor, [{ op: "add", nodes, indices }]);
      return copiedRoots;
    },

    /**
     * Turns boxes and whole groups around the vertical axis through `pivot` (default: the center of their combined
     * bounds), as one step: each center orbits it and the angle is added to each rotation (a free-form's points
     * orbit it). Returns the shapes that turned and the pivot, so turning back by the same pivot restores them.
     */
    rotateNodes(input: z.input<typeof RotateNodesSchema>, actor: Actor): { shapes: Shape[]; pivot: { x: number; z: number } } {
      const { ids, degrees, pivot: given } = parse(RotateNodesSchema, input, "Nothing was rotated.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was rotated.");
      const boxes = shapesUnder(scene.nodes, ids);
      const b = boundsOf(boxes);
      const pivot = given ?? { x: round2((b.minX + b.maxX) / 2), z: round2((b.minZ + b.maxZ) / 2) };
      const patches = rotateAround(boxes, pivot, degrees);
      const changes = effectiveShapeChanges(boxes, patches);
      if (changes.length > 0) commit(label("rotate", listIds(ids), actor), actor, [{ op: "update", changes }]);
      const turned = new Set(boxes.map((b) => b.id));
      return { shapes: scene.nodes.filter((n): n is Shape => turned.has(n.id)), pivot };
    },

    /**
     * Pastes a clipboard snapshot as one step: fresh IDs (names and nesting kept), centered on `focus` with the offset
     * rounded to the 0.5 m snap (so it stays on its grid), each box keeping its y. Parent references that point
     * outside the snapshot are dropped, so those nodes become roots, and the roots go into `parent` (null = the top
     * level; inside a group they come last among its children). Returns the pasted roots.
     */
    pasteNodes(input: z.input<typeof PasteNodesSchema>, actor: Actor): SceneNode[] {
      const { nodes: snapshot, focus, parent } = parse(PasteNodesSchema, input, "Nothing was pasted.");
      const errors: string[] = [];
      const seen = new Set<string>();
      snapshot.forEach((n, i) => {
        if (seen.has(n.id)) errors.push(`nodes[${i}].id: "${n.id}" appears more than once`);
        seen.add(n.id);
      });
      const target = parent ?? undefined;
      if (target !== undefined) {
        const e = parentError(target);
        if (e) errors.push(`parent: ${e}`);
      }
      const groups = new Set(snapshot.filter(isGroup).map((n) => n.id));
      const nodes = snapshot.map((n, i): SceneNode => {
        const { parent: p, ...rest } = n;
        const kept = p !== undefined && groups.has(p) ? { parent: p } : {};
        if (!isShape(n)) return { ...rest, ...kept } as SceneNode;
        if (n.type === "line") {
          return { ...(rest as typeof n), ...kept, thickness: round2(n.thickness), points: checkLinePoints(`nodes[${i}]`, n.points, errors) };
        }
        const shape = { ...(rest as Shape), ...kept, height: round2(n.height) } as Shape;
        if (shape.type === "freeform") return { ...shape, points: checkPoints(`nodes[${i}]`, shape.points, errors) };
        if (shape.type === "line") return shape;
        return { ...shape, width: round2(shape.width), depth: round2(shape.depth), rotation: normalizeRotation(shape.rotation) };
      });
      nodes.forEach((n, i) => {
        if (isShape(n)) checkSizes(`nodes[${i}]`, snapshot[i] as Partial<Record<"width" | "depth" | "height", number>>, errors);
        if (isCycle(nodes, n.id)) errors.push(`nodes[${i}].parent: "${n.id}" ends up inside itself`);
      });
      const boxes = nodes.filter(isShape);
      if (boxes.length === 0) errors.push("nodes: there are no shapes to paste");
      failIf(errors, "Nothing was pasted.");

      const b = boundsOf(boxes);
      const offset = (to: number, center: number) => round2(Math.round((to - center) / SNAP) * SNAP);
      const dx = offset(focus.x, (b.minX + b.maxX) / 2);
      const dz = offset(focus.z, (b.minZ + b.maxZ) / 2);
      const pasted = copyNodes(nodes, newId, { dx, dz }).map((n, i): SceneNode => {
        const root = nodes[i].parent === undefined;
        return { ...n, createdBy: actor, ...(root && target !== undefined ? { parent: target } : {}) };
      });

      const add: Op = { op: "add", nodes: pasted };
      if (target !== undefined) {
        // Right after the last node inside the group, so they come last among its children.
        const inside = subtreeIds(scene.nodes, target);
        const at = scene.nodes.reduce((last, n, i) => (inside.has(n.id) ? i + 1 : last), 0);
        add.indices = pasted.map((_, i) => at + i);
      }
      commit(label("paste", listIds(pasted.map((n) => n.id)), actor), actor, [add]);
      return pasted.filter((_, i) => nodes[i].parent === undefined);
    },

    /**
     * Mirrors boxes and whole groups in place on a world axis, as one step: every center reflects across the center
     * of their combined footprint bounds, and every rotation becomes -rotation. Records nothing if nothing changes
     * (a single unrotated box). Returns the boxes.
     */
    mirrorNodes(input: z.input<typeof MirrorNodesSchema>, actor: Actor): Shape[] {
      const { ids, axis } = parse(MirrorNodesSchema, input, "Nothing was mirrored.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was mirrored.");
      const boxes = shapesUnder(scene.nodes, ids);
      const changes = effectiveShapeChanges(boxes, mirrorAcross(boxes, axis));
      if (changes.length > 0) commit(label("mirror", `${listIds(ids)} on ${axis.toUpperCase()}`, actor), actor, [{ op: "update", changes }]);
      const mirrored = new Set(boxes.map((b) => b.id));
      return scene.nodes.filter((n): n is Shape => mirrored.has(n.id));
    },

    /**
     * Puts nodes in a new group, as one step. The group goes where the first of them was in the list, inside the
     * deepest group that held them all. A node whose ancestor is also listed stays where it is (inside it).
     */
    groupNodes(input: z.input<typeof GroupNodesSchema>, actor: Actor): Group {
      const { ids, name } = parse(GroupNodesSchema, input, "Nothing was grouped.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was grouped.");
      const members = topmost(scene.nodes, ids);
      const parent = commonParent(scene.nodes, members);
      const trimmed = name?.trim();
      const group: Group = {
        id: newId("group"),
        type: "group",
        ...(trimmed ? { name: trimmed } : {}),
        ...(parent !== undefined ? { parent } : {}),
        createdBy: actor,
      };
      const index = Math.min(...members.map((id) => scene.nodes.findIndex((n) => n.id === id)));
      commit(label("group", `${listIds(members)} as ${group.id}`, actor), actor, [
        { op: "add", nodes: [group], indices: [index] },
        { op: "update", changes: members.map((id) => ({ id, patch: { parent: group.id } })) },
      ]);
      return group;
    },

    /** Dissolves groups, as one step: their contents move up to the group's parent. Returns the freed node IDs. */
    ungroup(input: z.input<typeof UngroupSchema>, actor: Actor): string[] {
      const { ids } = parse(UngroupSchema, input, "Nothing was ungrouped.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      const nodes = byId();
      ids.forEach((id, i) => {
        const n = nodes.get(id);
        if (n && !isGroup(n)) errors.push(`ids[${i}]: "${id}" is a box, not a group`);
      });
      failIf(errors, "Nothing was ungrouped.");
      const dissolved = new Set(ids);
      // The nearest ancestor that survives (nested groups can be dissolved together).
      const newParent = (parent: string | undefined): string | undefined => {
        let p = parent;
        while (p !== undefined && dissolved.has(p)) p = nodes.get(p)!.parent;
        return p;
      };
      const freed = scene.nodes.filter((n) => n.parent !== undefined && dissolved.has(n.parent) && !dissolved.has(n.id));
      commit(label("ungroup", listIds(ids), actor), actor, [
        { op: "update", changes: freed.map((n) => ({ id: n.id, patch: { parent: newParent(n.parent) } })) },
        { op: "remove", ids },
      ]);
      return freed.map((n) => n.id);
    },

    /**
     * The outliner's drag and drop, as one step: puts nodes (keeping their list order) inside `parent` (null = the
     * top level), just before its child `before` (null = after its last child). A group can't go inside itself.
     */
    placeNodes(input: z.input<typeof PlaceNodesSchema>, actor: Actor): void {
      const { ids, parent, before } = parse(PlaceNodesSchema, input, "Nothing was moved.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      const target = parent ?? undefined;
      if (target !== undefined) {
        const e = parentError(target);
        if (e) errors.push(`parent: ${e}`);
        else {
          ids.forEach((id, i) => {
            if (subtreeIds(scene.nodes, id).has(target)) errors.push(`ids[${i}]: "${target}" is inside "${id}"`);
          });
        }
      }
      if (before !== null) {
        const b = byId().get(before);
        if (!b) errors.push(`before: no node "${before}"`);
        else if (ids.includes(before)) errors.push(`before: "${before}" is one of the nodes being moved`);
        else if (b.parent !== target) errors.push(`before: "${before}" isn't in ${parent ?? "the top level"}`);
      }
      failIf(errors, "Nothing was moved.");

      const moving = new Set(ids);
      const rest = scene.nodes.filter((n) => !moving.has(n.id));
      const movers = scene.nodes.filter((n) => moving.has(n.id));
      let at = rest.length;
      if (before !== null) at = rest.findIndex((n) => n.id === before);
      else if (target !== undefined) {
        // Right after the last node inside the group (so they come last among its children).
        const inside = subtreeIds(scene.nodes, target);
        at = rest.reduce((last, n, i) => (inside.has(n.id) ? i + 1 : last), 0);
      }
      const order = [...rest.slice(0, at), ...movers, ...rest.slice(at)].map((n) => n.id);

      const reparent = movers.filter((n) => n.parent !== target);
      const ops: Op[] = [];
      if (reparent.length > 0) ops.push({ op: "update", changes: reparent.map((n) => ({ id: n.id, patch: { parent: target } })) });
      if (order.some((id, i) => scene.nodes[i].id !== id)) ops.push({ op: "order", ids: order });
      if (ops.length === 0) return;
      const where = reparent.length > 0 ? `${listIds(ids)} into ${parent ?? "the top level"}` : listIds(ids);
      commit(label(reparent.length > 0 ? "move" : "reorder", where, actor), actor, ops);
    },

    /** What the editor currently shows (last reporting tab wins). Not an edit, so no broadcast. */
    setView(view: View): void {
      const { focus, yaw, bounds } = view;
      scene.view = {
        focus: { x: round2(focus.x), z: round2(focus.z) },
        yaw: round2(yaw),
        bounds: { x: round2(bounds.x), z: round2(bounds.z), width: round2(bounds.width), depth: round2(bounds.depth) },
      };
    },

    /** What the editor has selected (last reporting tab wins). Unknown IDs are dropped. Not an edit, so no broadcast. */
    setSelection(ids: string[]): void {
      const existing = new Set(scene.nodes.map((n) => n.id));
      scene.selection = [...new Set(ids)].filter((id) => existing.has(id));
    },

    /** Removes every node as one undoable step. Clearing an empty scene records nothing. */
    clear(actor: Actor): void {
      if (scene.nodes.length === 0) return;
      commit("Clear", actor, [{ op: "remove", ids: scene.nodes.map((n) => n.id) }]);
    },

    /** Reverts the latest step, whoever made it. Returns it, or null if there was nothing to undo. */
    undo(): HistoryEntry | null {
      const result = history.undo(scene.nodes);
      if (!result) return null;
      scene.nodes = result.nodes;
      step({ type: "undo", entry: result.entry });
      emit();
      return result.entry;
    },

    redo(): HistoryEntry | null {
      const result = history.redo(scene.nodes);
      if (!result) return null;
      scene.nodes = result.nodes;
      step({ type: "redo", entry: result.entry });
      emit();
      return result.entry;
    },

    /** After every commit, undo and redo, before the broadcast. */
    onStep(listener: (step: Step) => void): () => void {
      stepListeners.add(listener);
      return () => stepListeners.delete(listener);
    },

    onChange(listener: (scene: Scene) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Whether following `id`'s parents ever comes back to `id`. */
function isCycle(nodes: SceneNode[], id: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let p = byId.get(id)?.parent;
  while (p !== undefined) {
    if (p === id || seen.has(p)) return true;
    seen.add(p);
    p = byId.get(p)?.parent;
  }
  return false;
}

export type SceneStore = ReturnType<typeof createSceneStore>;

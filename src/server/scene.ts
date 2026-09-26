import type { z } from "zod";
import { boundsOf, normalizeDeg, rotateAround, round2 } from "../shared/geometry";
import {
  BoxInputSchema,
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  DEFAULT_VIEW,
  GroupNodesSchema,
  MIN_HEIGHT,
  MoveNodesSchema,
  NodeUpdateSchema,
  PlaceNodesSchema,
  RotateNodesSchema,
  UngroupSchema,
  type Actor,
  type Box,
  type BoxInput,
  type BoxPatch,
  type Group,
  type HistorySummary,
  type NodePatch,
  type NodeUpdate,
  type Scene,
  type SceneNode,
  type View,
} from "../shared/scene.types";
import { ancestry, boxesUnder, commonParent, isGroup, subtreeIds } from "../shared/tree";
import { applyOp, createHistory, invertOp, runOps, type HistoryEntry, type Op } from "./commands";

export class SceneError extends Error {}

/** Degrees in 0..360, 2 decimals. */
const normalizeRotation = (deg: number) => round2(normalizeDeg(deg)) % 360;

/** "box_3", "box_4, group_1" or "5 nodes". */
const listIds = (ids: string[], plural = "nodes") => (ids.length <= 3 ? ids.join(", ") : `${ids.length} ${plural}`);

/** "Draw box_3", or for the agent "Agent: draw box_4, box_5". Same shape for every label. */
function label(verb: string, what: string, actor: Actor): string {
  const text = `${verb} ${what}`;
  return actor === "agent" ? `Agent: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
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
};

/** One verb when every change is the same kind of edit ("move", "recolor"), "edit" otherwise. */
function updateVerb(patches: NodePatch[]): string {
  const verbs = new Set(patches.flatMap((p) => Object.keys(p).map((k) => FIELD_VERBS[k as keyof NodePatch])));
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
  // Only go up, so IDs are never reused.
  const nextId = { box: 1, group: 1 };

  const history = createHistory();

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
    history.push({ label, actor, at: Date.now(), ops: all, inverse });
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
    if (!isGroup(node)) return `"${parent}" is a box, not a group`;
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

  /** Box patches that change something, as update changes. */
  const effectiveBoxChanges = (boxes: Box[], patches: Record<string, BoxPatch>) =>
    boxes.flatMap((box) => {
      const patch = patches[box.id];
      const changed = patch && (Object.keys(patch) as (keyof BoxPatch)[]).some((k) => patch[k] !== box[k]);
      return changed ? [{ id: box.id, patch }] : [];
    });

  return {
    getScene(): Scene {
      return scene;
    },

    getHistory(): HistorySummary {
      return history.summary();
    },

    /**
     * Validates every input first; applies all or nothing. Missing fields get their defaults: the kind's height,
     * y 0, rotation 0, the default color, no name, the top level.
     */
    drawBoxes(inputs: BoxInput[], actor: Actor): Box[] {
      if (inputs.length === 0) throw new SceneError("boxes: at least one box is required");

      const errors: string[] = [];
      const valid = inputs.map((input, i) => {
        const result = BoxInputSchema.safeParse(input);
        if (!result.success) {
          errors.push(...issueLines(`boxes[${i}]`, result.error.issues));
          return null;
        }
        const d = result.data;
        const height = d.height ?? DEFAULT_HEIGHT[d.kind];
        checkSizes(`boxes[${i}]`, { width: d.width, depth: d.depth, height }, errors);
        if (d.parent !== undefined) {
          const e = parentError(d.parent);
          if (e) errors.push(`boxes[${i}].parent: ${e}`);
        }
        const name = d.name?.trim();
        return {
          type: "box" as const,
          ...(name ? { name } : {}),
          ...(d.parent !== undefined ? { parent: d.parent } : {}),
          kind: d.kind,
          x: round2(d.x),
          z: round2(d.z),
          y: round2(d.y ?? 0),
          width: round2(d.width),
          depth: round2(d.depth),
          height: round2(height),
          rotation: normalizeRotation(d.rotation ?? 0),
          color: d.color ?? DEFAULT_COLOR,
        };
      });
      failIf(errors, "Nothing was drawn.");

      const created: Box[] = valid.map((b) => ({ id: `box_${nextId.box++}`, ...b!, createdBy: actor }));
      const ids = created.map((b) => b.id);
      commit(label("draw", listIds(ids, "boxes"), actor), actor, [{ op: "add", nodes: created }]);
      return created;
    },

    /**
     * Changes existing nodes by ID. A box takes any of name, parent, kind, x, z, y, width, depth, height, rotation,
     * color; a group takes only name and parent. Validates every change first; applies all or nothing. Fields that
     * don't actually change are dropped, and if nothing is left no step is recorded. An empty name removes the name,
     * and a null (or empty) parent moves the node to the top level.
     */
    updateNodes(changes: NodeUpdate[], actor: Actor): SceneNode[] {
      if (changes.length === 0) throw new SceneError("changes: at least one change is required");

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
          const boxOnly = Object.keys(fields).filter((k) => k !== "name" && k !== "parent");
          if (boxOnly.length > 0) errors.push(`changes[${i}]: "${id}" is a group; only name and parent can change (not ${boxOnly.join(", ")})`);
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
        if (fields.name !== undefined) patch.name = fields.name.trim() || undefined;
        if (fields.parent !== undefined) patch.parent = parent;

        // Keep only what differs from the node as it is.
        const effective: NodePatch = {};
        for (const key of Object.keys(patch) as (keyof NodePatch)[]) {
          if (patch[key] !== (node as Record<string, unknown>)[key]) (effective as Record<string, unknown>)[key] = patch[key];
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

    /** Removes nodes by ID as one undoable step; a group takes everything in it. Unknown or repeated IDs reject all. */
    removeNodes(ids: string[], actor: Actor): void {
      if (ids.length === 0) throw new SceneError("ids: at least one ID is required");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was removed.");
      const all = new Set(ids.flatMap((id) => [...subtreeIds(scene.nodes, id)]));
      const remove = scene.nodes.filter((n) => all.has(n.id)).map((n) => n.id);
      commit(label("delete", listIds(ids), actor), actor, [{ op: "remove", ids: remove }]);
    },

    /** Moves boxes and whole groups by a relative offset, as one step. Returns the boxes that moved. */
    moveNodes(input: z.input<typeof MoveNodesSchema>, actor: Actor): Box[] {
      const { ids, dx = 0, dy = 0, dz = 0 } = parse(MoveNodesSchema, input, "Nothing was moved.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was moved.");
      const boxes = boxesUnder(scene.nodes, ids);
      const patches = Object.fromEntries(
        boxes.map((b) => [b.id, { x: round2(b.x + dx), y: round2(b.y + dy), z: round2(b.z + dz) }]),
      );
      const changes = effectiveBoxChanges(boxes, patches);
      if (changes.length > 0) commit(label("move", listIds(ids), actor), actor, [{ op: "update", changes }]);
      const moved = new Set(boxes.map((b) => b.id));
      return scene.nodes.filter((n): n is Box => moved.has(n.id));
    },

    /**
     * Turns boxes and whole groups around the vertical axis through the center of their combined bounds, as one
     * step: each center orbits it and the angle is added to each rotation. Returns the boxes that turned.
     */
    rotateNodes(input: z.input<typeof RotateNodesSchema>, actor: Actor): Box[] {
      const { ids, degrees } = parse(RotateNodesSchema, input, "Nothing was rotated.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was rotated.");
      const boxes = boxesUnder(scene.nodes, ids);
      const b = boundsOf(boxes);
      const patches = rotateAround(boxes, { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }, degrees);
      const changes = effectiveBoxChanges(boxes, patches);
      if (changes.length > 0) commit(label("rotate", listIds(ids), actor), actor, [{ op: "update", changes }]);
      const turned = new Set(boxes.map((b) => b.id));
      return scene.nodes.filter((n): n is Box => turned.has(n.id));
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
      const listed = new Set(ids);
      const members = ids.filter((id) => !ancestry(scene.nodes, id).slice(1).some((a) => listed.has(a)));
      const parent = commonParent(scene.nodes, members);
      const trimmed = name?.trim();
      const group: Group = {
        id: `group_${nextId.group++}`,
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
      emit();
      return result.entry;
    },

    redo(): HistoryEntry | null {
      const result = history.redo(scene.nodes);
      if (!result) return null;
      scene.nodes = result.nodes;
      emit();
      return result.entry;
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

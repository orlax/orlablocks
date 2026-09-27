import type { z } from "zod";
import { boundsOf, mirrorAcross, moveShape, normalizeDeg, rotateAround, round2 } from "../shared/geometry";
import {
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  DEFAULT_VIEW,
  DuplicateNodesSchema,
  GroupNodesSchema,
  MIN_HEIGHT,
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
  type BoxPatch,
  type Group,
  type HistorySummary,
  type NodePatch,
  type NodeUpdate,
  type Scene,
  type SceneNode,
  type ShapeInput,
  type View,
} from "../shared/scene.types";
import type { NextId } from "../shared/project.types";
import { boxesUnder, commonParent, copyNodes, isBox, isGroup, subtreeIds, topmost } from "../shared/tree";
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
  const stepListeners = new Set<(step: Step) => void>();
  // Only go up, so IDs are never reused.
  const nextId = { box: 1, group: 1 };

  let history = createHistory();

  /** The next ID for a new node of `type`. */
  const newId = (type: SceneNode["type"]) => (type === "box" ? `box_${nextId.box++}` : `group_${nextId.group++}`);

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
     * Validates every input first; applies all or nothing. Missing fields get their defaults: the kind's height,
     * y 0, rotation 0, the default color, no name, the top level.
     */
    drawShapes(inputs: ShapeInput[], actor: Actor): Box[] {
      if (inputs.length === 0) throw new SceneError("shapes: at least one shape is required");

      const errors: string[] = [];
      const valid = inputs.map((input, i) => {
        const result = ShapeInputSchema.safeParse(input);
        if (!result.success) {
          errors.push(...issueLines(`shapes[${i}]`, result.error.issues));
          return null;
        }
        const d = result.data;
        const height = d.height ?? DEFAULT_HEIGHT[d.kind];
        checkSizes(`shapes[${i}]`, { width: d.width, depth: d.depth, height }, errors);
        if (d.parent !== undefined) {
          const e = parentError(d.parent);
          if (e) errors.push(`shapes[${i}].parent: ${e}`);
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
      commit(label("draw", listIds(ids, "shapes"), actor), actor, [{ op: "add", nodes: created }]);
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
    moveNodes(input: z.input<typeof MoveNodesSchema>, actor: Actor): Box[] {
      const { ids, dx = 0, dy = 0, dz = 0 } = parse(MoveNodesSchema, input, "Nothing was moved.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was moved.");
      const boxes = boxesUnder(scene.nodes, ids);
      const patches = Object.fromEntries(boxes.map((b) => [b.id, moveShape(b, dx, dy, dz)]));
      const changes = effectiveBoxChanges(boxes, patches);
      if (changes.length > 0) commit(label("move", listIds(ids), actor), actor, [{ op: "update", changes }]);
      const moved = new Set(boxes.map((b) => b.id));
      return scene.nodes.filter((n): n is Box => moved.has(n.id));
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
      const nodes = snapshot.map((n): SceneNode => {
        const { parent: p, ...rest } = n;
        const kept = p !== undefined && groups.has(p) ? { parent: p } : {};
        if (!isBox(n)) return { ...rest, ...kept } as SceneNode;
        const box = { ...(rest as Box), ...kept };
        return { ...box, width: round2(box.width), depth: round2(box.depth), height: round2(box.height), rotation: normalizeRotation(box.rotation) };
      });
      nodes.forEach((n, i) => {
        if (isBox(n)) checkSizes(`nodes[${i}]`, snapshot[i] as Box, errors);
        if (isCycle(nodes, n.id)) errors.push(`nodes[${i}].parent: "${n.id}" ends up inside itself`);
      });
      const boxes = nodes.filter(isBox);
      if (boxes.length === 0) errors.push("nodes: there are no boxes to paste");
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
    mirrorNodes(input: z.input<typeof MirrorNodesSchema>, actor: Actor): Box[] {
      const { ids, axis } = parse(MirrorNodesSchema, input, "Nothing was mirrored.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was mirrored.");
      const boxes = boxesUnder(scene.nodes, ids);
      const changes = effectiveBoxChanges(boxes, mirrorAcross(boxes, axis));
      if (changes.length > 0) commit(label("mirror", `${listIds(ids)} on ${axis.toUpperCase()}`, actor), actor, [{ op: "update", changes }]);
      const mirrored = new Set(boxes.map((b) => b.id));
      return scene.nodes.filter((n): n is Box => mirrored.has(n.id));
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

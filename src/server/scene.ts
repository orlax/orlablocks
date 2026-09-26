import {
  BoxInputSchema,
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  DEFAULT_VIEW,
  MIN_HEIGHT,
  NodeUpdateSchema,
  type Actor,
  type Box,
  type BoxInput,
  type BoxPatch,
  type HistorySummary,
  type NodeUpdate,
  type Scene,
  type View,
} from "../shared/scene.types";
import { createHistory, runOps, type HistoryEntry, type Op } from "./commands";

export class SceneError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Degrees in 0..360, 2 decimals. */
const normalizeRotation = (deg: number) => {
  const r = round2(((deg % 360) + 360) % 360);
  return r === 360 ? 0 : r;
};

/** "box_3", "box_4, box_5" or "5 boxes". */
const listIds = (ids: string[]) => (ids.length <= 3 ? ids.join(", ") : `${ids.length} boxes`);

/** "Draw box_3", or for the agent "Agent: draw box_4, box_5". Same shape for every label. */
function label(verb: string, ids: string[], actor: Actor): string {
  const text = `${verb} ${listIds(ids)}`;
  return actor === "agent" ? `Agent: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

const FIELD_VERBS: Record<keyof BoxPatch, string> = {
  name: "rename",
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
function updateVerb(patches: BoxPatch[]): string {
  const verbs = new Set(patches.flatMap((p) => Object.keys(p).map((k) => FIELD_VERBS[k as keyof BoxPatch])));
  return verbs.size === 1 ? [...verbs][0] : "edit";
}

/** Turns zod issues into "changes[1].height: ..." lines. */
function issueLines(prefix: string, issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => `${prefix}.${issue.path.map(String).join(".") || "(item)"}: ${issue.message}`);
}

export function createSceneStore() {
  const scene: Scene = { view: { ...DEFAULT_VIEW }, selection: [], boxes: [] };
  const listeners = new Set<(scene: Scene) => void>();
  // Only goes up, so IDs are never reused.
  let nextId = 1;

  const history = createHistory();

  /** After every change to the boxes: drop selected IDs that no longer exist, then broadcast. */
  const emit = () => {
    const ids = new Set(scene.boxes.map((b) => b.id));
    scene.selection = scene.selection.filter((id) => ids.has(id));
    listeners.forEach((l) => l(scene));
  };

  /** The single path for edits: apply ops, record one undo step, broadcast. */
  const commit = (label: string, actor: Actor, ops: Op[]) => {
    const { boxes, inverse } = runOps(scene.boxes, ops);
    scene.boxes = boxes;
    history.push({ label, actor, at: Date.now(), ops, inverse });
    emit();
  };

  /** Reports sizes that fall out of range once rounded to 2 decimals. */
  const checkSizes = (prefix: string, r: { width?: number; depth?: number; height?: number }, errors: string[]) => {
    if (r.width !== undefined && round2(r.width) <= 0) errors.push(`${prefix}.width: ${r.width} rounds to 0 at 2 decimals`);
    if (r.depth !== undefined && round2(r.depth) <= 0) errors.push(`${prefix}.depth: ${r.depth} rounds to 0 at 2 decimals`);
    if (r.height !== undefined && round2(r.height) < MIN_HEIGHT) {
      errors.push(`${prefix}.height: ${r.height} rounds below ${MIN_HEIGHT} at 2 decimals`);
    }
  };

  return {
    getScene(): Scene {
      return scene;
    },

    getHistory(): HistorySummary {
      return history.summary();
    },

    /**
     * Validates every input first; applies all or nothing. Missing fields get their defaults: the kind's height,
     * y 0, rotation 0, the default color, no name.
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
        const name = d.name?.trim();
        return {
          type: "box" as const,
          ...(name ? { name } : {}),
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
      if (errors.length > 0) throw new SceneError(`Nothing was drawn.\n${errors.join("\n")}`);

      const created: Box[] = valid.map((b) => ({ id: `box_${nextId++}`, ...b!, createdBy: actor }));
      commit(label("draw", created.map((b) => b.id), actor), actor, [{ op: "add", boxes: created }]);
      return created;
    },

    /**
     * Changes existing boxes by ID: any of name, kind, x, z, y, width, depth, height, rotation, color.
     * Validates every change first; applies all or nothing. Fields that don't actually change are dropped, and if
     * nothing is left no step is recorded. An empty name removes the name.
     */
    updateNodes(changes: NodeUpdate[], actor: Actor): Box[] {
      if (changes.length === 0) throw new SceneError("changes: at least one change is required");

      const byId = new Map(scene.boxes.map((b) => [b.id, b]));
      const seen = new Set<string>();
      const errors: string[] = [];
      const valid = changes.map((change, i) => {
        const result = NodeUpdateSchema.safeParse(change);
        if (!result.success) {
          errors.push(...issueLines(`changes[${i}]`, result.error.issues));
          return null;
        }
        const { id, ...fields } = result.data;
        const box = byId.get(id);
        if (!box) errors.push(`changes[${i}].id: no box "${id}"`);
        if (seen.has(id)) errors.push(`changes[${i}].id: "${id}" appears more than once`);
        seen.add(id);
        if (Object.keys(fields).length === 0) errors.push(`changes[${i}]: nothing to change`);
        checkSizes(`changes[${i}]`, fields, errors);
        if (!box) return null;

        const patch: BoxPatch = {};
        for (const key of ["x", "z", "y", "width", "depth", "height"] as const) {
          if (fields[key] !== undefined) patch[key] = round2(fields[key]);
        }
        if (fields.rotation !== undefined) patch.rotation = normalizeRotation(fields.rotation);
        if (fields.kind !== undefined) patch.kind = fields.kind;
        if (fields.color !== undefined) patch.color = fields.color;
        if (fields.name !== undefined) patch.name = fields.name.trim() || undefined;

        // Keep only what differs from the box as it is.
        const effective: BoxPatch = {};
        for (const key of Object.keys(patch) as (keyof BoxPatch)[]) {
          if (patch[key] !== box[key]) (effective as Record<string, unknown>)[key] = patch[key];
        }
        return { id, patch: effective };
      });
      if (errors.length > 0) throw new SceneError(`Nothing was changed.\n${errors.join("\n")}`);

      const effective = valid.filter((c) => Object.keys(c!.patch).length > 0) as { id: string; patch: BoxPatch }[];
      if (effective.length > 0) {
        const verb = updateVerb(effective.map((c) => c.patch));
        commit(label(verb, effective.map((c) => c.id), actor), actor, [{ op: "update", changes: effective }]);
      }
      const ids = new Set(valid.map((c) => c!.id));
      return scene.boxes.filter((b) => ids.has(b.id));
    },

    /** Removes boxes by ID as one undoable step. An unknown or repeated ID rejects the whole batch. */
    removeNodes(ids: string[], actor: Actor): void {
      if (ids.length === 0) throw new SceneError("ids: at least one ID is required");
      const existing = new Set(scene.boxes.map((b) => b.id));
      const seen = new Set<string>();
      const errors: string[] = [];
      ids.forEach((id, i) => {
        if (!existing.has(id)) errors.push(`ids[${i}]: no box "${id}"`);
        if (seen.has(id)) errors.push(`ids[${i}]: "${id}" appears more than once`);
        seen.add(id);
      });
      if (errors.length > 0) throw new SceneError(`Nothing was removed.\n${errors.join("\n")}`);
      commit(label("delete", ids, actor), actor, [{ op: "remove", ids }]);
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
      const existing = new Set(scene.boxes.map((b) => b.id));
      scene.selection = [...new Set(ids)].filter((id) => existing.has(id));
    },

    /** Removes every box as one undoable step. Clearing an empty scene records nothing. */
    clear(actor: Actor): void {
      if (scene.boxes.length === 0) return;
      commit("Clear", actor, [{ op: "remove", ids: scene.boxes.map((b) => b.id) }]);
    },

    /** Reverts the latest step, whoever made it. Returns it, or null if there was nothing to undo. */
    undo(): HistoryEntry | null {
      const result = history.undo(scene.boxes);
      if (!result) return null;
      scene.boxes = result.boxes;
      emit();
      return result.entry;
    },

    redo(): HistoryEntry | null {
      const result = history.redo(scene.boxes);
      if (!result) return null;
      scene.boxes = result.boxes;
      emit();
      return result.entry;
    },

    onChange(listener: (scene: Scene) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type SceneStore = ReturnType<typeof createSceneStore>;

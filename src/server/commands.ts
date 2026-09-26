import type { Actor, Box, BoxPatch, HistorySummary } from "../shared/scene.types";

/**
 * The command layer: ops, their inverses, and one linear history shared by the human and the agent.
 * Pure (no server dependencies) so it's unit-testable and can grow into the core library.
 */

/** The smallest reversible change to the scene's boxes. */
export type Op =
  | { op: "add"; boxes: Box[]; indices?: number[] } // `indices`: restore removed boxes at their original positions
  | { op: "remove"; ids: string[] }
  | { op: "update"; changes: { id: string; patch: BoxPatch }[] }; // a key set to undefined removes that field (e.g. name)

/** One user-level action and one undo step. */
export type HistoryEntry = {
  label: string;
  actor: Actor;
  at: number;
  ops: Op[];
  inverse: Op[]; // already in undo order
};

export const HISTORY_LIMIT = 200;

/** Returns a new list; never mutates `boxes`. */
export function applyOp(boxes: Box[], op: Op): Box[] {
  switch (op.op) {
    case "add": {
      if (!op.indices) return [...boxes, ...op.boxes];
      // Insert in ascending index order so each box lands exactly where it was.
      const next = [...boxes];
      op.boxes
        .map((box, i) => ({ box, index: op.indices![i] }))
        .sort((a, b) => a.index - b.index)
        .forEach(({ box, index }) => next.splice(index, 0, box));
      return next;
    }
    case "remove": {
      const ids = new Set(op.ids);
      return boxes.filter((b) => !ids.has(b.id));
    }
    case "update": {
      const patches = new Map(op.changes.map((c) => [c.id, c.patch]));
      return boxes.map((b) => (patches.has(b.id) ? withPatch(b, patches.get(b.id)!) : b));
    }
  }
}

/** The op that undoes `op`, computed against the state *before* `op` is applied. */
export function invertOp(boxes: Box[], op: Op): Op {
  switch (op.op) {
    case "add":
      return { op: "remove", ids: op.boxes.map((b) => b.id) };
    case "remove": {
      const ids = new Set(op.ids);
      const removed = boxes.flatMap((box, index) => (ids.has(box.id) ? [{ box, index }] : []));
      if (removed.length !== ids.size) throw new Error(`remove: unknown box in ${op.ids.join(", ")}`);
      return { op: "add", boxes: removed.map((r) => r.box), indices: removed.map((r) => r.index) };
    }
    case "update": {
      const byId = new Map(boxes.map((b) => [b.id, b]));
      return {
        op: "update",
        changes: op.changes.map((c) => {
          const box = byId.get(c.id);
          if (!box) throw new Error(`update: unknown box ${c.id}`);
          // The previous value of every patched field (undefined for a field the box didn't have).
          const previous: Record<string, unknown> = {};
          for (const key of Object.keys(c.patch)) previous[key] = box[key as keyof BoxPatch];
          return { id: c.id, patch: previous as BoxPatch };
        }),
      };
    }
  }
}

/** The box with `patch` applied; optional fields set to undefined are dropped rather than kept as undefined. */
function withPatch(box: Box, patch: BoxPatch): Box {
  const next = { ...box, ...patch };
  for (const key of Object.keys(patch) as (keyof BoxPatch)[]) if (next[key] === undefined) delete next[key];
  return next;
}

/** Applies ops in order and returns the new state plus the inverse, ready to undo. */
export function runOps(boxes: Box[], ops: Op[]): { boxes: Box[]; inverse: Op[] } {
  const inverse: Op[] = [];
  let current = boxes;
  for (const op of ops) {
    inverse.unshift(invertOp(current, op));
    current = applyOp(current, op);
  }
  return { boxes: current, inverse };
}

export function createHistory(limit = HISTORY_LIMIT) {
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];

  return {
    /** Records a new entry. Any new edit clears the redo stack. */
    push(entry: HistoryEntry): void {
      undoStack.push(entry);
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
    },

    /** Reverts the latest entry, whoever made it. */
    undo(boxes: Box[]): { boxes: Box[]; entry: HistoryEntry } | null {
      const entry = undoStack.pop();
      if (!entry) return null;
      redoStack.push(entry);
      return { boxes: entry.inverse.reduce(applyOp, boxes), entry };
    },

    redo(boxes: Box[]): { boxes: Box[]; entry: HistoryEntry } | null {
      const entry = redoStack.pop();
      if (!entry) return null;
      undoStack.push(entry);
      return { boxes: entry.ops.reduce(applyOp, boxes), entry };
    },

    summary(): HistorySummary {
      const u = undoStack.at(-1);
      const r = redoStack.at(-1);
      return { canUndo: !!u, canRedo: !!r, undoLabel: u?.label, redoLabel: r?.label };
    },
  };
}

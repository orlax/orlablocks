import type { Actor, HistorySummary, NodePatch, SceneNode } from "../shared/scene.types";

/**
 * The command layer: ops, their inverses, and one linear history shared by the human and the agent.
 * Pure (no server dependencies) so it's unit-testable and can grow into the core library.
 */

/** The smallest reversible change to the scene's nodes (boxes and groups). */
export type Op =
  | { op: "add"; nodes: SceneNode[]; indices?: number[] } // `indices`: where to insert them (restores removed nodes in place)
  | { op: "remove"; ids: string[] }
  | { op: "update"; changes: { id: string; patch: NodePatch }[] }; // a key set to undefined removes that field (e.g. name)

/** One user-level action and one undo step. */
export type HistoryEntry = {
  label: string;
  actor: Actor;
  at: number;
  ops: Op[];
  inverse: Op[]; // already in undo order
};

export const HISTORY_LIMIT = 200;

/** Returns a new list; never mutates `nodes`. */
export function applyOp(nodes: SceneNode[], op: Op): SceneNode[] {
  switch (op.op) {
    case "add": {
      if (!op.indices) return [...nodes, ...op.nodes];
      // Insert in ascending index order so each node lands exactly where it was.
      const next = [...nodes];
      op.nodes
        .map((node, i) => ({ node, index: op.indices![i] }))
        .sort((a, b) => a.index - b.index)
        .forEach(({ node, index }) => next.splice(index, 0, node));
      return next;
    }
    case "remove": {
      const ids = new Set(op.ids);
      return nodes.filter((n) => !ids.has(n.id));
    }
    case "update": {
      const patches = new Map(op.changes.map((c) => [c.id, c.patch]));
      return nodes.map((n) => (patches.has(n.id) ? withPatch(n, patches.get(n.id)!) : n));
    }
  }
}

/** The op that undoes `op`, computed against the state *before* `op` is applied. */
export function invertOp(nodes: SceneNode[], op: Op): Op {
  switch (op.op) {
    case "add":
      return { op: "remove", ids: op.nodes.map((n) => n.id) };
    case "remove": {
      const ids = new Set(op.ids);
      const removed = nodes.flatMap((node, index) => (ids.has(node.id) ? [{ node, index }] : []));
      if (removed.length !== ids.size) throw new Error(`remove: unknown node in ${op.ids.join(", ")}`);
      return { op: "add", nodes: removed.map((r) => r.node), indices: removed.map((r) => r.index) };
    }
    case "update": {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      return {
        op: "update",
        changes: op.changes.map((c) => {
          const node = byId.get(c.id);
          if (!node) throw new Error(`update: unknown node ${c.id}`);
          // The previous value of every patched field (undefined for a field the node didn't have).
          const previous: Record<string, unknown> = {};
          for (const key of Object.keys(c.patch)) previous[key] = (node as Record<string, unknown>)[key];
          return { id: c.id, patch: previous as NodePatch };
        }),
      };
    }
  }
}

/** The node with `patch` applied; optional fields set to undefined are dropped rather than kept as undefined. */
function withPatch(node: SceneNode, patch: NodePatch): SceneNode {
  const next: Record<string, unknown> = { ...node, ...patch };
  for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key];
  return next as SceneNode;
}

/** Applies ops in order and returns the new state plus the inverse, ready to undo. */
export function runOps(nodes: SceneNode[], ops: Op[]): { nodes: SceneNode[]; inverse: Op[] } {
  const inverse: Op[] = [];
  let current = nodes;
  for (const op of ops) {
    inverse.unshift(invertOp(current, op));
    current = applyOp(current, op);
  }
  return { nodes: current, inverse };
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
    undo(nodes: SceneNode[]): { nodes: SceneNode[]; entry: HistoryEntry } | null {
      const entry = undoStack.pop();
      if (!entry) return null;
      redoStack.push(entry);
      return { nodes: entry.inverse.reduce(applyOp, nodes), entry };
    },

    redo(nodes: SceneNode[]): { nodes: SceneNode[]; entry: HistoryEntry } | null {
      const entry = redoStack.pop();
      if (!entry) return null;
      undoStack.push(entry);
      return { nodes: entry.ops.reduce(applyOp, nodes), entry };
    },

    summary(): HistorySummary {
      const u = undoStack.at(-1);
      const r = redoStack.at(-1);
      return { canUndo: !!u, canRedo: !!r, undoLabel: u?.label, redoLabel: r?.label };
    },
  };
}

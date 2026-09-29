import type { Actor, SceneNode } from "../shared/scene.types";
import { compactNodes, type CompactNode } from "./results";

/**
 * What changed in a document (plan 14 §9, `get_changes`): each step's number, who made it, its label and time, with
 * the nodes as they were after it, kept for the last CHANGE_LOG_STEPS steps (a snapshot is a list of references to
 * immutable nodes, so it costs little). From any kept step to now, the net diff by node: added, removed and changed,
 * field by field.
 */

/** How many steps back a document's changes can be read. */
export const CHANGE_LOG_STEPS = 500;

/** A step in the log. Undo and redo are the human's: only the editor undoes. */
export type LoggedStep = { seq: number; actor: Actor; label: string; at: number; kind: "commit" | "undo" | "redo" };

export function createChangeLog(limit = CHANGE_LOG_STEPS) {
  // The nodes after each step, oldest first; `base` is the document as it was loaded (or as far back as is kept).
  let base: { seq: number; nodes: SceneNode[]; at: number } = { seq: 0, nodes: [], at: Date.now() };
  let steps: (LoggedStep & { nodes: SceneNode[] })[] = [];

  return {
    /** A document opened (or reloaded) at step `seq`, holding `nodes`: nothing before it can be read. */
    reset(seq: number, nodes: SceneNode[]): void {
      base = { seq, nodes, at: Date.now() };
      steps = [];
    },

    /** A step was made; `nodes` is the document after it. */
    record(step: LoggedStep, nodes: SceneNode[]): void {
      steps.push({ ...step, nodes });
      if (steps.length > limit) {
        const dropped = steps.shift()!;
        base = { seq: dropped.seq, nodes: dropped.nodes, at: dropped.at };
      }
    },

    /** The last step by an actor that's still kept, or null. */
    lastBy(actor: Actor): number | null {
      for (let i = steps.length - 1; i >= 0; i--) if (steps[i].actor === actor) return steps[i].seq;
      return null;
    },

    /** The steps after `seq`, and the nodes as they were at `seq` (null if that's further back than is kept). */
    since(seq: number): { steps: LoggedStep[]; before: SceneNode[] | null; from: number } {
      const after = steps.filter((s) => s.seq > seq).map(({ nodes: _nodes, ...s }) => s);
      if (seq < base.seq) return { steps: after, before: null, from: base.seq };
      const at = [...steps].reverse().find((s) => s.seq <= seq);
      return { steps: after, before: at ? at.nodes : base.nodes, from: seq };
    },

    /** When step `seq` was made (the time the document was loaded, for that step or older ones). */
    atOf(seq: number): number {
      return steps.find((s) => s.seq === seq)?.at ?? base.at;
    },

    /** The oldest step that can be read from. */
    oldest: () => base.seq,
  };
}
export type ChangeLog = ReturnType<typeof createChangeLog>;

/** A field's change as the agent reads it: `old → new` for numbers and text, a count for point lists, else "changed". */
function fieldChange(before: unknown, after: unknown): string {
  const show = (v: unknown) => (v === undefined ? "none" : typeof v === "number" || typeof v === "boolean" ? String(v) : typeof v === "string" ? JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v) : null);
  if (Array.isArray(before) && Array.isArray(after) && before.length !== after.length) return `${before.length} → ${after.length} (changed)`;
  if (Array.isArray(before) || Array.isArray(after)) return Array.isArray(after) ? `${after.length} (changed)` : "changed";
  const [a, b] = [show(before), show(after)];
  if (a !== null && b !== null) return `${a} → ${b}`;
  if (before && after && typeof before === "object" && typeof after === "object") {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]),
    );
    return `changed (${keys.join(", ")})`;
  }
  return "changed";
}

export type NodeChange = { id: string; type: SceneNode["type"]; name?: string; fields: Record<string, string> };
export type ChangeDiff = { added: CompactNode[]; removed: { id: string; type: SceneNode["type"]; name?: string }[]; changed: NodeChange[] };

/** The net difference between two versions of a document's nodes, by ID (`createdBy` and derived fields left out). */
export function diffNodes(before: SceneNode[], after: SceneNode[]): ChangeDiff {
  const old = new Map(before.map((n) => [n.id, n]));
  const now = new Map(after.map((n) => [n.id, n]));
  const skip = new Set(["id", "createdBy", "stand"]);
  const added = compactNodes(after, after.filter((n) => !old.has(n.id)).map((n) => n.id));
  const removed = before.filter((n) => !now.has(n.id)).map((n) => ({ id: n.id, type: n.type, ...(n.name !== undefined ? { name: n.name } : {}) }));
  const changed: NodeChange[] = [];
  for (const n of after) {
    const o = old.get(n.id);
    if (!o || o === n) continue;
    const fields: Record<string, string> = {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
      if (skip.has(k)) continue;
      const [a, b] = [(o as Record<string, unknown>)[k], (n as Record<string, unknown>)[k]];
      if (JSON.stringify(a) !== JSON.stringify(b)) fields[k] = fieldChange(a, b);
    }
    if (Object.keys(fields).length > 0) changed.push({ id: n.id, type: n.type, ...(n.name !== undefined ? { name: n.name } : {}), fields });
  }
  return { added, removed, changed };
}

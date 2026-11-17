import type { Scene } from "../shared/scene.types";

/** Snapshots contain only JSON values. Object key order can vary between server edits and undo. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
  }
  const previous = a as Record<string, unknown>;
  const next = b as Record<string, unknown>;
  const keys = Object.keys(previous);
  return keys.length === Object.keys(next).length && keys.every((key) => Object.hasOwn(next, key) && sameValue(previous[key], next[key]));
}

/** Keep unchanged node identities so expansion and mesh caches survive full WebSocket snapshots. */
export function reconcileScene(previous: Scene | null, next: Scene): Scene {
  if (!previous) return next;
  const byId = new Map(previous.nodes.map((node) => [node.id, node]));
  let sameOrder = previous.nodes.length === next.nodes.length;
  const nodes = next.nodes.map((node, i) => {
    const old = byId.get(node.id);
    const current = old && sameValue(old, node) ? old : node;
    if (current !== previous.nodes[i]) sameOrder = false;
    return current;
  });
  return {
    ...next,
    nodes: sameOrder ? previous.nodes : nodes,
    selection: sameValue(previous.selection, next.selection) ? previous.selection : next.selection,
  };
}

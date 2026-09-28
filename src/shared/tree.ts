import { isClosed, moveShape } from "./geometry";
import type { Shape, Group, SceneNode } from "./scene.types";

/**
 * The node tree: a flat list where each node may name its `parent` group. Order in the list is the order among
 * siblings. Pure helpers, shared by the server and the editor.
 */

export const isShape = (n: SceneNode): n is Shape => n.type !== "group";
export const isGroup = (n: SceneNode): n is Group => n.type === "group";
/** A node's tags: groups, closed shapes and ramps have them; lines and notes don't. */
export const tagsOf = (n: SceneNode): string[] | undefined => (n.type === "line" || n.type === "note" ? undefined : n.tags);

/** The nodes directly inside `parent` (undefined = the top level), in list order. */
export const childrenOf = (nodes: SceneNode[], parent: string | undefined) => nodes.filter((n) => n.parent === parent);

/** `id` and every node below it. */
export function subtreeIds(nodes: SceneNode[], id: string): Set<string> {
  const ids = new Set([id]);
  // The list isn't sorted by depth, so sweep until nothing new joins.
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parent !== undefined && ids.has(n.parent) && !ids.has(n.id)) {
        ids.add(n.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** The boxes in or under the given nodes (a box counts itself), in list order, each once. */
export function shapesUnder(nodes: SceneNode[], ids: string[]): Shape[] {
  const all = new Set<string>();
  for (const id of ids) for (const d of subtreeIds(nodes, id)) all.add(d);
  return nodes.filter((n): n is Shape => isShape(n) && all.has(n.id));
}

/** `[id, its parent, its grandparent, ...]` up to the top level. */
export function ancestry(nodes: SceneNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain: string[] = [];
  let current = byId.get(id);
  while (current && !chain.includes(current.id)) {
    chain.push(current.id);
    current = current.parent !== undefined ? byId.get(current.parent) : undefined;
  }
  return chain;
}

/**
 * What a click on node `id` selects, seen from inside group `context` (null = the top level): the node's ancestor
 * that sits directly in `context`, e.g. the outermost group at the top level. Null if `id` isn't inside `context`.
 */
export function selectableAt(nodes: SceneNode[], id: string, context: string | null): string | null {
  const chain = ancestry(nodes, id);
  if (context === null) return chain.at(-1) ?? null;
  const i = chain.indexOf(context);
  return i > 0 ? chain[i - 1] : null;
}

/** The deepest group containing every one of `ids` (undefined = the top level). */
export function commonParent(nodes: SceneNode[], ids: string[]): string | undefined {
  const parents = ids.map((id) => ancestry(nodes, id).slice(1));
  if (parents.some((p) => p.length === 0)) return undefined;
  return parents[0].find((g) => parents.every((p) => p.includes(g)));
}

/** The `ids` that aren't inside another listed node, in the given order: the roots of a group or a copy. */
export function topmost(nodes: SceneNode[], ids: string[]): string[] {
  const listed = new Set(ids);
  return ids.filter((id) => !ancestry(nodes, id).slice(1).some((a) => listed.has(a)));
}

/**
 * Copies of `source` (a set of nodes, each root with its subtree) with fresh IDs from `newId`, in the same order.
 * `parent` references inside the set are remapped to the copies; the others are kept, so a copied root stays in
 * its original's group. Shapes are offset by `dx, dy, dz` (2 decimals). Names and everything else are kept.
 */
export function copyNodes(
  source: SceneNode[],
  newId: (type: SceneNode["type"]) => string,
  { dx = 0, dy = 0, dz = 0 }: { dx?: number; dy?: number; dz?: number } = {},
): SceneNode[] {
  const ids = new Map(source.map((n) => [n.id, newId(n.type)]));
  return source.map((n) => {
    const copy: SceneNode = isShape(n) ? ({ ...n, ...moveShape(n, dx, dy, dz), id: ids.get(n.id)! } as SceneNode) : { ...n, id: ids.get(n.id)! };
    if (n.parent !== undefined && ids.has(n.parent)) copy.parent = ids.get(n.parent);
    return copy;
  });
}

/** The nodes with `flag` set on themselves or on a group they're in. */
function flaggedIds(nodes: SceneNode[], flag: "locked" | "hidden"): Set<string> {
  const set = new Set(nodes.filter((n) => n[flag]).map((n) => n.id));
  if (set.size === 0) return set;
  return new Set(nodes.filter((n) => ancestry(nodes, n.id).some((id) => set.has(id))).map((n) => n.id));
}

/** The nodes that are locked, by their own `locked` or an ancestor's: none of them can be picked in the view. */
export const lockedIds = (nodes: SceneNode[]) => flaggedIds(nodes, "locked");

/** The nodes that are hidden, by their own `hidden` or an ancestor's: none of them are drawn in the view. */
export const hiddenIds = (nodes: SceneNode[]) => flaggedIds(nodes, "hidden");

/**
 * What the nodes hold, as one line: `3 rooms · 2 volumes · 1 hole · 1 ramp · 2 lines · 1 note · 1 group`, leaving
 * out what there's none of ("empty" when there's nothing). Only open notes count (a done one is handled). A ramp counts as a ramp; rooms, volumes and holes are the closed
 * shapes of each kind. The editor's info-label and the agent's outline both use it.
 */
export function countsText(nodes: SceneNode[]): string {
  const counts: [string, number][] = [
    ["room", 0],
    ["volume", 0],
    ["hole", 0],
    ["ramp", 0],
    ["line", 0],
    ["note", 0],
    ["group", 0],
  ];
  const bump = (key: string) => counts.find(([k]) => k === key)![1]++;
  for (const n of nodes) {
    if (isGroup(n)) bump("group");
    else if (n.type === "note") {
      if (n.status === "open") bump("note");
    } else if (isClosed(n)) bump(n.kind);
    else bump(n.type);
  }
  const parts = counts.filter(([, c]) => c > 0).map(([k, c]) => `${c} ${k}${c === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : "empty";
}

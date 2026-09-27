import { round2 } from "./geometry";
import type { Box, Group, SceneNode } from "./scene.types";

/**
 * The node tree: a flat list where each node may name its `parent` group. Order in the list is the order among
 * siblings. Pure helpers, shared by the server and the editor.
 */

export const isBox = (n: SceneNode): n is Box => n.type === "box";
export const isGroup = (n: SceneNode): n is Group => n.type === "group";

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
export function boxesUnder(nodes: SceneNode[], ids: string[]): Box[] {
  const all = new Set<string>();
  for (const id of ids) for (const d of subtreeIds(nodes, id)) all.add(d);
  return nodes.filter((n): n is Box => isBox(n) && all.has(n.id));
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
 * its original's group. Boxes are offset by `dx, dy, dz` (2 decimals). Names and everything else are kept.
 */
export function copyNodes(
  source: SceneNode[],
  newId: (type: SceneNode["type"]) => string,
  { dx = 0, dy = 0, dz = 0 }: { dx?: number; dy?: number; dz?: number } = {},
): SceneNode[] {
  const ids = new Map(source.map((n) => [n.id, newId(n.type)]));
  return source.map((n) => {
    const copy: SceneNode = { ...n, id: ids.get(n.id)! };
    if (n.parent !== undefined && ids.has(n.parent)) copy.parent = ids.get(n.parent);
    if (isBox(copy)) {
      copy.x = round2(copy.x + dx);
      copy.y = round2(copy.y + dy);
      copy.z = round2(copy.z + dz);
    }
    return copy;
  });
}

import { boundsOf, isTilted, round2 } from "../shared/geometry";
import { COMPASS, type OpenScene, type Scene, type SceneNode, type Shape } from "../shared/scene.types";
import { ancestry, childrenOf, countsText, isGroup, isShape, shapesUnder, subtreeIds } from "../shared/tree";
import { SceneError } from "./scene";

/**
 * What the agent reads (plan 08 §4): the scene as an outline, one level of the tree at a time, so a large level
 * costs little to read and the agent zooms in where it needs to; and `find_nodes`, the way to look a node up. Pure,
 * over a scene snapshot.
 */

/** A scene with this many nodes or fewer comes back in full: zooming in would cost more than it saves. */
export const FULL_SCENE_MAX = 40;
/** The most matches `find_nodes` lists. */
export const MAX_MATCHES = 100;

export type SceneQuery = { root?: string; depth?: number; full?: boolean };
export type AgentBounds = { x: number; z: number; y: number; width: number; depth: number; height: number };
/** A node as the agent reads it: stored fields plus what the outline derives. */
export type AgentNode = SceneNode & { bounds?: AgentBounds; contains?: string; collapsed?: true; path?: string };
export type SceneOutline = OpenScene & {
  compass: typeof COMPASS;
  view: Scene["view"];
  selection: string[];
  counts: string;
  root?: AgentNode;
  detail: string;
  hint?: string;
  nodes: AgentNode[];
  selected?: AgentNode[];
};

/** Axis-aligned bounds for the agent: center x/z, bottom y, sizes. */
export function boundsFor(shapes: Shape[]): AgentBounds {
  const b = boundsOf(shapes);
  return {
    x: round2((b.minX + b.maxX) / 2),
    z: round2((b.minZ + b.maxZ) / 2),
    y: round2(b.minY),
    width: round2(b.maxX - b.minX),
    depth: round2(b.maxZ - b.minZ),
    height: round2(b.maxY - b.minY),
  };
}

/** Where a node sits: its groups from the top down, by name (or ID), e.g. `castle › east wing`. Empty at the top level. */
export function pathOf(nodes: SceneNode[], id: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return ancestry(nodes, id)
    .slice(1)
    .reverse()
    .map((g) => byId.get(g)?.name ?? g)
    .join(" › ");
}

/**
 * A node as the agent sees it: a shape in full (a tilted one with its real `bounds`), a group with its derived
 * `bounds` and `contains` (what's under it, as counts).
 */
function describeNode(nodes: SceneNode[], n: SceneNode): AgentNode {
  if (!isGroup(n)) return isTilted(n) ? { ...n, bounds: boundsFor([n]) } : n;
  const inside = subtreeIds(nodes, n.id);
  inside.delete(n.id);
  const shapes = shapesUnder(nodes, [n.id]);
  return {
    ...n,
    ...(shapes.length > 0 ? { bounds: boundsFor(shapes) } : {}),
    contains: countsText(nodes.filter((d) => inside.has(d.id))),
  };
}

/**
 * The scene for the agent. By default an outline: the children of `root` (the top level if none) down to `depth`
 * levels (default 1), where a group whose children aren't listed has `collapsed: true`. `full` (or a scene of
 * FULL_SCENE_MAX nodes or fewer) lists every node under the root instead. The selected nodes are always listed in
 * full, in `selected`, when the outline doesn't already include them.
 */
export function describeScene(open: OpenScene, scene: Scene, query: SceneQuery = {}): SceneOutline {
  const { nodes } = scene;
  const { root, depth = 1, full = false } = query;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rootNode = root !== undefined ? byId.get(root) : undefined;
  if (root !== undefined && !rootNode) throw new SceneError(`root: no node "${root}". Nothing was read.`);

  const header = {
    ...open,
    compass: COMPASS,
    view: scene.view,
    selection: scene.selection,
    counts: countsText(nodes),
  };
  const rootInfo = rootNode ? { root: { ...describeNode(nodes, rootNode), path: pathOf(nodes, rootNode.id) } } : {};

  // A shape as the root: just that shape.
  if (rootNode && !isGroup(rootNode)) return { ...header, ...rootInfo, detail: "one shape", nodes: [] };

  const whole = full || (root === undefined && nodes.length <= FULL_SCENE_MAX);
  const listed: SceneNode[] = [];
  const collapsed = new Set<string>();
  if (whole) {
    const inside = root !== undefined ? subtreeIds(nodes, root) : null;
    if (inside) inside.delete(root!);
    listed.push(...nodes.filter((n) => !inside || inside.has(n.id)));
  } else {
    const walk = (parent: string | undefined, level: number) => {
      for (const n of childrenOf(nodes, parent)) {
        listed.push(n);
        if (!isGroup(n)) continue;
        if (level < depth) walk(n.id, level + 1);
        else if (nodes.some((c) => c.parent === n.id)) collapsed.add(n.id);
      }
    };
    walk(root, 1);
  }

  const shown = new Set(listed.map((n) => n.id));
  const describe = (n: SceneNode): AgentNode => ({ ...describeNode(nodes, n), ...(collapsed.has(n.id) ? { collapsed: true as const } : {}) });
  const selected = scene.selection.filter((id) => !shown.has(id) && byId.has(id)).map((id) => byId.get(id)!);
  return {
    ...header,
    ...rootInfo,
    ...(whole
      ? { detail: "full" }
      : {
          detail: `outline, ${depth} level${depth === 1 ? "" : "s"}`,
          hint: 'A group with collapsed: true has more inside: get_scene { root: "<its id>" } opens it, depth opens more levels, full: true lists everything. find_nodes looks nodes up by name, type or place.',
        }),
    nodes: listed.map(describe),
    ...(selected.length > 0 ? { selected: selected.map((n) => ({ ...describeNode(nodes, n), path: pathOf(nodes, n.id) })) } : {}),
  };
}

export type FindQuery = {
  name?: string;
  type?: SceneNode["type"];
  kind?: "room" | "volume" | "hole";
  under?: string;
  near?: { x: number; z: number; radius: number };
};

/**
 * The nodes that match every filter given, in list order, as one compact line each: `id`, `type`, `kind`, `name`,
 * `path` and `bounds`. `name` is a case-insensitive substring, `under` any depth inside a group, and `near` a node
 * whose bounds come within `radius` of the point (on the ground). At most MAX_MATCHES, with the count of the rest.
 */
export function findNodes(nodes: SceneNode[], query: FindQuery) {
  const { name, type, kind, under, near } = query;
  if (under !== undefined) {
    const group = nodes.find((n) => n.id === under);
    if (!group) throw new SceneError(`under: no node "${under}". Nothing was found.`);
    if (!isGroup(group)) throw new SceneError(`under: "${under}" is a ${group.type}, not a group. Nothing was found.`);
  }
  const inside = under !== undefined ? subtreeIds(nodes, under) : null;
  inside?.delete(under!);
  const needle = name?.trim().toLowerCase();

  const boundsOfNode = (n: SceneNode) => {
    const shapes = isShape(n) ? [n] : shapesUnder(nodes, [n.id]);
    return shapes.length > 0 ? boundsFor(shapes) : undefined;
  };
  const isNear = (b: AgentBounds | undefined) => {
    if (!near || !b) return !near;
    const dx = Math.max(0, Math.abs(near.x - b.x) - b.width / 2);
    const dz = Math.max(0, Math.abs(near.z - b.z) - b.depth / 2);
    return Math.hypot(dx, dz) <= near.radius;
  };

  const matches = nodes.filter((n) => {
    if (inside && !inside.has(n.id)) return false;
    if (type !== undefined && n.type !== type) return false;
    if (kind !== undefined && !(isShape(n) && "kind" in n && n.kind === kind)) return false;
    if (needle && !(n.name ?? "").toLowerCase().includes(needle)) return false;
    return true;
  });
  const found: ReturnType<typeof line>[] = [];
  let more = 0;
  function line(n: SceneNode, bounds: AgentBounds | undefined) {
    return {
      id: n.id,
      type: n.type,
      ...(isShape(n) && "kind" in n ? { kind: n.kind } : {}),
      ...(n.name !== undefined ? { name: n.name } : {}),
      ...(n.parent !== undefined ? { parent: n.parent, path: pathOf(nodes, n.id) } : {}),
      ...(bounds ? { bounds } : {}),
    };
  }
  for (const n of matches) {
    const bounds = boundsOfNode(n);
    if (!isNear(bounds)) continue;
    if (found.length < MAX_MATCHES) found.push(line(n, bounds));
    else more++;
  }
  return { found, ...(more > 0 ? { more: `${more} more not listed: narrow the search` } : {}) };
}


import { boundsOf, isTilted, round2 } from "../shared/geometry";
import { currentTags, EMPTY_LIBRARY, findRefs, resolveRef, type Library, type Skill, type Tag } from "../shared/library";
import { COMPASS, type OpenScene, type Scene, type SceneNode, type Shape } from "../shared/scene.types";
import { ancestry, childrenOf, countsText, isGroup, isShape, shapesUnder, subtreeIds, tagsOf } from "../shared/tree";
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
/** What the outline adds from the project: its library, and a line about the design guide. */
export type SceneContext = { library: Library; guide?: string };
/** The tags and skills a result names, each with its description (a skill with its tags). */
export type Glossary = { skills?: Record<string, { description: string; tags?: string[] }>; tags?: Record<string, string> };
export type AgentBounds = { x: number; z: number; y: number; width: number; depth: number; height: number };
/** A node as the agent reads it: stored fields plus what the outline derives. */
export type AgentNode = SceneNode & { bounds?: AgentBounds; contains?: string; collapsed?: true; path?: string };
export type SceneOutline = OpenScene & {
  compass: typeof COMPASS;
  view: Scene["view"];
  selection: string[];
  counts: string;
  guide?: string;
  root?: AgentNode;
  detail: string;
  hint?: string;
  nodes: AgentNode[];
  selected?: AgentNode[];
  notes?: AgentNode[];
  glossary?: Glossary;
};

/**
 * The glossary for what a result shows: the tags its nodes carry and the tags and skills their descriptions name,
 * plus one level more (a listed skill's tags, and what the listed tags' and skills' descriptions name), so a skill
 * that acts on #light comes with what #light means. Undefined when nothing is named.
 */
export function glossaryFor(library: Library, shown: AgentNode[]): Glossary | undefined {
  const tags = new Map<string, Tag>();
  const skills = new Map<string, Skill>();
  const addText = (text: string | undefined) => {
    for (const r of findRefs(text ?? "")) {
      if (r.kind === "tag") {
        const t = resolveRef(library, "tag", r.name);
        if (t) tags.set(t.name, t);
      } else {
        const k = resolveRef(library, "skill", r.name);
        if (k) skills.set(k.name, k);
      }
    }
  };
  for (const n of shown) {
    for (const t of tagsOf(n) ?? []) {
      const tag = resolveRef(library, "tag", t);
      if (tag) tags.set(tag.name, tag);
    }
    if (n.type === "group") addText(n.description);
    if (n.type === "note") addText(n.text);
  }
  // One level more.
  for (const k of [...skills.values()]) {
    for (const t of currentTags(library, k.tags)) tags.set(t, resolveRef(library, "tag", t)!);
    addText(k.description);
  }
  for (const t of [...tags.values()]) addText(t.description);
  if (tags.size === 0 && skills.size === 0) return undefined;
  const sorted = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    ...(skills.size > 0
      ? {
          skills: Object.fromEntries(
            sorted(skills).map(([name, k]) => {
              const kTags = currentTags(library, k.tags);
              return [name, { description: k.description, ...(kTags.length > 0 ? { tags: kTags } : {}) }];
            }),
          ),
        }
      : {}),
    ...(tags.size > 0 ? { tags: Object.fromEntries(sorted(tags).map(([name, t]) => [name, t.description ?? ""])) } : {}),
  };
}

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
function describeNodeIn(nodes: SceneNode[], n: SceneNode, library: Library): AgentNode {
  // Tags by their current names; ones the library no longer has are left out.
  const stored = tagsOf(n);
  if (stored) {
    const { tags: _stored, ...rest } = n as SceneNode & { tags?: string[] };
    const tags = currentTags(library, stored);
    n = (tags.length > 0 ? { ...rest, tags } : rest) as SceneNode;
  }
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
export function describeScene(open: OpenScene, scene: Scene, query: SceneQuery = {}, context: SceneContext = { library: EMPTY_LIBRARY }): SceneOutline {
  const { nodes } = scene;
  const { library } = context;
  const describeNode = (all: SceneNode[], n: SceneNode) => describeNodeIn(all, n, library);
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
    ...(context.guide ? { guide: context.guide } : {}),
  };
  const rootInfo = rootNode ? { root: { ...describeNode(nodes, rootNode), path: pathOf(nodes, rootNode.id) } } : {};

  // A shape as the root: just that shape.
  if (rootNode && !isGroup(rootNode)) {
    const glossary = glossaryFor(library, [rootInfo.root!]);
    return { ...header, ...rootInfo, detail: "one shape", nodes: [], ...(glossary ? { glossary } : {}) };
  }

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
  const listedNodes = listed.map(describe);
  const selectedNodes = selected.map((n) => ({ ...describeNode(nodes, n), path: pathOf(nodes, n.id) }));
  // Every open note, wherever it is: notes are work items, so the depth never hides them.
  const listedOrSelected = new Set([...shown, ...selected.map((n) => n.id)]);
  const openNotes = nodes.filter((n) => n.type === "note" && n.status === "open" && !listedOrSelected.has(n.id)).map((n) => ({ ...describeNode(nodes, n), path: pathOf(nodes, n.id) }));
  const glossary = glossaryFor(library, [...(rootInfo.root ? [rootInfo.root] : []), ...listedNodes, ...selectedNodes, ...openNotes]);
  return {
    ...header,
    ...rootInfo,
    ...(whole
      ? { detail: "full" }
      : {
          detail: `outline, ${depth} level${depth === 1 ? "" : "s"}`,
          hint: 'A group with collapsed: true has more inside: get_scene { root: "<its id>" } opens it, depth opens more levels, full: true lists everything. find_nodes looks nodes up by name, type or place.',
        }),
    nodes: listedNodes,
    ...(selectedNodes.length > 0 ? { selected: selectedNodes } : {}),
    ...(openNotes.length > 0 ? { notes: openNotes } : {}),
    ...(glossary ? { glossary } : {}),
  };
}

export type FindQuery = {
  name?: string;
  tag?: string;
  status?: "open" | "done";
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
export function findNodes(nodes: SceneNode[], query: FindQuery, library: Library = EMPTY_LIBRARY) {
  const { name, tag, status, type, kind, under, near } = query;
  const wanted = tag !== undefined ? resolveRef(library, "tag", tag) : undefined;
  if (tag !== undefined && !wanted) throw new SceneError(`tag: no tag #${tag.replace(/^#/, "")} in the project library. Nothing was found.`);
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
    if (needle && !(n.name ?? "").toLowerCase().includes(needle) && !(n.type === "note" && n.text.toLowerCase().includes(needle))) return false;
    if (status !== undefined && !(n.type === "note" && n.status === status)) return false;
    if (wanted && !currentTags(library, tagsOf(n)).includes(wanted.name)) return false;
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
      ...(n.type === "note" ? { text: n.text.length > 120 ? `${n.text.slice(0, 120)}…` : n.text, status: n.status, ...(n.label ? { label: n.label } : {}) } : {}),
      ...(currentTags(library, tagsOf(n)).length > 0 ? { tags: currentTags(library, tagsOf(n)) } : {}),
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


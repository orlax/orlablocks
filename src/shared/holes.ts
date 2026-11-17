import { boundsOf, isClosed, isSolid, verticalRange, type Bounds } from "./geometry";
import type { ClosedShape, SceneNode, Solid } from "./scene.types";
import { subtreeIds } from "./tree";

export const isHole = (n: SceneNode): n is ClosedShape => n.type !== "group" && isClosed(n) && n.kind === "hole";

/** Whether a node can be cut: a solid that isn't a hole. */
export const isCutTarget = (n: SceneNode): n is Solid => n.type !== "group" && isSolid(n) && n.kind !== "hole";

const placement = (id: string) => id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : undefined;

/** Source-group holes are terrain-only authoring inputs, never ordinary CSG cutters. */
export const terrainHoleOwner = (nodes: SceneNode[], hole: ClosedShape) =>
  nodes.find((t) => t.type === "terrain" && t.source && subtreeIds(nodes, t.source).has(hole.id));

/** Eligible targets are independent of hierarchy. Terrain source holes retain terrain-only semantics. */
export function holeScope(nodes: SceneNode[], hole: ClosedShape): Solid[] {
  if (terrainHoleOwner(nodes, hole) || !hole.cutTags?.length) return [];
  const tags = new Set(hole.cutTags);
  const own = placement(hole.id);
  return nodes.filter((n): n is Solid => {
    if (!isCutTarget(n)) return false;
    // External placement tags never redefine the entity's own internal boolean relationships.
    const internal = own !== undefined && own === placement(n.id);
    return !!n.cutTags?.some((t) => tags.has(t) && (!internal || t.includes(":")));
  });
}

const overlaps = (a: Bounds, b: Bounds) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY && a.minZ < b.maxZ && b.minZ < a.maxZ;

const shapeBounds = new WeakMap<Solid, Bounds>();

function cachedBounds(shape: Solid): Bounds {
  let bounds = shapeBounds.get(shape);
  if (!bounds) {
    bounds = boundsOf([shape]);
    shapeBounds.set(shape, bounds);
  }
  return bounds;
}

/** Whether a tagged hole cuts a target, given terrain-source eligibility. */
export function cutOverlaps(hole: ClosedShape, target: Solid): boolean {
  const own = placement(hole.id);
  const internal = own !== undefined && own === placement(target.id);
  return overlaps(cachedBounds(hole), cachedBounds(target))
    && !!hole.cutTags?.some((tag) => (!internal || tag.includes(":")) && target.cutTags?.includes(tag));
}

type CutTarget = { id: string; placement: string | undefined; order: number; shape: Solid; bounds?: Bounds };

/**
 * For each shape that a hole cuts, the holes that cut it (in scene order): the holes whose scope has it and whose
 * bounds overlap its bounds.
 */
export function cutters(nodes: SceneNode[]): Map<string, ClosedShape[]> {
  const out = new Map<string, ClosedShape[]>();
  const holes = nodes.filter((n): n is ClosedShape => isHole(n) && !!n.cutTags?.length);
  if (!holes.length) return out;

  const terrainSources = new Set<string>();
  const targetsByTag = new Map<string, CutTarget[]>();
  nodes.forEach((node, order) => {
    if (node.type === "terrain" && node.source) terrainSources.add(node.source);
    if (!isCutTarget(node) || !node.cutTags?.length) return;
    const target = { id: node.id, placement: placement(node.id), order, shape: node };
    for (const tag of new Set(node.cutTags)) {
      const targets = targetsByTag.get(tag) ?? [];
      targets.push(target);
      targetsByTag.set(tag, targets);
    }
  });
  const terrainInputs = new Set<string>();
  for (const source of terrainSources) {
    for (const id of subtreeIds(nodes, source)) terrainInputs.add(id);
  }

  for (const hole of holes) {
    const tags = hole.cutTags;
    if (!tags?.length || terrainInputs.has(hole.id)) continue;
    const own = placement(hole.id);
    const hb = cachedBounds(hole);
    const matches: CutTarget[] = [];
    for (const tag of tags) {
      const internalTag = tag.includes(":");
      for (const target of targetsByTag.get(tag) ?? []) {
        if (own !== undefined && own === target.placement && !internalTag) continue;
        if (overlaps(hb, target.bounds ??= cachedBounds(target.shape))) matches.push(target);
      }
    }
    // Preserve scene order and add each target once even if it shares several tags with this hole.
    const targets = tags.length > 1 ? [...new Set(matches)].sort((a, b) => a.order - b.order) : matches;
    for (const target of targets) {
      const list = out.get(target.id) ?? [];
      list.push(hole);
      out.set(target.id, list);
    }
  }
  return out;
}

/** The floor rule: a hole cuts a room's floor only if it reaches below the room's elevation (a door on the floor doesn't). */
export const cutsFloor = (hole: ClosedShape, room: ClosedShape) => verticalRange(hole)[0] < room.y - 1e-6;

/** Unconfigured holes and tag sets with no eligible targets, excluding terrain inputs. */
export function holeWarnings(nodes: SceneNode[]): string[] {
  return nodes.filter(isHole).flatMap((hole) => {
    if (terrainHoleOwner(nodes, hole)) return [];
    if (!hole.cutTags?.length) return [`${hole.id} has no cut tags: it cuts nothing`];
    if (!holeScope(nodes, hole).length) return [`${hole.id} has no solids with matching cut tags`];
    return [];
  });
}

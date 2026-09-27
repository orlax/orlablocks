import { boundsOf, isClosed, isSolid, verticalRange, type Bounds } from "./geometry";
import type { ClosedShape, SceneNode, Solid } from "./scene.types";
import { isGroup } from "./tree";

/**
 * Holes: closed shapes of kind "hole", which cut themselves out of other solids (closed shapes and ramps) when drawn.
 * Which shapes a hole cuts is decided by the node tree alone, a door belonging to a room and reaching the rooms
 * beside it. For a hole in group G, whose parent is P (the top level when G is top-level), the shapes directly in:
 * - G, its own group;
 * - P, the shapes beside G (a `door` group next to the room's `walls`);
 * - G's sibling groups, the other groups in P;
 * - P's sibling groups, when P is a group (the rooms beside the room, for a doorway through two walls).
 * That's at most two levels up and one across, so nothing walks the whole hierarchy. A hole outside any group cuts
 * nothing. Holes never cut holes, and never cut lines. Ramps are never holes.
 */

export const isHole = (n: SceneNode): n is ClosedShape => n.type !== "group" && isClosed(n) && n.kind === "hole";

/** Whether a node can be cut: a solid that isn't a hole. */
const cuttable = (n: SceneNode): n is Solid => n.type !== "group" && isSolid(n) && n.kind !== "hole";

/** The top level, as a container. */
const TOP = "";

/** The containers (group IDs, or TOP) whose direct shapes a hole may cut, by the rule above. */
function scopeContainers(nodes: SceneNode[], hole: ClosedShape): Set<string> {
  const g = hole.parent;
  if (g === undefined) return new Set();
  const parentOf = (id: string) => nodes.find((n) => n.id === id)?.parent ?? TOP;
  const groupsIn = (container: string) => nodes.filter((n) => isGroup(n) && (n.parent ?? TOP) === container).map((n) => n.id);
  const p = parentOf(g);
  const out = new Set([g, p, ...groupsIn(p)]);
  if (p !== TOP) groupsIn(parentOf(p)).forEach((id) => out.add(id));
  return out;
}

/** The shapes a hole may cut, by the tree (see above), whether or not they overlap it. */
export function holeScope(nodes: SceneNode[], hole: ClosedShape): Solid[] {
  const containers = scopeContainers(nodes, hole);
  return nodes.filter((n): n is Solid => cuttable(n) && containers.has(n.parent ?? TOP));
}

const overlaps = (a: Bounds, b: Bounds) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY && a.minZ < b.maxZ && b.minZ < a.maxZ;

/**
 * For each shape that a hole cuts, the holes that cut it (in scene order): the holes whose scope has it and whose
 * bounds overlap its bounds.
 */
export function cutters(nodes: SceneNode[]): Map<string, ClosedShape[]> {
  const out = new Map<string, ClosedShape[]>();
  for (const hole of nodes.filter(isHole)) {
    const hb = boundsOf([hole]);
    for (const target of holeScope(nodes, hole)) {
      if (!overlaps(hb, boundsOf([target]))) continue;
      const list = out.get(target.id) ?? [];
      list.push(hole);
      out.set(target.id, list);
    }
  }
  return out;
}

/** The floor rule: a hole cuts a room's floor only if it reaches below the room's elevation (a door on the floor doesn't). */
export const cutsFloor = (hole: ClosedShape, room: ClosedShape) => verticalRange(hole)[0] < room.y - 1e-6;

/**
 * What's wrong with the holes, for the agent: a hole outside any group cuts nothing, and a hole with nothing in reach
 * (see above) cuts nothing either.
 */
export function holeWarnings(nodes: SceneNode[]): string[] {
  return nodes.filter(isHole).flatMap((hole) => {
    if (hole.parent === undefined) return [`${hole.id} is a hole outside any group: it cuts nothing (put it in the group of the shapes it should cut)`];
    if (holeScope(nodes, hole).length === 0) {
      return [`${hole.id} is a hole in ${hole.parent}, but there's nothing to cut in its group, beside it or in the groups beside it`];
    }
    return [];
  });
}

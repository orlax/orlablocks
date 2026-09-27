import { boundsOf, isSolid, verticalRange, type Bounds } from "./geometry";
import type { ClosedShape, SceneNode, Solid } from "./scene.types";
import { isGroup } from "./tree";

/**
 * Holes: solids (closed shapes and ramps) of kind "hole", which cut themselves out of other solids when drawn. Which shapes a hole cuts
 * is decided by the node tree alone, one level each way, so nothing walks the whole hierarchy:
 * - the shapes directly in the hole's own group;
 * - the shapes directly in its group's sibling groups (the other groups directly in the same parent, or the other
 *   top-level groups when its group is top-level), so a door in one room's group also opens the next room's wall.
 * A hole outside any group cuts nothing. Holes never cut holes, and never cut lines.
 */

export const isHole = (n: SceneNode): n is Solid => n.type !== "group" && isSolid(n) && n.kind === "hole";

/** Whether a node can be cut: a solid that isn't a hole. */
const cuttable = (n: SceneNode): n is Solid => n.type !== "group" && isSolid(n) && n.kind !== "hole";

/** The shapes a hole may cut, by the tree (see above), whether or not they overlap it. */
export function holeScope(nodes: SceneNode[], hole: Solid): Solid[] {
  const group = hole.parent;
  if (group === undefined) return [];
  const own = nodes.find((n) => n.id === group);
  const siblings = new Set(nodes.filter((n) => isGroup(n) && n.id !== group && n.parent === own?.parent).map((n) => n.id));
  return nodes.filter((n): n is Solid => cuttable(n) && n.parent !== undefined && (n.parent === group || siblings.has(n.parent)));
}

const overlaps = (a: Bounds, b: Bounds) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY && a.minZ < b.maxZ && b.minZ < a.maxZ;

/**
 * For each shape that a hole cuts, the holes that cut it (in scene order): the holes whose scope has it and whose
 * bounds overlap its bounds.
 */
export function cutters(nodes: SceneNode[]): Map<string, Solid[]> {
  const out = new Map<string, Solid[]>();
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
export const cutsFloor = (hole: Solid, room: ClosedShape) => verticalRange(hole)[0] < room.y - 1e-6;

/**
 * What's wrong with the holes, for the agent: a hole outside any group cuts nothing, and a hole whose group and
 * sibling groups have nothing to cut cuts nothing either.
 */
export function holeWarnings(nodes: SceneNode[]): string[] {
  return nodes.filter(isHole).flatMap((hole) => {
    if (hole.parent === undefined) return [`${hole.id} is a hole outside any group: it cuts nothing (put it in the group of the shapes it should cut)`];
    if (holeScope(nodes, hole).length === 0) {
      return [`${hole.id} is a hole in ${hole.parent}, but there's nothing to cut in that group or its sibling groups`];
    }
    return [];
  });
}

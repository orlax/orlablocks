// Frozen legacy targeting rule: migration only. Never used by rendering or normal edits.
import { boundsOf, isClosed, isSolid, verticalRange, type Bounds } from "../geometry";
import type { ClosedShape, SceneNode, Solid } from "../scene.types";
import { subtreeIds } from "../tree";
import { isGroup } from "../tree";

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

/** Source-group holes are terrain-only authoring inputs, never ordinary CSG cutters. */
export const terrainHoleOwner = (nodes: SceneNode[], hole: ClosedShape) =>
  nodes.find((t) => t.type === "terrain" && t.source && subtreeIds(nodes, t.source).has(hole.id));

/** The shapes a hole may cut, by the tree (see above), whether or not they overlap it. */
export function legacyHoleScope(nodes: SceneNode[], hole: ClosedShape): Solid[] {
  if (terrainHoleOwner(nodes, hole)) return [];
  const containers = scopeContainers(nodes, hole);
  return nodes.filter((n): n is Solid => cuttable(n) && containers.has(n.parent ?? TOP));
}


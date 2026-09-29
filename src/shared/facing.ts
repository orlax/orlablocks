import { boundsOf, polyline, rampStations, round2 } from "./geometry";
import { topOf } from "./surfaces";
import type { SceneNode } from "./scene.types";

/**
 * Facing helpers (plan 14 §5): an instance's `rotation` given as where it should face instead of degrees, worked out
 * once when it's drawn or changed (not kept, unlike `on`). An entity faces its local +x, as an array's items do: the
 * rotation that turns local +x toward a point, away from it, or along a line or ramp where it's nearest.
 */

type At = { x: number; z: number };
/** A point on the ground, or a node's or item's ID (its walking surface's middle, else its bounds' center). */
export type FacingTarget = At | string;
export type FacingSpec = number | { toward: FacingTarget } | { away: FacingTarget } | { along: string };

/** The rotation (degrees) that turns local +x toward the ground direction (dx, dz): counterclockwise seen from above. */
export const turnToward = (dx: number, dz: number) => (Math.atan2(-dz, dx) * 180) / Math.PI;

const normalize = (deg: number) => round2(((deg % 360) + 360) % 360);

/** Where a target is on the ground, or null for an ID that names nothing with a place. */
function targetAt(nodes: SceneNode[], target: FacingTarget): At | null {
  if (typeof target !== "string") return target;
  const top = topOf(nodes, target);
  if (top) return top;
  const n = nodes.find((m) => m.id === target);
  if (!n) return null;
  if (n.type === "line") {
    const b = boundsOf([n]);
    return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
  }
  if (n.type === "array") {
    const b = boundsOf([n]);
    return Number.isFinite(b.minX) ? { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 } : null;
  }
  return null;
}

/** The direction of travel of a line's or ramp's path where it passes nearest to `at`, on the ground. */
function tangentNear(node: SceneNode, at: At): At | null {
  const path = node.type === "line" ? polyline(node) : node.type === "ramp" ? rampStations(node) : null;
  if (!path || path.length < 2) return null;
  let best: { d: number; dir: At } | null = null;
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]];
    const dir = { x: b.x - a.x, z: b.z - a.z };
    const len2 = dir.x * dir.x + dir.z * dir.z;
    if (len2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * dir.x + (at.z - a.z) * dir.z) / len2));
    const d = Math.hypot(a.x + dir.x * t - at.x, a.z + dir.z * t - at.z);
    if (!best || d < best.d - 1e-9) best = { d, dir };
  }
  return best?.dir ?? null;
}

/**
 * An instance's rotation from a facing spec, standing at `at`: the number itself, or the turn toward, away from or
 * along what it names. An error says what's wrong (an unknown ID, a target right where it stands).
 */
export function facingRotation(nodes: SceneNode[], at: At, spec: FacingSpec): { rotation: number } | { error: string } {
  if (typeof spec === "number") return { rotation: spec };
  if ("along" in spec) {
    const n = nodes.find((m) => m.id === spec.along);
    if (!n) return { error: `along: no node "${spec.along}"` };
    if (n.type !== "line" && n.type !== "ramp") return { error: `along: "${spec.along}" is a ${n.type}; along takes a line or a ramp` };
    const dir = tangentNear(n, at);
    if (!dir) return { error: `along: "${spec.along}" has no length to follow` };
    return { rotation: normalize(turnToward(dir.x, dir.z)) };
  }
  const away = "away" in spec;
  const target = away ? spec.away : spec.toward;
  const p = targetAt(nodes, target);
  const field = away ? "away" : "toward";
  if (!p) return { error: `${field}: no node or item "${target}" with a place to face` };
  const dx = p.x - at.x;
  const dz = p.z - at.z;
  if (Math.hypot(dx, dz) < 1e-6) return { error: `${field}: the target is right where it stands, so there's no direction to face` };
  return { rotation: normalize(turnToward(away ? -dx : dx, away ? -dz : dz)) };
}

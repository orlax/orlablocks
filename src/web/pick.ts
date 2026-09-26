import { WALL_THICKNESS, type Box } from "../shared/scene.types";
import type { Vec3 } from "./camera";

/**
 * Which box a ray hits first. Boxes are axis-aligned, so this is a slab test per box, no three.js needed.
 * Rooms are hollow: a ray that enters through the open top, inside the walls, hits the floor or an inner
 * wall instead (approximated by where it leaves the room's box), so a volume inside the room wins.
 */
export function pickBox(ray: { origin: Vec3; dir: Vec3 }, boxes: Box[]): string | null {
  let best: { id: string; t: number } | null = null;
  for (const box of boxes) {
    const t = hitDistance(ray, box);
    if (t !== null && (!best || t < best.t)) best = { id: box.id, t };
  }
  return best?.id ?? null;
}

function hitDistance({ origin, dir }: { origin: Vec3; dir: Vec3 }, box: Box): number | null {
  const pad = box.kind === "room" ? WALL_THICKNESS / 2 : 0;
  const min = { x: box.x - pad, y: 0, z: box.z - pad };
  const max = { x: box.x + box.width + pad, y: box.height, z: box.z + box.depth + pad };

  let tEnter = -Infinity;
  let tExit = Infinity;
  let enterAxis: "x" | "y" | "z" = "x";
  for (const axis of ["x", "y", "z"] as const) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    let t1 = (min[axis] - o) / d;
    let t2 = (max[axis] - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tEnter) {
      tEnter = t1;
      enterAxis = axis;
    }
    tExit = Math.min(tExit, t2);
  }
  if (tEnter > tExit || tExit < 0) return null;

  if (box.kind === "room" && enterAxis === "y" && dir.y < 0) {
    const px = origin.x + dir.x * tEnter;
    const pz = origin.z + dir.z * tEnter;
    const inside =
      px > box.x + pad && px < box.x + box.width - pad && pz > box.z + pad && pz < box.z + box.depth - pad;
    if (inside) return tExit;
  }
  return Math.max(tEnter, 0);
}

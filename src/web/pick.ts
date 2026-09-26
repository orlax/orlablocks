import { WALL_THICKNESS, type Box } from "../shared/scene.types";
import type { Vec3 } from "./camera";

type Ray = { origin: Vec3; dir: Vec3 };

/**
 * Which box a ray hits first. A slab test per box in the box's local frame (the ray is rotated into it), no
 * three.js needed. Rooms are hollow: a ray that enters through the open top, inside the walls, hits the floor or
 * an inner wall instead (approximated by where it leaves the room's box), so a volume inside the room wins.
 */
export function pickBox(ray: Ray, boxes: Box[]): string | null {
  return pickHit(ray, boxes)?.id ?? null;
}

/** Like pickBox, plus the world point where the ray hits the box. */
export function pickHit(ray: Ray, boxes: Box[]): { id: string; point: Vec3 } | null {
  let best: { id: string; t: number } | null = null;
  for (const box of boxes) {
    const t = hitDistance(toLocal(ray, box), box);
    if (t !== null && (!best || t < best.t)) best = { id: box.id, t };
  }
  if (!best) return null;
  const { origin: o, dir: d } = ray;
  return { id: best.id, point: { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t } };
}

/**
 * The ray in the box's frame: origin at the footprint center (y stays world y), axes along width and depth.
 * A rigid transform, so distances along the ray are unchanged.
 */
function toLocal({ origin, dir }: Ray, box: Box): Ray {
  const a = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // Inverse of a counterclockwise (seen from above) turn about +y.
  const rot = (x: number, z: number) => ({ x: x * cos - z * sin, z: x * sin + z * cos });
  const o = rot(origin.x - box.x, origin.z - box.z);
  const d = rot(dir.x, dir.z);
  return { origin: { x: o.x, y: origin.y, z: o.z }, dir: { x: d.x, y: dir.y, z: d.z } };
}

function hitDistance({ origin, dir }: Ray, box: Box): number | null {
  const pad = box.kind === "room" ? WALL_THICKNESS / 2 : 0;
  const hw = box.width / 2;
  const hd = box.depth / 2;
  const min = { x: -hw - pad, y: box.y, z: -hd - pad };
  const max = { x: hw + pad, y: box.y + box.height, z: hd + pad };

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
    const inside = Math.abs(px) < hw - pad && Math.abs(pz) < hd - pad;
    if (inside) return tExit;
  }
  return Math.max(tEnter, 0);
}

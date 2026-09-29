import type { Shape } from "./scene.types";
import { isClosed, isSolid, isTilted, pointInPolygon, pointInRings, roomWalls, shapeFrame, toShapeLocal, volumeRings } from "./geometry";
import { hitMesh, type BoundedMesh } from "./mesh";

/**
 * Rays against the shapes (moved from the editor's pick.ts in plan 13 §7, so the server can cast them too): which
 * shape a ray hits first, where, and the flat surface under a ray. Pure, over shapes in world space.
 */

export type Vec3 = { x: number; y: number; z: number };
export type Ray = { origin: Vec3; dir: Vec3 };

/**
 * Which shape a ray hits first: the nearest hit on any closed shape's mesh (`hitMesh`). A room has no ceiling, so a
 * ray that enters through its open top goes on to the floor, an inner wall, or a volume inside the room.
 */
export function pickShape(ray: Ray, boxes: Shape[]): string | null {
  return pickHit(ray, boxes)?.id ?? null;
}

/** Like pickShape, plus the world point where the ray hits the shape. Lines aren't hit by rays (see `pickLine`). */
export function pickHit(ray: Ray, boxes: Shape[]): { id: string; point: Vec3 } | null {
  let best: { id: string; t: number } | null = null;
  for (const box of boxes) {
    if (!isSolid(box)) continue;
    const mesh = hitMesh(box);
    const t = mesh && rayMesh(ray, mesh);
    if (t !== null && (!best || t < best.t)) best = { id: box.id, t };
  }
  if (!best) return null;
  const { origin: o, dir: d } = ray;
  return { id: best.id, point: { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t } };
}

/** Whether the ray passes through the axis-aligned box (the slab test). */
function rayHitsBounds({ origin: o, dir: d }: Ray, min: number[], max: number[]): boolean {
  let t0 = 0;
  let t1 = Infinity;
  const os = [o.x, o.y, o.z];
  const ds = [d.x, d.y, d.z];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ds[k]) < 1e-12) {
      if (os[k] < min[k] || os[k] > max[k]) return false;
      continue;
    }
    const a = (min[k] - os[k]) / ds[k];
    const b = (max[k] - os[k]) / ds[k];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * How far along the ray (t ≥ 0, in units of `dir`) it first hits a triangle of the mesh, from either side, or
 * null. Möller–Trumbore, after a bounds check.
 */
export function rayMesh(ray: Ray, mesh: BoundedMesh): number | null {
  if (!rayHitsBounds(ray, mesh.min, mesh.max)) return null;
  const { origin: o, dir: d } = ray;
  const p = mesh.positions;
  let best: number | null = null;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3;
    const b = mesh.indices[i + 1] * 3;
    const c = mesh.indices[i + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    // h = d × e2, det = e1 · h
    const hx = d.y * e2z - d.z * e2y, hy = d.z * e2x - d.x * e2z, hz = d.x * e2y - d.y * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = o.x - p[a], sy = o.y - p[a + 1], sz = o.z - p[a + 2];
    const u = (sx * hx + sy * hy + sz * hz) * inv;
    if (u < 0 || u > 1) continue;
    // q = s × e1
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t >= 0 && (best === null || t < best)) best = t;
  }
  return best;
}

/** A flat surface a new shape can stand on: a volume's top, a room's floor or the top of its walls. */
export type Surface = { id: string; y: number; what: "top" | "floor" | "wall top" };

/**
 * The flat, upward-facing surface under the ray, where the drawing tools start a shape: the nearest volume top,
 * room floor or wall top the ray crosses, or null for the ground. Only level faces count: a tilted shape, a taper's
 * or bevel's slope, a ramp and the shapes' sides are passed through to whatever flat surface lies behind them. Holes
 * and lines are never stood on.
 */
export function surfaceUnder(ray: Ray, shapes: Shape[]): Surface | null {
  const { origin: o, dir: d } = ray;
  if (d.y >= 0) return null;
  let best: (Surface & { t: number }) | null = null;
  const consider = (id: string, y: number, what: Surface["what"], inside: (p: { x: number; z: number }) => boolean, frame: { x: number; z: number; rotation: number }) => {
    const t = (y - o.y) / d.y;
    if (t < 0 || (best && t >= best.t)) return;
    const p = toShapeLocal(frame, { x: o.x + d.x * t, z: o.z + d.z * t });
    if (inside(p)) best = { id, y, what, t };
  };
  for (const s of shapes) {
    if (!isClosed(s) || s.kind === "hole" || isTilted(s)) continue;
    const frame = shapeFrame(s);
    if (s.kind === "room") {
      const { inner, walls } = roomWalls(s);
      consider(s.id, s.y, "floor", (p) => pointInRings(inner, p), frame);
      consider(s.id, s.y + s.height, "wall top", (p) => pointInRings(walls, p), frame);
    } else {
      // The flat part of the top: the last ring (smaller with a taper, inset by a bevel; none once it's a point).
      const top = volumeRings(s).at(-1)!.ring;
      consider(s.id, s.y + s.height, "top", (p) => pointInPolygon(top, p), frame);
    }
  }
  // (`best` is only assigned in the closure, so TypeScript can't see it change.)
  const found = best as (Surface & { t: number }) | null;
  return found && { id: found.id, y: found.y, what: found.what };
}


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

/**
 * Like pickShape, plus the world point where the ray hits the shape and the face's unit normal there, turned to
 * face the ray (14.1: the 3D cursor lies on it). Lines aren't hit by rays (see `pickLine`).
 */
export function pickHit(ray: Ray, boxes: Shape[]): { id: string; point: Vec3; normal: Vec3 } | null {
  let best: { id: string; t: number; normal: Vec3 } | null = null;
  for (const box of boxes) {
    if (!isSolid(box)) continue;
    const mesh = hitMesh(box);
    const hit = mesh && rayMeshFirst(ray, mesh);
    if (hit && (!best || hit.t < best.t)) best = { id: box.id, ...hit };
  }
  if (!best) return null;
  const { origin: o, dir: d } = ray;
  return { id: best.id, point: { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t }, normal: best.normal };
}

/** The first place the ray crosses the mesh, with that triangle's unit normal turned toward the ray's origin. */
export function rayMeshFirst(ray: Ray, mesh: BoundedMesh): { t: number; normal: Vec3 } | null {
  let best: { t: number; tri: number } | null = null;
  rayMeshEach(ray, mesh, (t, tri) => {
    if (!best || t < best.t) best = { t, tri };
  });
  if (!best) return null;
  const { t, tri } = best as { t: number; tri: number };
  const p = mesh.positions;
  const a = mesh.indices[tri] * 3, b = mesh.indices[tri + 1] * 3, c = mesh.indices[tri + 2] * 3;
  const e1 = { x: p[b] - p[a], y: p[b + 1] - p[a + 1], z: p[b + 2] - p[a + 2] };
  const e2 = { x: p[c] - p[a], y: p[c + 1] - p[a + 1], z: p[c + 2] - p[a + 2] };
  let n = { x: e1.y * e2.z - e1.z * e2.y, y: e1.z * e2.x - e1.x * e2.z, z: e1.x * e2.y - e1.y * e2.x };
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const facing = n.x * ray.dir.x + n.y * ray.dir.y + n.z * ray.dir.z > 0 ? -1 : 1;
  n = { x: (n.x / len) * facing, y: (n.y / len) * facing, z: (n.z / len) * facing };
  return { t, normal: n };
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
  const hits = rayMeshAll(ray, mesh);
  return hits.length > 0 ? Math.min(...hits) : null;
}

/**
 * Every place along the ray (t ≥ 0) it crosses a triangle of the mesh, from either side, unsorted (13.5: a sight
 * line through a door still meets the room's far wall). Möller–Trumbore, after a bounds check.
 */
export function rayMeshAll(ray: Ray, mesh: BoundedMesh): number[] {
  const hits: number[] = [];
  rayMeshEach(ray, mesh, (t) => hits.push(t));
  return hits;
}

/** Calls `hit` with each t ≥ 0 where the ray crosses a triangle, and that triangle's first index. */
function rayMeshEach(ray: Ray, mesh: BoundedMesh, hit: (t: number, tri: number) => void): void {
  if (!rayHitsBounds(ray, mesh.min, mesh.max)) return;
  const { origin: o, dir: d } = ray;
  const p = mesh.positions;
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
    if (t >= 0) hit(t, i);
  }
}

/** A flat surface a new shape can stand on: a volume's top, a room's floor or the top of its walls. */
export type Surface = { id: string; y: number; what: "top" | "floor" | "wall top" | "slope" };

/** The steepest slope a new shape stands on (14.1), from level. */
const MAX_SLOPE_DEG = 60;

/**
 * The flat, upward-facing surface under the ray, where the drawing tools start a shape: the nearest volume top,
 * room floor or wall top the ray crosses, or null for the ground. Only level faces count: a tilted shape, a taper's
 * or bevel's slope, a ramp and the shapes' sides are passed through to whatever flat surface lies behind them. Holes
 * and lines are never stood on.
 *
 * With `slopes` (14.1, the drawing tools), a tapered or beveled volume's slope counts too, where it's no steeper than
 * 60°: the hit point on its mesh (`"slope"`), so a shape can be drawn on a rounded or pointed top.
 */
export function surfaceUnder(ray: Ray, shapes: Shape[], opts: { slopes?: boolean } = {}): Surface | null {
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
      if (opts.slopes && (s.taper || s.bevel)) {
        const mesh = hitMesh(s);
        const hit = mesh && rayMeshFirst(ray, mesh);
        const b = best as (Surface & { t: number }) | null;
        if (hit && hit.normal.y >= Math.cos((MAX_SLOPE_DEG * Math.PI) / 180) && (!b || hit.t < b.t - 1e-6)) {
          best = { id: s.id, y: Math.round((o.y + d.y * hit.t) * 100) / 100, what: "slope", t: hit.t };
        }
      }
    }
  }
  // (`best` is only assigned in the closure, so TypeScript can't see it change.)
  const found = best as (Surface & { t: number }) | null;
  return found && { id: found.id, y: found.y, what: found.what };
}


import type { Line, Shape } from "../shared/scene.types";
import {
  isClosed,
  isSolid,
  isTilted,
  pointInPolygon,
  pointInRings,
  polyline,
  roomWalls,
  shapeFrame,
  toShapeLocal,
  volumeRings,
} from "../shared/geometry";
import { hitMesh, type BoundedMesh } from "../shared/mesh";
import { worldToScreen, type CameraState, type Size, type Vec3 } from "./camera";

type Ray = { origin: Vec3; dir: Vec3 };

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

/** How close (px) to a line's path on screen a click picks it: more for a thick line. */
export const lineHitPx = (line: Line) => Math.max(6, line.thickness / 2 + 4);

/**
 * The line nearest the cursor on screen, within its hit distance, and the point on it nearest the cursor (in 3D,
 * interpolated along the segment). Lines are drawn over the shapes, so the view checks them first.
 */
export function pickLine(cam: CameraState, size: Size, sx: number, sy: number, shapes: Shape[]): { id: string; point: Vec3 } | null {
  let best: { id: string; point: Vec3; d: number } | null = null;
  for (const line of shapes) {
    if (line.type !== "line") continue;
    const path = polyline(line);
    const screen = path.map((p) => worldToScreen(cam, size, p));
    for (let i = 0; i + 1 < path.length; i++) {
      const a = screen[i];
      const b = screen[i + 1];
      if (!a || !b) continue;
      const dx = b.sx - a.sx;
      const dy = b.sy - a.sy;
      const len2 = dx * dx + dy * dy;
      const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((sx - a.sx) * dx + (sy - a.sy) * dy) / len2));
      const d = Math.hypot(sx - (a.sx + dx * u), sy - (a.sy + dy * u));
      if (d <= lineHitPx(line) && (!best || d < best.d)) {
        const [p, q] = [path[i], path[i + 1]];
        best = { id: line.id, point: { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, z: p.z + (q.z - p.z) * u }, d };
      }
    }
  }
  return best && { id: best.id, point: best.point };
}

/**
 * A note's pin on screen (from 08): a pole standing on its point, with a flag (or, without a label, a round head)
 * at the top, at a constant size in pixels whatever the zoom. `noteRect` is the area a click picks it in.
 */
export const NOTE_PX = { pole: 30, flagW: 34, flagH: 20, head: 11 } as const;
export function noteRect(anchor: { sx: number; sy: number }, labeled: boolean): { x0: number; y0: number; x1: number; y1: number } {
  const top = anchor.sy - NOTE_PX.pole - (labeled ? NOTE_PX.flagH / 2 : NOTE_PX.head / 2);
  const right = anchor.sx + (labeled ? NOTE_PX.flagW : NOTE_PX.head / 2);
  return { x0: anchor.sx - NOTE_PX.head / 2 - 2, y0: top - 2, x1: right + 2, y1: anchor.sy + 3 };
}

/**
 * The note whose pin is under the cursor (the nearest one, when pins overlap), with its point. Pins are drawn over
 * everything, so the view checks them first.
 */
export function pickNote(cam: CameraState, size: Size, sx: number, sy: number, shapes: Shape[]): { id: string; point: Vec3 } | null {
  let best: { id: string; point: Vec3; d: number } | null = null;
  for (const note of shapes) {
    if (note.type !== "note") continue;
    const at = worldToScreen(cam, size, note);
    if (!at) continue;
    const r = noteRect(at, !!note.label);
    if (sx < r.x0 || sx > r.x1 || sy < r.y0 || sy > r.y1) continue;
    const d = Math.hypot(sx - at.sx, sy - (at.sy - NOTE_PX.pole));
    if (!best || d < best.d) best = { id: note.id, point: { x: note.x, y: note.y, z: note.z }, d };
  }
  return best && { id: best.id, point: best.point };
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


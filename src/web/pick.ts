import { WALL_THICKNESS, type ClosedShape, type Line, type Shape } from "../shared/scene.types";
import { footprint, isClosed, pointInRings, polyline, ringsInWorld, roomWalls, type Point } from "../shared/geometry";
import { worldToScreen, type CameraState, type Size, type Vec3 } from "./camera";

type Ray = { origin: Vec3; dir: Vec3 };

/**
 * Which shape a ray hits first. Every closed shape is a vertical prism over its footprint polygon, so the test is
 * the ray against the prism's top, bottom and side faces, no three.js needed. Rooms are hollow: a ray that enters
 * through the open top, inside the walls, hits the floor or an inner wall instead, so a volume inside the room wins.
 */
export function pickShape(ray: Ray, boxes: Shape[]): string | null {
  return pickHit(ray, boxes)?.id ?? null;
}

/** Like pickShape, plus the world point where the ray hits the shape. Lines aren't hit by rays (see `pickLine`). */
export function pickHit(ray: Ray, boxes: Shape[]): { id: string; point: Vec3 } | null {
  let best: { id: string; t: number } | null = null;
  for (const box of boxes) {
    if (!isClosed(box)) continue;
    const t = hitDistance(ray, box);
    if (t !== null && (!best || t < best.t)) best = { id: box.id, t };
  }
  if (!best) return null;
  const { origin: o, dir: d } = ray;
  return { id: best.id, point: { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t } };
}

type Crossing = { t: number; face: "top" | "bottom" | "side" };

/**
 * Every place (t ≥ 0 along the ray) where the ray crosses the surface of the prism from y0 to y1 over a region on
 * the ground (rings, read even-odd, so holes count), nearest first.
 */
export function prismCrossings({ origin: o, dir: d }: Ray, rings: Point[][], y0: number, y1: number): Crossing[] {
  const out: Crossing[] = [];
  if (Math.abs(d.y) > 1e-12) {
    for (const [y, face] of [[y1, "top"], [y0, "bottom"]] as const) {
      const t = (y - o.y) / d.y;
      if (t >= 0 && pointInRings(rings, { x: o.x + d.x * t, z: o.z + d.z * t })) out.push({ t, face });
    }
  }
  for (const poly of rings) for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    // o + t·d = a + s·(b − a) on the ground, with 0 ≤ s ≤ 1 and the height at t within the prism.
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const denom = d.x * ez - d.z * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const wx = a.x - o.x;
    const wz = a.z - o.z;
    const t = (wx * ez - wz * ex) / denom;
    const s = (wx * d.z - wz * d.x) / denom;
    const y = o.y + d.y * t;
    if (t >= 0 && s >= 0 && s <= 1 && y >= y0 && y <= y1) out.push({ t, face: "side" });
  }
  return out.sort((p, q) => p.t - q.t);
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

function hitDistance(ray: Ray, shape: ClosedShape): number | null {
  const { origin: o } = ray;
  const y0 = shape.y;
  const y1 = shape.y + shape.height;
  const room = shape.kind === "room" ? roomWalls(shape, WALL_THICKNESS / 2) : null;
  const outer = room ? ringsInWorld(shape, room.outer) : [footprint(shape)];
  if (o.y >= y0 && o.y <= y1 && pointInRings(outer, o)) return 0;

  const first = prismCrossings(ray, outer, y0, y1)[0];
  if (!first) return null;
  // Rooms too narrow to have an inside are solid.
  if (!room || room.inner.length === 0 || first.face !== "top") return first.t;
  const inner = ringsInWorld(shape, room.inner);
  const { dir: d } = ray;
  if (!pointInRings(inner, { x: o.x + d.x * first.t, z: o.z + d.z * first.t })) return first.t;
  // In through the open top: where the ray next meets the room's inside, an inner wall or the floor.
  const next = prismCrossings(ray, inner, y0, y1).find((c) => c.t > first.t + 1e-9);
  return next?.t ?? first.t;
}

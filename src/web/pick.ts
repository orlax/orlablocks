import { WALL_THICKNESS, type Box } from "../shared/scene.types";
import { footprint, offsetPolygon, pointInPolygon, type Point } from "../shared/geometry";
import type { Vec3 } from "./camera";

type Ray = { origin: Vec3; dir: Vec3 };

/**
 * Which shape a ray hits first. Every closed shape is a vertical prism over its footprint polygon, so the test is
 * the ray against the prism's top, bottom and side faces, no three.js needed. Rooms are hollow: a ray that enters
 * through the open top, inside the walls, hits the floor or an inner wall instead, so a volume inside the room wins.
 */
export function pickBox(ray: Ray, boxes: Box[]): string | null {
  return pickHit(ray, boxes)?.id ?? null;
}

/** Like pickBox, plus the world point where the ray hits the shape. */
export function pickHit(ray: Ray, boxes: Box[]): { id: string; point: Vec3 } | null {
  let best: { id: string; t: number } | null = null;
  for (const box of boxes) {
    const t = hitDistance(ray, box);
    if (t !== null && (!best || t < best.t)) best = { id: box.id, t };
  }
  if (!best) return null;
  const { origin: o, dir: d } = ray;
  return { id: best.id, point: { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t } };
}

type Crossing = { t: number; face: "top" | "bottom" | "side" };

/** Every place (t ≥ 0 along the ray) where the ray crosses the surface of the prism over `poly` from y0 to y1, nearest first. */
export function prismCrossings({ origin: o, dir: d }: Ray, poly: Point[], y0: number, y1: number): Crossing[] {
  const out: Crossing[] = [];
  if (Math.abs(d.y) > 1e-12) {
    for (const [y, face] of [[y1, "top"], [y0, "bottom"]] as const) {
      const t = (y - o.y) / d.y;
      if (t >= 0 && pointInPolygon(poly, { x: o.x + d.x * t, z: o.z + d.z * t })) out.push({ t, face });
    }
  }
  for (let i = 0; i < poly.length; i++) {
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

function hitDistance(ray: Ray, box: Box): number | null {
  const { origin: o } = ray;
  const y0 = box.y;
  const y1 = box.y + box.height;
  const centerline = footprint(box);
  const room = box.kind === "room";
  const outer = room ? offsetPolygon(centerline, WALL_THICKNESS / 2)! : centerline;
  if (o.y >= y0 && o.y <= y1 && pointInPolygon(outer, o)) return 0;

  const first = prismCrossings(ray, outer, y0, y1)[0];
  if (!first) return null;
  // Rooms too narrow to have an inside are solid.
  const inner = room ? offsetPolygon(centerline, -WALL_THICKNESS / 2) : null;
  if (!inner || first.face !== "top") return first.t;
  const { dir: d } = ray;
  if (!pointInPolygon(inner, { x: o.x + d.x * first.t, z: o.z + d.z * first.t })) return first.t;
  // In through the open top: where the ray next meets the room's inside, an inner wall or the floor.
  const next = prismCrossings(ray, inner, y0, y1).find((c) => c.t > first.t + 1e-9);
  return next?.t ?? first.t;
}

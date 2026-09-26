import { WALL_THICKNESS, type Box } from "../shared/scene.types";
import { worldToScreen, type CameraState, type Size } from "./camera";
import { fromBoxLocal } from "../shared/geometry";

/**
 * The marquee: which boxes a screen rectangle touches. Exact for our boxes: a box is convex, so its outline on
 * screen is the convex hull of its 8 projected corners, and a separating-axis test says whether it overlaps.
 */

export type ScreenPoint = { sx: number; sy: number };
export type ScreenRect = { x0: number; y0: number; x1: number; y1: number };

/** The rect spanning two screen points, in any drag direction. */
export const rectFrom = (a: ScreenPoint, b: ScreenPoint): ScreenRect => ({
  x0: Math.min(a.sx, b.sx),
  y0: Math.min(a.sy, b.sy),
  x1: Math.max(a.sx, b.sx),
  y1: Math.max(a.sy, b.sy),
});

/** The box's outline on screen (room walls included), counterclockwise, or null if any corner is behind the camera. */
export function boxOutline(cam: CameraState, size: Size, box: Box): ScreenPoint[] | null {
  const pad = box.kind === "room" ? WALL_THICKNESS / 2 : 0;
  const hw = box.width / 2 + pad;
  const hd = box.depth / 2 + pad;
  const points: ScreenPoint[] = [];
  for (const [lx, lz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
    const g = fromBoxLocal(box, { x: lx, z: lz });
    for (const y of [box.y, box.y + box.height]) {
      const p = worldToScreen(cam, size, { x: g.x, y, z: g.z });
      if (!p) return null;
      points.push(p);
    }
  }
  return convexHull(points);
}

/** Andrew's monotone chain. */
export function convexHull(points: ScreenPoint[]): ScreenPoint[] {
  const pts = [...points].sort((a, b) => a.sx - b.sx || a.sy - b.sy);
  if (pts.length <= 2) return pts;
  const cross = (o: ScreenPoint, a: ScreenPoint, b: ScreenPoint) =>
    (a.sx - o.sx) * (b.sy - o.sy) - (a.sy - o.sy) * (b.sx - o.sx);
  const lower: ScreenPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: ScreenPoint[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Separating-axis test between a convex polygon and an axis-aligned rect. */
export function polygonOverlapsRect(poly: ScreenPoint[], rect: ScreenRect): boolean {
  if (poly.length === 0) return false;
  const corners: ScreenPoint[] = [
    { sx: rect.x0, sy: rect.y0 },
    { sx: rect.x1, sy: rect.y0 },
    { sx: rect.x1, sy: rect.y1 },
    { sx: rect.x0, sy: rect.y1 },
  ];
  const axes = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    ...poly.map((p, i) => {
      const q = poly[(i + 1) % poly.length];
      return { x: q.sy - p.sy, y: p.sx - q.sx }; // the edge's normal
    }),
  ];
  const project = (pts: ScreenPoint[], axis: { x: number; y: number }) => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      const v = p.sx * axis.x + p.sy * axis.y;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return { min, max };
  };
  return axes.every((axis) => {
    const a = project(poly, axis);
    const b = project(corners, axis);
    return a.max >= b.min && b.max >= a.min;
  });
}

/** The IDs of the boxes the rect touches on screen, in scene order. */
export function marqueeHits(cam: CameraState, size: Size, boxes: Box[], rect: ScreenRect): string[] {
  return boxes.filter((b) => {
    const outline = boxOutline(cam, size, b);
    return outline !== null && polygonOverlapsRect(outline, rect);
  }).map((b) => b.id);
}

import { WALL_THICKNESS, type ClosedShape, type Shape } from "../shared/scene.types";
import { worldToScreen, type CameraState, type Size } from "./camera";
import { footprint, isClosed, polyline, ringsInWorld, roomWalls } from "../shared/geometry";

/**
 * The marquee: which shapes a screen rectangle touches. Exact: a shape is a vertical prism over its footprint, so
 * its outline on screen is the union of its projected faces (bottom, top and each side), and the rect touches the
 * shape if it touches any of them.
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

/**
 * The shape's faces on screen (room walls included): for each ring of its outline, the bottom and top, then one
 * quad per side. A concave outline's inside isn't a face, so a rect in a crescent's hollow misses it. Null if any
 * corner is behind the camera.
 */
export function shapeFaces(cam: CameraState, size: Size, shape: ClosedShape): ScreenPoint[][] | null {
  const outlines = shape.kind === "room" ? ringsInWorld(shape, roomWalls(shape, WALL_THICKNESS / 2).outer) : [footprint(shape)];
  const faces: ScreenPoint[][] = [];
  for (const outline of outlines) {
    const ring = (y: number) => {
      const points: ScreenPoint[] = [];
      for (const p of outline) {
        const s = worldToScreen(cam, size, { x: p.x, y, z: p.z });
        if (!s) return null;
        points.push(s);
      }
      return points;
    };
    const bottom = ring(shape.y);
    const top = ring(shape.y + shape.height);
    if (!bottom || !top) return null;
    const n = outline.length;
    faces.push(bottom, top, ...outline.map((_, i) => [bottom[i], bottom[(i + 1) % n], top[(i + 1) % n], top[i]]));
  }
  return faces;
}

/** Even-odd point-in-polygon on screen. */
function inside(poly: ScreenPoint[], p: ScreenPoint): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.sy > p.sy !== b.sy > p.sy && p.sx < ((b.sx - a.sx) * (p.sy - a.sy)) / (b.sy - a.sy) + a.sx) hit = !hit;
  }
  return hit;
}

/** Whether segments a–b and c–d cross or touch. */
function segmentsCross(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint, d: ScreenPoint): boolean {
  const orient = (p: ScreenPoint, q: ScreenPoint, r: ScreenPoint) => Math.sign((q.sx - p.sx) * (r.sy - p.sy) - (q.sy - p.sy) * (r.sx - p.sx));
  const onSegment = (p: ScreenPoint, q: ScreenPoint, r: ScreenPoint) =>
    Math.min(p.sx, q.sx) <= r.sx && r.sx <= Math.max(p.sx, q.sx) && Math.min(p.sy, q.sy) <= r.sy && r.sy <= Math.max(p.sy, q.sy);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b))
  );
}

/**
 * Whether a polygon (convex or not) and an axis-aligned rect overlap: a vertex of one inside the other, or an edge
 * of each crossing.
 */
export function polygonOverlapsRect(poly: ScreenPoint[], rect: ScreenRect): boolean {
  if (poly.length === 0) return false;
  const corners: ScreenPoint[] = [
    { sx: rect.x0, sy: rect.y0 },
    { sx: rect.x1, sy: rect.y0 },
    { sx: rect.x1, sy: rect.y1 },
    { sx: rect.x0, sy: rect.y1 },
  ];
  if (poly.some((p) => p.sx >= rect.x0 && p.sx <= rect.x1 && p.sy >= rect.y0 && p.sy <= rect.y1)) return true;
  if (poly.length >= 3 && corners.some((c) => inside(poly, c))) return true;
  return poly.some((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return corners.some((c, j) => segmentsCross(p, q, c, corners[(j + 1) % 4]));
  });
}

/** Whether a line's path on screen touches the rect: a point inside it, or a segment crossing its edge. */
function pathOverlapsRect(path: ScreenPoint[], rect: ScreenRect): boolean {
  if (path.some((p) => p.sx >= rect.x0 && p.sx <= rect.x1 && p.sy >= rect.y0 && p.sy <= rect.y1)) return true;
  const corners: ScreenPoint[] = [
    { sx: rect.x0, sy: rect.y0 },
    { sx: rect.x1, sy: rect.y0 },
    { sx: rect.x1, sy: rect.y1 },
    { sx: rect.x0, sy: rect.y1 },
  ];
  return path.some((p, i) => i + 1 < path.length && corners.some((c, j) => segmentsCross(p, path[i + 1], c, corners[(j + 1) % 4])));
}

/** The IDs of the shapes the rect touches on screen, in scene order: a closed shape's faces, a line's path. */
export function marqueeHits(cam: CameraState, size: Size, boxes: Shape[], rect: ScreenRect): string[] {
  return boxes
    .filter((b) => {
      if (isClosed(b)) return shapeFaces(cam, size, b)?.some((face) => polygonOverlapsRect(face, rect)) ?? false;
      const path = polyline(b).map((p) => worldToScreen(cam, size, p));
      return path.every((p) => p !== null) && pathOverlapsRect(path, rect);
    })
    .map((b) => b.id);
}

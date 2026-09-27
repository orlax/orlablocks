import { CURVE_SEGMENTS, MIN_POINTS, type FootPoint, type Offset } from "../shared/scene.types";
import { sampleEdge, type Point } from "../shared/geometry";
import { worldToScreen, type CameraState, type Size } from "./camera";

/**
 * Pure math for point editing (a free-form's points and handles): what's under the cursor, and what each edit does
 * to the outline. Points are shown and dragged on the shape's top face (elevation `y`). The edits return new point
 * lists and never round; the caller rounds before sending.
 */

/** How close (px) the pointer must be to a point or a handle's end to grab it. */
export const POINT_HIT_PX = 8;
/** How close (px) to an edge a click inserts a point there. */
export const EDGE_HIT_PX = 6;

export type HandleSide = "in" | "out";
/** Something point editing can grab: a point, a handle (of a selected point) or a spot on an edge (`t` along it). */
export type PointPart = { type: "point"; index: number } | { type: "handle"; index: number; side: HandleSide } | { type: "edge"; index: number; t: number };

/** Where a handle's end is, in world x/z. */
export const handleEnd = (p: FootPoint, side: HandleSide): Point | null => {
  const h = p[side];
  return h ? { x: p.x + h.x, z: p.z + h.z } : null;
};

/**
 * What's under the cursor at (sx, sy): a handle of a selected point first (they're drawn on top), then the nearest
 * point, then the nearest spot on an edge. Null if nothing is close enough.
 */
export function hitPoints(
  cam: CameraState,
  size: Size,
  sx: number,
  sy: number,
  points: FootPoint[],
  y: number,
  selected: number[],
): PointPart | null {
  const screen = (p: Point) => worldToScreen(cam, size, { x: p.x, y, z: p.z });
  const distance = (p: Point) => {
    const s = screen(p);
    return s ? Math.hypot(s.sx - sx, s.sy - sy) : Infinity;
  };

  let best: { part: PointPart; d: number } | null = null;
  for (const index of selected) {
    const p = points[index];
    if (!p) continue;
    for (const side of ["in", "out"] as const) {
      const end = handleEnd(p, side);
      const d = end ? distance(end) : Infinity;
      if (d <= POINT_HIT_PX && (!best || d < best.d)) best = { part: { type: "handle", index, side }, d };
    }
  }
  if (best) return best.part;

  for (const [index, p] of points.entries()) {
    const d = distance(p);
    if (d <= POINT_HIT_PX && (!best || d < best.d)) best = { part: { type: "point", index }, d };
  }
  if (best) return best.part;

  for (const [index, p] of points.entries()) {
    const next = points[(index + 1) % points.length];
    const samples = [...sampleEdge(p, next), next].map(screen);
    // A straight edge is one segment (t is its fraction); a curved one CURVE_SEGMENTS, sampled at even t.
    const segments = samples.length - 1;
    for (let k = 0; k < segments; k++) {
      const a = samples[k];
      const b = samples[k + 1];
      if (!a || !b) continue;
      const { d, u } = segmentDistance(sx, sy, a, b);
      const t = segments === 1 ? u : (k + u) / CURVE_SEGMENTS;
      if (d <= EDGE_HIT_PX && (!best || d < best.d)) best = { part: { type: "edge", index, t }, d };
    }
  }
  return best?.part ?? null;
}

/** Distance from (px, py) to the segment a–b on screen, and how far along it (0..1) the nearest spot is. */
function segmentDistance(px: number, py: number, a: { sx: number; sy: number }, b: { sx: number; sy: number }) {
  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.sx) * dx + (py - a.sy) * dy) / len2));
  return { d: Math.hypot(px - (a.sx + dx * u), py - (a.sy + dy * u)), u };
}

/** The points at `indices` moved by (dx, dz), their handles with them. */
export const movePoints = (points: FootPoint[], indices: number[], dx: number, dz: number): FootPoint[] =>
  points.map((p, i) => (indices.includes(i) ? { ...p, x: p.x + dx, z: p.z + dz } : p));

/**
 * Point `index`'s `side` handle set to `offset` (from the point). Unless `independent`, the opposite handle, if
 * the point has one, turns to stay in line with it (pointing the other way, keeping its own length), so a smooth
 * point stays smooth. `Alt` makes it independent: a corner between two curves.
 */
export function moveHandle(points: FootPoint[], index: number, side: HandleSide, offset: Offset, independent: boolean): FootPoint[] {
  const other: HandleSide = side === "in" ? "out" : "in";
  return points.map((p, i) => {
    if (i !== index) return p;
    const next: FootPoint = { ...p, [side]: offset };
    const opposite = p[other];
    const len = Math.hypot(offset.x, offset.z);
    if (!independent && opposite && len > 0) {
      const keep = Math.hypot(opposite.x, opposite.z);
      next[other] = { x: (-offset.x / len) * keep, z: (-offset.z / len) * keep };
    }
    return next;
  });
}

/**
 * Point `index` switched between corner and smooth: a corner (no handles) gets handles along the direction from
 * its previous neighbor to its next (a third of the shorter edge to them, each way); a point with any handle
 * drops them.
 */
export function togglePoint(points: FootPoint[], index: number): FootPoint[] {
  const p = points[index];
  if (p.in || p.out) return points.map((q, i) => (i === index ? { x: q.x, z: q.z } : q));
  const prev = points[(index - 1 + points.length) % points.length];
  const next = points[(index + 1) % points.length];
  let dir = { x: next.x - prev.x, z: next.z - prev.z };
  let len = Math.hypot(dir.x, dir.z);
  if (len === 0) {
    dir = { x: next.x - p.x, z: next.z - p.z };
    len = Math.hypot(dir.x, dir.z) || 1;
  }
  const reach = Math.min(Math.hypot(p.x - prev.x, p.z - prev.z), Math.hypot(next.x - p.x, next.z - p.z)) / 3;
  const out = { x: (dir.x / len) * reach, z: (dir.z / len) * reach };
  return points.map((q, i) => (i === index ? { x: q.x, z: q.z, in: { x: -out.x, z: -out.z }, out } : q));
}

/** The outline without the points at `indices`, or null if that would leave fewer than MIN_POINTS. */
export function removePoints(points: FootPoint[], indices: number[]): FootPoint[] | null {
  const left = points.filter((_, i) => !indices.includes(i));
  return left.length >= MIN_POINTS ? left : null;
}

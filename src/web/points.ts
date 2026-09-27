import { CURVE_SEGMENTS, type FootPoint, type Offset } from "../shared/scene.types";
import { sampleEdge, sampleEdge3, type Point } from "../shared/geometry";
import { worldToScreen, type CameraState, type Size } from "./camera";

/**
 * Pure math for point editing (a free-form's or a line's points and handles): what's under the cursor, and what
 * each edit does to the points. A free-form's points are shown and dragged on its top face (elevation `y`); a
 * line's points have their own y (and its handles are 3D). A free-form's outline is `closed` (the last point joins
 * the first), a line's path isn't. The edits return new point lists and never round; the caller rounds before
 * sending.
 */

/** A free-form's point, or a line's (with y, and 3D handles). */
export type EditPoint = FootPoint & { y?: number; in?: Offset & { y?: number }; out?: Offset & { y?: number } };
/** Where a point is in 3D: its own y, or the free-form's top. */
export const pointY = (p: EditPoint, y: number) => p.y ?? y;

/** How close (px) the pointer must be to a point or a handle's end to grab it. */
export const POINT_HIT_PX = 8;
/** How close (px) to an edge a click inserts a point there. */
export const EDGE_HIT_PX = 6;

export type HandleSide = "in" | "out";
/** Something point editing can grab: a point, a handle (of a selected point) or a spot on an edge (`t` along it). */
export type PointPart = { type: "point"; index: number } | { type: "handle"; index: number; side: HandleSide } | { type: "edge"; index: number; t: number };

/** Where a handle's end is, in world x/z. */
export const handleEnd = (p: EditPoint, side: HandleSide): (Point & { y?: number }) | null => {
  const h = p[side];
  if (!h) return null;
  return { x: p.x + h.x, z: p.z + h.z, ...(p.y !== undefined ? { y: p.y + (h.y ?? 0) } : {}) };
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
  points: EditPoint[],
  y: number,
  selected: number[],
  closed = true,
): PointPart | null {
  const screen = (p: Point & { y?: number }) => worldToScreen(cam, size, { x: p.x, y: p.y ?? y, z: p.z });
  const distance = (p: Point & { y?: number }) => {
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
    if (!closed && index === points.length - 1) break;
    const next = points[(index + 1) % points.length];
    const edge = p.y !== undefined && next.y !== undefined ? sampleEdge3(p as never, next as never) : sampleEdge(p, next);
    const samples = [...edge, next].map(screen);
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

/** The points at `indices` moved by (dx, dz) (and a line's up by dy), their handles with them. */
export const movePoints = <P extends EditPoint>(points: P[], indices: number[], dx: number, dz: number, dy = 0): P[] =>
  points.map((p, i) =>
    indices.includes(i) ? { ...p, x: p.x + dx, z: p.z + dz, ...(p.y !== undefined ? { y: p.y + dy } : {}) } : p,
  );

/**
 * Point `index`'s `side` handle set to `offset` (from the point). Unless `independent`, the opposite handle, if
 * the point has one, turns to stay in line with it (pointing the other way, keeping its own length), so a smooth
 * point stays smooth. `Alt` makes it independent: a corner between two curves.
 */
export function moveHandle<P extends EditPoint>(
  points: P[],
  index: number,
  side: HandleSide,
  offset: Offset & { y?: number },
  independent: boolean,
): P[] {
  const other: HandleSide = side === "in" ? "out" : "in";
  return points.map((p, i) => {
    if (i !== index) return p;
    const next: P = { ...p, [side]: offset };
    const opposite = p[other];
    const oy = offset.y ?? 0;
    const len = Math.hypot(offset.x, oy, offset.z);
    if (!independent && opposite && len > 0) {
      const keep = Math.hypot(opposite.x, opposite.y ?? 0, opposite.z);
      next[other] = {
        x: (-offset.x / len) * keep,
        ...(opposite.y !== undefined ? { y: (-oy / len) * keep } : {}),
        z: (-offset.z / len) * keep,
      };
    }
    return next;
  });
}

/**
 * Point `index` switched between corner and smooth: a corner (no handles) gets handles along the direction from
 * its previous neighbor to its next (a third of the shorter edge to them, each way; at an open path's end, along
 * its one edge); a point with any handle drops them.
 */
export function togglePoint<P extends EditPoint>(points: P[], index: number, closed = true): P[] {
  const p = points[index];
  const bare = ({ in: _i, out: _o, ...rest }: P) => rest as P;
  if (p.in || p.out) return points.map((q, i) => (i === index ? bare(q) : q));
  const at = (k: number) => (closed ? points[(k + points.length) % points.length] : points[Math.max(0, Math.min(points.length - 1, k))]);
  const prev = at(index - 1);
  const next = at(index + 1);
  const v = (a: EditPoint, b: EditPoint) => ({ x: b.x - a.x, y: (b.y ?? 0) - (a.y ?? 0), z: b.z - a.z });
  const norm = (d: { x: number; y: number; z: number }) => Math.hypot(d.x, d.y, d.z);
  let dir = v(prev, next);
  let len = norm(dir);
  if (len === 0) {
    dir = v(p, next);
    len = norm(dir) || 1;
  }
  const edges = [norm(v(prev, p)), norm(v(p, next))].filter((d) => d > 0);
  const reach = Math.min(...edges) / 3;
  const has3d = p.y !== undefined;
  const out = { x: (dir.x / len) * reach, ...(has3d ? { y: (dir.y / len) * reach } : {}), z: (dir.z / len) * reach };
  const opposite = { x: -out.x, ...(has3d ? { y: -(out.y ?? 0) } : {}), z: -out.z };
  return points.map((q, i) => (i === index ? { ...bare(q), in: opposite, out } : q));
}

/** The points without the ones at `indices`, or null if that would leave fewer than `min` (3 for a free-form, 2 for a line). */
export function removePoints<P extends EditPoint>(points: P[], indices: number[], min: number): P[] | null {
  const left = points.filter((_, i) => !indices.includes(i));
  return left.length >= min ? left : null;
}

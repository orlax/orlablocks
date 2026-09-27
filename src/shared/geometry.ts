import { differenceD, EndType, FillRule, inflatePathsD, JoinType, type PathD } from "@countertype/clipper2-ts";
import { CURVE_SEGMENTS, MIN_POINTS, SMOOTH_SEGMENTS, type Box, type Cylinder, type FootPoint, type Offset, type Shape, type ShapePatch } from "./scene.types";

/**
 * Pure shape geometry shared by the server (group moves and rotations) and the editor (picking, the marquee, the
 * gizmo, rendering). Ground coordinates are x/z; rotation is counterclockwise seen from above (a right-handed turn
 * about +y). Every closed shape reduces to a **footprint** polygon, and what's specific to a shape type (its
 * footprint, how it moves, turns, mirrors and scales) is one function each here, so a new shape adds its own cases.
 */

/** A point on the ground. */
export type Point = { x: number; z: number };

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

/**
 * A turned rectangle on the ground: a box's or a cylinder's own footprint rectangle, or a free-form's world-axis
 * bounds (see `handleFrame`). The gizmo's scale and rotate handles sit on it.
 */
export type Frame = { x: number; z: number; width: number; depth: number; rotation: number };

/** Whether two field values are the same: equal, or (for a free-form's points) the same content. */
export const sameValue = (a: unknown, b: unknown) =>
  a === b || (typeof a === "object" && a !== null && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

/** 2 decimals, and never -0. */
export const round2 = (n: number) => Math.round(n * 100) / 100 + 0;
export const normalizeDeg = (deg: number) => ((deg % 360) + 360) % 360;

/** Boxes and cylinders: a center, a size and a rotation of their own (free-forms have only points). */
export const isFootprinted = (shape: Shape): shape is Box | Cylinder => shape.type !== "freeform";

/** A shape's rotation (a free-form's is always 0: turning it turns its points). */
export const rotationOf = (shape: Shape) => (isFootprinted(shape) ? shape.rotation : 0);

/** The frame's local axes on the ground, in world x/z: `ex` along its width, `ez` along its depth. */
export function shapeAxes(frame: { rotation: number }) {
  const a = (frame.rotation * Math.PI) / 180;
  return { ex: { x: Math.cos(a), z: -Math.sin(a) }, ez: { x: Math.sin(a), z: Math.cos(a) } };
}

/** A world ground point in the frame (origin at its center, axes along width and depth). */
export function toShapeLocal(frame: { x: number; z: number; rotation: number }, p: Point) {
  const { ex, ez } = shapeAxes(frame);
  const dx = p.x - frame.x;
  const dz = p.z - frame.z;
  return { x: dx * ex.x + dz * ex.z, z: dx * ez.x + dz * ez.z };
}

/** A point in the frame back in world x/z. */
export function fromShapeLocal(frame: { x: number; z: number; rotation: number }, l: Point) {
  const { ex, ez } = shapeAxes(frame);
  return { x: frame.x + l.x * ex.x + l.z * ez.x, z: frame.z + l.x * ex.z + l.z * ez.z };
}

/** A cubic bezier's point at t. */
function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, z: a * p0.z + b * p1.z + c * p2.z + d * p3.z };
}

/**
 * The edge from `a` to `b` as straight segments: its start point, then (for a curved edge) CURVE_SEGMENTS − 1
 * points along the curve. The end point is the next edge's start. Straight unless `a.out` or `b.in` is set.
 */
export function sampleEdge(a: FootPoint, b: FootPoint): Point[] {
  if (!a.out && !b.in) return [{ x: a.x, z: a.z }];
  const c1 = a.out ? { x: a.x + a.out.x, z: a.z + a.out.z } : a;
  const c2 = b.in ? { x: b.x + b.in.x, z: b.z + b.in.z } : b;
  return Array.from({ length: CURVE_SEGMENTS }, (_, i) => bezier(a, c1, c2, b, i / CURVE_SEGMENTS));
}

/**
 * A closed outline of points as a polygon: every edge sampled (`sampleEdge`). `edge[k]` is the point index whose
 * edge the polygon's segment k (from vertex k to k + 1) lies on.
 */
export function sampleOutline(points: FootPoint[]): { polygon: Point[]; edge: number[] } {
  const polygon: Point[] = [];
  const edge: number[] = [];
  points.forEach((p, i) => {
    const samples = sampleEdge(p, points[(i + 1) % points.length]);
    polygon.push(...samples);
    edge.push(...samples.map(() => i));
  });
  return { polygon, edge };
}

/**
 * The shape's footprint in its own frame (see `shapeFrame`).
 * - A box: its 4 corners around its center, going (-x, -z), (+x, -z), (+x, +z), (-x, +z) in its own axes.
 * - A cylinder: its corners on the ellipse inscribed in width × depth, corner i at angle (i + ½) × 360° / sides from
 *   local +x, counterclockwise seen from above, so a flat edge faces local +x (and, for a side count divisible by
 *   4, every axis). A smooth one is drawn and picked with SMOOTH_SEGMENTS corners.
 * - A free-form: its sampled outline; its frame is the world's.
 */
export function localFootprint(shape: Shape): Point[] {
  if (shape.type === "freeform") return sampleOutline(shape.points).polygon;
  const hw = shape.width / 2;
  const hd = shape.depth / 2;
  if (shape.type === "cylinder") {
    const n = shape.sides ?? SMOOTH_SEGMENTS;
    return Array.from({ length: n }, (_, i) => {
      const a = ((i + 0.5) * 2 * Math.PI) / n;
      return { x: Math.cos(a) * hw, z: -Math.sin(a) * hd };
    });
  }
  return [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd },
  ];
}

/** Where a shape's own frame sits in the world and how it's turned (degrees). `localFootprint` is in this frame. */
export const shapeFrame = (shape: Shape) => (isFootprinted(shape) ? { x: shape.x, z: shape.z, rotation: shape.rotation } : { x: 0, z: 0, rotation: 0 });

/** The shape's footprint in world x/z. */
export const footprint = (shape: Shape): Point[] => {
  const frame = shapeFrame(shape);
  return localFootprint(shape).map((p) => fromShapeLocal(frame, p));
};

/** Twice the signed area of a polygon in the x/z plane (shoelace); the sign gives its winding. */
export function signedArea2(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a;
}

/** Whether `p` is inside the polygon (even-odd rule, so it works for concave outlines too). */
export function pointInPolygon(poly: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether `p` is inside a region given as rings (even-odd across all of them, so holes count as outside). */
export const pointInRings = (rings: Point[][], p: Point) => rings.filter((r) => pointInPolygon(r, p)).length % 2 === 1;

/**
 * The polygon grown outward by `d` meters (negative shrinks it), with mitered corners, in either winding. Exact
 * for convex polygons (boxes, cylinders); concave outlines use `offsetRings`. Null if shrinking collapses it (an
 * edge would turn around).
 */
export function offsetPolygon(poly: Point[], d: number): Point[] | null {
  const area = signedArea2(poly);
  if (area === 0) return null;
  // The outward normal of an edge along (ex, ez), for this winding.
  const s = area > 0 ? 1 : -1;
  const normal = (a: Point, b: Point) => {
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len = Math.hypot(ex, ez) || 1;
    return { x: (s * ez) / len, z: (-s * ex) / len };
  };
  const out = poly.map((p, i) => {
    const n1 = normal(poly[(i - 1 + poly.length) % poly.length], p);
    const n2 = normal(p, poly[(i + 1) % poly.length]);
    // The miter: where the two offset edges meet (a straight run just moves along its normal).
    const k = d / Math.max(1 + n1.x * n2.x + n1.z * n2.z, 1e-6);
    return { x: p.x + (n1.x + n2.x) * k, z: p.z + (n1.z + n2.z) * k };
  });
  // Shrunk past its middle, some edge turns around (or vanishes).
  const collapsed = poly.some((p, i) => {
    const q = poly[(i + 1) % poly.length];
    const a = out[i];
    const b = out[(i + 1) % out.length];
    return (b.x - a.x) * (q.x - p.x) + (b.z - a.z) * (q.z - p.z) <= 1e-12;
  });
  return collapsed ? null : out;
}

/** Offsets are computed to the millimeter, and sharp corners are mitered out to at most twice the offset. */
const OFFSET_PRECISION = 3;
const MITER_LIMIT = 2;
const toPath = (poly: Point[]): PathD => poly.map((p) => ({ x: p.x, y: p.z }));
const fromPath = (path: PathD): Point[] => path.map((p) => ({ x: p.x, z: p.y }));

/**
 * The region the polygon covers, grown by `d` meters (negative shrinks it), as rings to read even-odd. For a
 * convex polygon it's the exact mitered offset (one ring, or none if it collapses); for any other (a free-form) a
 * robust offset (Clipper2), which can split a shrunk outline into pieces or leave holes where a grown one closes
 * an inlet.
 */
export function offsetRings(poly: Point[], d: number, convex: boolean): Point[][] {
  if (convex) {
    const ring = offsetPolygon(poly, d);
    return ring ? [ring] : [];
  }
  return inflatePathsD([toPath(poly)], d, JoinType.Miter, EndType.Polygon, MITER_LIMIT, OFFSET_PRECISION).map(fromPath);
}

/**
 * A room's walls on the ground, in the shape's own frame: `outer` (the footprint grown by half the wall thickness,
 * what a click or the marquee can hit), `inner` (shrunk by it: the open inside, none if the room is too narrow to
 * have one) and `walls`, the region between them as rings (outer ones counterclockwise in x/z, holes the other
 * way). Cached per shape object, since picking asks for it on every pointer move.
 */
const wallCache = new WeakMap<Shape, { outer: Point[][]; inner: Point[][]; walls: Point[][] }>();
export function roomWalls(shape: Shape, half: number): { outer: Point[][]; inner: Point[][]; walls: Point[][] } {
  const cached = wallCache.get(shape);
  if (cached) return cached;
  const local = localFootprint(shape);
  const convex = isFootprinted(shape);
  const outer = offsetRings(local, half, convex);
  const inner = offsetRings(local, -half, convex);
  const walls = convex
    ? [...outer, ...inner.map((r) => [...r].reverse())]
    : differenceD(outer.map(toPath), inner.map(toPath), FillRule.NonZero, OFFSET_PRECISION).map(fromPath);
  const result = { outer, inner, walls };
  wallCache.set(shape, result);
  return result;
}

/** Rings in the shape's own frame (from `roomWalls`) in world x/z. */
export function ringsInWorld(shape: Shape, rings: Point[][]): Point[][] {
  if (!isFootprinted(shape)) return rings;
  const frame = shapeFrame(shape);
  return rings.map((r) => r.map((p) => fromShapeLocal(frame, p)));
}

/** A polygon's axis-aligned bounds on the ground. */
function polygonBounds(poly: Point[]) {
  const xs = poly.map((p) => p.x);
  const zs = poly.map((p) => p.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/**
 * The axis-aligned bounds of a shape's (possibly rotated) footprint: exact for boxes and cylinders (a smooth
 * cylinder's from its true ellipse, not the drawn polygon), from the sampled outline for a free-form.
 */
export function footprintBounds(shape: Shape): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (!isFootprinted(shape) || (shape.type === "cylinder" && shape.sides !== undefined)) return polygonBounds(footprint(shape));
  const a = (shape.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const [hx, hz] =
    shape.type === "cylinder"
      ? [Math.hypot((shape.width / 2) * cos, (shape.depth / 2) * sin), Math.hypot((shape.width / 2) * sin, (shape.depth / 2) * cos)]
      : [(shape.width * cos + shape.depth * sin) / 2, (shape.width * sin + shape.depth * cos) / 2];
  return { minX: shape.x - hx, maxX: shape.x + hx, minZ: shape.z - hz, maxZ: shape.z + hz };
}

/** The axis-aligned box around all of `shapes` (at least one). */
export function boundsOf(shapes: Shape[]): Bounds {
  const b: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const shape of shapes) {
    const f = footprintBounds(shape);
    b.minX = Math.min(b.minX, f.minX);
    b.maxX = Math.max(b.maxX, f.maxX);
    b.minZ = Math.min(b.minZ, f.minZ);
    b.maxZ = Math.max(b.maxZ, f.maxZ);
    b.minY = Math.min(b.minY, shape.y);
    b.maxY = Math.max(b.maxY, shape.y + shape.height);
  }
  return b;
}

/** The rectangle the gizmo's scale and rotate handles sit on: a box's or cylinder's own, a free-form's world-axis bounds. */
export function handleFrame(shape: Shape): Frame {
  if (isFootprinted(shape)) return shape;
  const b = footprintBounds(shape);
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, width: b.maxX - b.minX, depth: b.maxZ - b.minZ, rotation: 0 };
}

/** A point that moves with the shape (a box's center, a free-form's first point), for measuring how far a drag took it. */
export const anchorOf = (shape: Shape) =>
  isFootprinted(shape) ? { x: shape.x, y: shape.y, z: shape.z } : { x: shape.points[0].x, y: shape.y, z: shape.points[0].z };

/** Points (and their handles) with every value rounded to 2 decimals; a handle that rounds to nothing is dropped. */
export function roundPoints(points: FootPoint[]): FootPoint[] {
  const handle = (h: Offset | undefined) => {
    if (!h) return undefined;
    const r = { x: round2(h.x), z: round2(h.z) };
    return r.x === 0 && r.z === 0 ? undefined : r;
  };
  return points.map((p) => {
    const out: FootPoint = { x: round2(p.x), z: round2(p.z) };
    const i = handle(p.in);
    const o = handle(p.out);
    if (i) out.in = i;
    if (o) out.out = o;
    return out;
  });
}

/** Every point (with its handles) through `f`, which maps a position; handles map through `h`, which maps an offset. */
const mapPoints = (points: FootPoint[], f: (p: Point) => Point, h: (o: Offset) => Offset): FootPoint[] =>
  roundPoints(points.map((p) => ({ ...f(p), ...(p.in ? { in: h(p.in) } : {}), ...(p.out ? { out: h(p.out) } : {}) })));

/**
 * The frame around `shapes`' footprints, turned by `angle` degrees: the smallest rectangle in axes turned that way
 * that holds them all. At 0 it's the exact axis-aligned bounds. Turning the shapes around its center by some angle
 * gives the same frame turned by that much, around the same center: that's what keeps a selection's rotate pivot
 * still (Figma-style), where the axis-aligned bounds' center would drift.
 */
export function orientedFrame(shapes: Shape[], angle: number): Frame {
  if (angle === 0) {
    const b = boundsOf(shapes);
    return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, width: b.maxX - b.minX, depth: b.maxZ - b.minZ, rotation: 0 };
  }
  const { ex, ez } = shapeAxes({ rotation: angle });
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const shape of shapes) {
    for (const p of footprint(shape)) {
      const u = p.x * ex.x + p.z * ex.z;
      const v = p.x * ez.x + p.z * ez.z;
      [u0, u1, v0, v1] = [Math.min(u0, u), Math.max(u1, u), Math.min(v0, v), Math.max(v1, v)];
    }
  }
  const [uc, vc] = [(u0 + u1) / 2, (v0 + v1) / 2];
  return { x: uc * ex.x + vc * ez.x, z: uc * ex.z + vc * ez.z, width: u1 - u0, depth: v1 - v0, rotation: angle };
}

/**
 * The frame the gizmo sits on for a selection: a single box's or cylinder's own rectangle, otherwise the shapes'
 * frame turned by `turn` (how far the editor has turned this selection so far; 0 = axis-aligned).
 */
export function selectionFrame(shapes: Shape[], turn = 0): Frame {
  if (shapes.length === 1 && isFootprinted(shapes[0])) return handleFrame(shapes[0]);
  return orientedFrame(shapes, turn);
}

/** Bezier handles of a circle drawn through 4 smooth points: this times the radius, along the tangent. */
export const CIRCLE_HANDLE = 0.5523;

/**
 * A box's or cylinder's outline as free-form points (rounded to 2 decimals): a box's 4 corners, a sided cylinder's
 * corners, and a smooth cylinder as 4 smooth points on its ellipse's axes (handles CIRCLE_HANDLE × each radius),
 * so it stays a true circle or oval to edit. The points go counterclockwise seen from above, from local +x.
 */
export function toFreeformPoints(shape: Box | Cylinder): FootPoint[] {
  if (shape.type === "box" || shape.sides !== undefined) return roundPoints(footprint(shape));
  const { ex, ez } = shapeAxes(shape);
  const world = (l: Offset) => ({ x: l.x * ex.x + l.z * ez.x, z: l.x * ex.z + l.z * ez.z });
  const [hw, hd] = [shape.width / 2, shape.depth / 2];
  return roundPoints(
    [0, 1, 2, 3].map((i) => {
      const a = (i * Math.PI) / 2;
      // On the ellipse at angle a from local +x (counterclockwise seen from above), and its tangent that way.
      const p = world({ x: Math.cos(a) * hw, z: -Math.sin(a) * hd });
      const out = world({ x: -Math.sin(a) * hw * CIRCLE_HANDLE, z: -Math.cos(a) * hd * CIRCLE_HANDLE });
      return { x: shape.x + p.x, z: shape.z + p.z, in: { x: -out.x, z: -out.z }, out };
    }),
  );
}

/**
 * The outline with a point inserted on the edge from point `i` to the next, at `t` (0..1) along it. A curved edge
 * is split with de Casteljau, so the shape doesn't change: the neighbors' handles shorten and the new point gets
 * handles along the curve. On a straight edge the new point is a corner. Not rounded.
 */
export function splitEdge(points: FootPoint[], i: number, t: number): FootPoint[] {
  const a = points[i];
  const j = (i + 1) % points.length;
  const b = points[j];
  const lerp = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
  const offset = (p: Point, from: Point): Offset | undefined => {
    const o = { x: p.x - from.x, z: p.z - from.z };
    return o.x === 0 && o.z === 0 ? undefined : o;
  };
  const withHandle = (p: FootPoint, side: "in" | "out", h: Offset | undefined): FootPoint => {
    const { [side]: _old, ...rest } = p;
    return h ? { ...rest, [side]: h } : rest;
  };
  let inserted: FootPoint;
  let [na, nb] = [a, b];
  if (!a.out && !b.in) inserted = lerp(a, b);
  else {
    const p1 = a.out ? { x: a.x + a.out.x, z: a.z + a.out.z } : a;
    const p2 = b.in ? { x: b.x + b.in.x, z: b.z + b.in.z } : b;
    const [p01, p12, p23] = [lerp(a, p1), lerp(p1, p2), lerp(p2, b)];
    const [p012, p123] = [lerp(p01, p12), lerp(p12, p23)];
    const m = lerp(p012, p123);
    inserted = withHandle(withHandle({ x: m.x, z: m.z }, "in", offset(p012, m)), "out", offset(p123, m));
    na = withHandle(a, "out", a.out && offset(p01, a));
    nb = withHandle(b, "in", b.in && offset(p23, b));
  }
  const next = points.map((p, k) => (k === i ? na : k === j ? nb : p));
  next.splice(i + 1, 0, inserted);
  return next;
}

/**
 * A shape moved by an offset (2 decimals). Only the axes that move are in the patch, so a drag along x is a "move"
 * and not also an elevation change.
 */
export function moveShape(shape: Shape, dx: number, dy: number, dz: number): ShapePatch {
  const patch: ShapePatch = {};
  if (dy !== 0) patch.y = round2(shape.y + dy);
  if (!isFootprinted(shape)) {
    if (dx !== 0 || dz !== 0) patch.points = mapPoints(shape.points, (p) => ({ x: p.x + dx, z: p.z + dz }), (o) => o);
    return patch;
  }
  if (dx !== 0) patch.x = round2(shape.x + dx);
  if (dz !== 0) patch.z = round2(shape.z + dz);
  return patch;
}

/**
 * A shape turned by `degrees` around the vertical axis through `pivot`. A box's or cylinder's center orbits the
 * pivot and the angle adds to its rotation; a free-form's points orbit it and their handles turn with them.
 */
export function rotateShape(shape: Shape, pivot: Point, degrees: number): ShapePatch {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const turn = (o: Offset) => ({ x: o.x * cos + o.z * sin, z: -o.x * sin + o.z * cos });
  const orbit = (p: Point) => {
    const t = turn({ x: p.x - pivot.x, z: p.z - pivot.z });
    return { x: pivot.x + t.x, z: pivot.z + t.z };
  };
  if (!isFootprinted(shape)) return { points: mapPoints(shape.points, orbit, turn) };
  const c = orbit(shape);
  return { x: round2(c.x), z: round2(c.z), rotation: round2(normalizeDeg(shape.rotation + degrees)) % 360 };
}

/** Turns shapes by `degrees` around the vertical axis through `pivot` (see `rotateShape`). Returns the patches. */
export function rotateAround(shapes: Shape[], pivot: Point, degrees: number): Record<string, ShapePatch> {
  return Object.fromEntries(shapes.map((shape) => [shape.id, rotateShape(shape, pivot, degrees)]));
}

/**
 * A shape resized from its handle frame `from` to `to` (the gizmo's scale handles). A box or cylinder takes the new
 * center and size; a free-form's points (and handles) stretch with the frame, along its own (possibly turned) axes.
 */
export function resizeShape(shape: Shape, from: Frame, to: { x: number; z: number; width: number; depth: number }): ShapePatch {
  if (isFootprinted(shape)) return { x: to.x, z: to.z, width: to.width, depth: to.depth };
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sz = from.depth > 0 ? to.depth / from.depth : 1;
  const target = { ...to, rotation: from.rotation };
  const { ex, ez } = shapeAxes(from);
  const stretch = (o: Offset) => {
    const u = (o.x * ex.x + o.z * ex.z) * sx;
    const v = (o.x * ez.x + o.z * ez.z) * sz;
    return { x: u * ex.x + v * ez.x, z: u * ex.z + v * ez.z };
  };
  return {
    points: mapPoints(
      shape.points,
      (p) => {
        const l = toShapeLocal(from, p);
        return fromShapeLocal(target, { x: l.x * sx, z: l.z * sz });
      },
      stretch,
    ),
  };
}

/** A world axis on the ground, for mirroring. */
export type MirrorAxis = "x" | "z";

/**
 * `n` rounded to 2 decimals, ties to an even last digit. Used for the mirror's reflection sum: with plain rounding
 * a tie (quarter-meter widths make 0.125) would round up after every mirror, drifting 0.01 each time.
 */
function round2HalfEven(n: number): number {
  const h = n * 100;
  const f = Math.floor(h);
  const tie = Math.abs(h - f - 0.5) < 1e-6;
  return (tie ? (f % 2 === 0 ? f : f + 1) : Math.round(h)) / 100 + 0;
}

/**
 * One shape reflected across the plane where `axis` = sum / 2 (sum = twice the pivot).
 * - A box, a smooth or even-sided cylinder: symmetric across both of its own axes, so its center reflects and its
 *   rotation becomes -rotation on either axis.
 * - An odd-sided cylinder is symmetric across its local x axis only: -rotation on Z, but 180 - rotation on X
 *   (the mirror of its flipped-x shape is the same shape turned a half turn).
 * - A free-form isn't symmetric: each point reflects and its handles flip on that axis. The points keep their
 *   order (so their indices stay stable), which only reverses the outline's winding.
 */
export function mirrorShape(shape: Shape, axis: MirrorAxis, sum: number): ShapePatch {
  if (!isFootprinted(shape)) {
    return axis === "x"
      ? { points: mapPoints(shape.points, (p) => ({ x: sum - p.x, z: p.z }), (o) => ({ x: -o.x, z: o.z })) }
      : { points: mapPoints(shape.points, (p) => ({ x: p.x, z: sum - p.z }), (o) => ({ x: o.x, z: -o.z })) };
  }
  const odd = shape.type === "cylinder" && shape.sides !== undefined && shape.sides % 2 === 1;
  const rotation = round2(normalizeDeg(axis === "x" && odd ? 180 - shape.rotation : -shape.rotation)) % 360;
  return axis === "x" ? { x: round2(sum - shape.x), rotation } : { z: round2(sum - shape.z), rotation };
}

/**
 * Mirrors shapes on a world axis across the center of their combined footprint bounds, in place. Mirroring the
 * result again restores the original values exactly. Returns the patches.
 */
export function mirrorAcross(shapes: Shape[], axis: MirrorAxis): Record<string, ShapePatch> {
  const b = boundsOf(shapes);
  const sum = round2HalfEven(axis === "x" ? b.minX + b.maxX : b.minZ + b.maxZ);
  return Object.fromEntries(shapes.map((shape) => [shape.id, mirrorShape(shape, axis, sum)]));
}

/** Whether segments a–b and c–d cross or touch (on the ground). */
function segmentsTouch(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) => {
    const v = (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    return Math.abs(v) < 1e-12 ? 0 : Math.sign(v);
  };
  const on = (p: Point, q: Point, r: Point) =>
    Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.z, q.z) <= r.z && r.z <= Math.max(p.z, q.z);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

/**
 * The first two segments of a polygonal path that cross or touch, other than neighbors (which share an end point),
 * as their indices, or null. `closed`: the last point joins the first.
 */
function firstCrossing(polygon: Point[], closed: boolean): [number, number] | null {
  const n = polygon.length;
  const segments = closed ? n : n - 1;
  // Each segment's bounds, for a quick reject before the exact test.
  const box = polygon.map((p, i) => {
    const q = polygon[(i + 1) % n];
    return { x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), z0: Math.min(p.z, q.z), z1: Math.max(p.z, q.z) };
  });
  for (let i = 0; i < segments; i++) {
    for (let j = i + 1; j < segments; j++) {
      if (j === i + 1 || (closed && i === 0 && j === n - 1)) continue;
      if (box[i].x1 < box[j].x0 || box[j].x1 < box[i].x0 || box[i].z1 < box[j].z0 || box[j].z1 < box[i].z0) continue;
      if (segmentsTouch(polygon[i], polygon[(i + 1) % n], polygon[j], polygon[(j + 1) % n])) return [i, j];
    }
  }
  return null;
}

/**
 * Whether a path of points (curved edges sampled) crosses itself: an outline being drawn (`closed` false: its last
 * point doesn't join the first yet) or a finished one.
 */
export function pathCrosses(points: FootPoint[], closed: boolean): boolean {
  if (points.length < 3) return false;
  const polygon = closed
    ? sampleOutline(points).polygon
    : [...points.slice(0, -1).flatMap((p, i) => sampleEdge(p, points[i + 1])), points.at(-1)!];
  return firstCrossing(polygon, closed) !== null;
}

/**
 * What's wrong with a free-form outline, or null if it's fine: fewer than 3 distinct points, no area, or edges
 * that cross (checked on the sampled curves, so a handle that loops an edge over another counts). Points are named
 * by their index in the list.
 */
export function outlineProblem(points: FootPoint[]): string | null {
  const distinct = new Set(points.map((p) => `${p.x},${p.z}`));
  if (distinct.size < MIN_POINTS) return `the outline needs at least ${MIN_POINTS} distinct points`;
  for (let i = 0; i < points.length; i++) {
    const q = points[(i + 1) % points.length];
    if (points[i].x === q.x && points[i].z === q.z) return `points ${i} and ${(i + 1) % points.length} are in the same place`;
  }
  const { polygon, edge } = sampleOutline(points);
  if (Math.abs(signedArea2(polygon)) < 1e-6) return "the outline has no area";
  const crossing = firstCrossing(polygon, true);
  if (!crossing) return null;
  const [a, b] = [edge[crossing[0]], edge[crossing[1]]];
  return a === b ? `the curve from point ${a} loops over itself` : `the outline crosses itself (the edges from point ${a} and from point ${b})`;
}

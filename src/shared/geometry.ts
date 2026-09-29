import { differenceD, EndType, FillRule, inflatePathsD, JoinType, type PathD } from "@countertype/clipper2-ts";
import { arrayShapes, instanceShapes } from "./entities";
import { layoutAnchor, layoutPoints, mirrorArray, moveArray, rotateArray, scaleArray, tiltArray } from "./arrays";
import { apply, mul, orbit3, orientationYXZ, rotY, tiltXZ, toXZY, toYXZ, type Mat3 } from "./rotation3";
import {
  CURVE_SEGMENTS,
  DEFAULT_WALL,
  MIN_LINE_POINTS,
  MIN_POINTS,
  MIN_RAMP_WIDTH,
  RAMP_SINK,
  RAMP_SLAB,
  SMOOTH_SEGMENTS,
  type Box,
  type ClosedShape,
  type Cylinder,
  type FootPoint,
  type Freeform,
  type Line,
  type LinePoint,
  type Offset,
  type Ramp,
  type RampPoint,
  type Shape,
  type Solid,
  type ShapePatch,
} from "./scene.types";

/**
 * Pure shape geometry shared by the server (group moves and rotations) and the editor (picking, the marquee, the
 * gizmo, rendering). Ground coordinates are x/z; rotation is counterclockwise seen from above (a right-handed turn
 * about +y). Every closed shape reduces to a **footprint** polygon, and what's specific to a shape type (its
 * footprint, how it moves, turns, mirrors and scales) is one function each here, so a new shape adds its own cases.
 */

/** A point on the ground. */
export type Point = { x: number; z: number };
/** A point in 3D. */
export type Point3 = { x: number; y: number; z: number };

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

/** Boxes and cylinders: a center, a size and a rotation of their own (free-forms and lines have only points). */
export const isFootprinted = (shape: Shape): shape is Box | Cylinder => shape.type === "box" || shape.type === "cylinder";

/** Boxes, cylinders and free-forms: a footprint, a kind, an elevation and a height (lines and ramps have none). */
export const isClosed = (shape: Shape): shape is ClosedShape =>
  shape.type !== "line" && shape.type !== "ramp" && shape.type !== "note" && shape.type !== "instance" && shape.type !== "array";

/** Closed shapes and ramps: a kind and a mesh, so holes cut them (only closed shapes can be holes). */
export const isSolid = (shape: Shape): shape is Solid =>
  shape.type !== "line" && shape.type !== "note" && shape.type !== "instance" && shape.type !== "array";

/** Instances and arrays: nodes that show entities (their shapes are the entities', expanded). */
export const showsEntities = (shape: Shape): shape is Extract<Shape, { type: "instance" | "array" }> => shape.type === "instance" || shape.type === "array";

/** A shape's rotation (a free-form's or a line's is always 0: turning it turns its points). */
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

/** A cubic bezier's point at t (on the ground). */
function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, z: a * p0.z + b * p1.z + c * p2.z + d * p3.z };
}

/** A cubic bezier's point at t, in 3D. */
function bezier3(p0: Point3, p1: Point3, p2: Point3, p3: Point3, t: number): Point3 {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    z: a * p0.z + b * p1.z + c * p2.z + d * p3.z,
  };
}

/** A line's edge from `a` to `b` in 3D, as `sampleEdge` does on the ground: its start, then points along a curve. */
export function sampleEdge3(a: LinePoint, b: LinePoint): Point3[] {
  if (!a.out && !b.in) return [{ x: a.x, y: a.y, z: a.z }];
  const c1 = a.out ? { x: a.x + a.out.x, y: a.y + a.out.y, z: a.z + a.out.z } : a;
  const c2 = b.in ? { x: b.x + b.in.x, y: b.y + b.in.y, z: b.z + b.in.z } : b;
  return Array.from({ length: CURVE_SEGMENTS }, (_, i) => bezier3(a, c1, c2, b, i / CURVE_SEGMENTS));
}

/** A line as a 3D polyline: every edge sampled, then the last point. */
export function polyline(line: Line): Point3[] {
  const { points } = line;
  return [...points.slice(0, -1).flatMap((p, i) => sampleEdge3(p, points[i + 1])), { ...points.at(-1)! }].map((p) => ({ x: p.x, y: p.y, z: p.z }));
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
 * - A free-form: its sampled outline; its frame is the world's, or for a tilted one (14.4) its outline's center.
 */
export function localFootprint(shape: ClosedShape): Point[] {
  if (shape.type === "freeform") {
    const polygon = sampleOutline(shape.points).polygon;
    if (!isTilted(shape)) return polygon;
    const c = freeformCenter(shape);
    return polygon.map((p) => ({ x: p.x - c.x, z: p.z - c.z }));
  }
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

/** Whether a shape is tilted: a box, cylinder or (from 14.4) free-form with a pitch or a roll. */
export const isTilted = (shape: Shape): boolean => (isFootprinted(shape) || shape.type === "freeform") && (!!shape.pitch || !!shape.roll);

const centerCache = new WeakMap<FootPoint[], Point>();
/**
 * The center of a free-form's outline on the ground (its sampled outline's centroid): what a tilted free-form turns
 * around (14.4), at half its height. A centroid turns, scales and moves with the outline (a bounds' middle wouldn't
 * under a turn), so a free-form's tilt stays put when its points are turned; it moves a little when one is edited.
 */
export function freeformCenter(shape: Freeform): Point {
  const hit = centerCache.get(shape.points);
  if (hit) return hit;
  const c = centroid(sampleOutline(shape.points).polygon);
  centerCache.set(shape.points, c);
  return c;
}

/**
 * A point in a closed shape's own frame (x/z on its footprint, y from 0 at its bottom up to its height) in the
 * world (a ramp's frame is the world's). The shape is tilted around its center (0, height / 2, 0): first `roll` around its local z axis, then
 * `pitch` around its local x axis (both right-handed, in degrees), then turned by `rotation` around the vertical
 * and moved to its place, so a tilt never moves its center and a turn never changes its tilt.
 */
export function toWorld3(shape: Solid, p: Point3): Point3 {
  if (shape.type === "ramp") return p;
  let { x, y, z } = p;
  if (isTilted(shape)) {
    const h = shape.height / 2;
    y -= h;
    const r = ((shape.roll ?? 0) * Math.PI) / 180;
    [x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
    const q = ((shape.pitch ?? 0) * Math.PI) / 180;
    [y, z] = [y * Math.cos(q) - z * Math.sin(q), y * Math.sin(q) + z * Math.cos(q)];
    y += h;
  }
  const w = fromShapeLocal(shapeFrame(shape), { x, z });
  return { x: w.x, y: y + shape.y, z: w.z };
}

/** A world point in a closed shape's own frame: the inverse of `toWorld3`. */
export function toLocal3(shape: Solid, p: Point3): Point3 {
  if (shape.type === "ramp") return p;
  const l = toShapeLocal(shapeFrame(shape), p);
  let [x, y, z] = [l.x, p.y - shape.y, l.z];
  if (isTilted(shape)) {
    const h = shape.height / 2;
    y -= h;
    const q = (-(shape.pitch ?? 0) * Math.PI) / 180;
    [y, z] = [y * Math.cos(q) - z * Math.sin(q), y * Math.sin(q) + z * Math.cos(q)];
    const r = (-(shape.roll ?? 0) * Math.PI) / 180;
    [x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
    y += h;
  }
  return { x, y, z };
}

/** A tilted shape's points in the world (its rings' corners): what its bounds and its outline on the ground come from. */
function tiltedPoints(shape: ClosedShape): Point3[] {
  return volumeRings(shape).flatMap(({ ring, y }) => ring.map((p) => toWorld3(shape, { x: p.x, y, z: p.z })));
}

/**
 * Where a shape's own frame sits in the world and how it's turned (degrees). `localFootprint` is in this frame. A
 * free-form's is the world's, or a tilted one's outline center (14.4), so it tilts around its middle.
 */
export const shapeFrame = (shape: ClosedShape) =>
  isFootprinted(shape)
    ? { x: shape.x, z: shape.z, rotation: shape.rotation }
    : isTilted(shape)
      ? { ...freeformCenter(shape), rotation: 0 }
      : { x: 0, z: 0, rotation: 0 };

/** The shape's footprint in world x/z. */
export const footprint = (shape: ClosedShape): Point[] => {
  const frame = shapeFrame(shape);
  return localFootprint(shape).map((p) => fromShapeLocal(frame, p));
};

/**
 * Where a shape covers the ground, as points to take bounds of: a closed shape's footprint (a tilted one's points,
 * seen from above), a line's polyline.
 */
export const groundPoints = (shape: Shape): Point[] =>
  shape.type === "instance"
    ? instanceShapes(shape).flatMap(groundPoints)
    : shape.type === "array"
      ? arrayGround(shape)
    : shape.type === "note"
    ? [{ x: shape.x, z: shape.z }]
    : shape.type === "line"
    ? polyline(shape)
    : shape.type === "ramp"
      ? rampEdges(shape).flat()
      : isTilted(shape)
        ? tiltedPoints(shape)
        : footprint(shape);

/** An array's ground points: its items' shapes, or its layout's when it has no items. */
function arrayGround(array: Extract<Shape, { type: "array" }>): Point[] {
  const shapes = arrayShapes(array);
  return shapes.length > 0 ? shapes.flatMap(groundPoints) : layoutPoints(array.layout);
}

/** How many rings round a bevel's quarter circle. */
export const BEVEL_SEGMENTS = 8;

/** A polygon's area centroid on the ground. */
export function centroid(poly: Point[]): Point {
  let [a, cx, cz] = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.z - q.x * p.z;
    a += f;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
  }
  return Math.abs(a) < 1e-12 ? poly[0] : { x: cx / (3 * a), z: cz / (3 * a) };
}

/**
 * The rings a volume is built from, from 0 up to its height, in its own frame. Without a taper or a bevel it's the
 * footprint at the bottom and the top. `taper` (0..1) scales the outline toward its center linearly up the height,
 * to 1 − taper at the top (1 = a point). `bevel` (0..1) rounds the top edge along a quarter circle of radius
 * bevel × min(height, the top's half smallest extent), in BEVEL_SEGMENTS rings.
 * - A box or cylinder shrinks by the same distance on its width and depth: a true inset, so the rounding is even.
 * - A free-form scales toward its outline's area centroid (a true inset of a concave outline would change its
 *   point count): the inset is read as a fraction of the outline's half smallest extent.
 */
export function volumeRings(shape: ClosedShape): { ring: Point[]; y: number }[] {
  const base = localFootprint(shape);
  const h = shape.height;
  const taper = shape.taper ?? 0;
  const bevel = shape.bevel ?? 0;
  if (taper === 0 && bevel === 0) return [{ ring: base, y: 0 }, { ring: base, y: h }];
  // `ringAt(k, e)`: the outline scaled by k toward its center, then inset by e meters.
  let half: number;
  let ringAt: (k: number, e: number) => Point[];
  if (isFootprinted(shape)) {
    half = Math.min(shape.width, shape.depth) / 2;
    ringAt = (k, e) =>
      localFootprint({ ...shape, width: Math.max(0, k * shape.width - 2 * e), depth: Math.max(0, k * shape.depth - 2 * e) });
  } else {
    const c = centroid(base);
    const xs = base.map((p) => p.x);
    const zs = base.map((p) => p.z);
    half = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2;
    ringAt = (k, e) => {
      const s = Math.max(0, k - e / half);
      return base.map((p) => ({ x: c.x + (p.x - c.x) * s, z: c.z + (p.z - c.z) * s }));
    };
  }
  const scale = (y: number) => 1 - (taper * y) / h;
  const r = bevel * Math.min(h, scale(h) * half);
  const stack = [{ ring: base, y: 0 }];
  if (r < 1e-6) stack.push({ ring: ringAt(scale(h), 0), y: h });
  else {
    for (let j = 0; j <= BEVEL_SEGMENTS; j++) {
      const a = (j / BEVEL_SEGMENTS) * (Math.PI / 2);
      const y = h - r + r * Math.sin(a);
      // The bevel's first ring is where the straight side ends; when the bevel takes the whole height it's the bottom.
      if (j === 0 && y < 1e-6) continue;
      stack.push({ ring: ringAt(scale(y), r * (1 - Math.cos(a))), y });
    }
  }
  return stack;
}

/**
 * A station along a ramp's centerline: its place on the ground, its distance along the ground from the start
 * (`s`), the height there if the ramp were smooth (`y`, even with the distance between two points), and its left
 * and right edges (half the width out to each side; at a corner, mitered so the edges stay parallel to both sides).
 */
export type RampStation = { x: number; z: number; s: number; y: number; left: Point; right: Point };

const stationCache = new WeakMap<Ramp, RampStation[]>();
const pointDistances = new WeakMap<Ramp, number[]>();

/** How far along the ground each of a ramp's points is from its start. */
export function rampPointDistances(ramp: Ramp): number[] {
  if (!pointDistances.has(ramp)) {
    stationCache.delete(ramp);
    rampStations(ramp);
  }
  return pointDistances.get(ramp)!;
}

/** The stations along a ramp: every point, and CURVE_SEGMENTS samples along each curved edge. Cached per ramp. */
export function rampStations(ramp: Ramp): RampStation[] {
  const cached = stationCache.get(ramp);
  if (cached) return cached;
  const pts = ramp.points;
  const raw: { x: number; z: number; s: number; y: number }[] = [];
  const at: number[] = [0];
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const samples = [...sampleEdge(a, b), { x: b.x, z: b.z }];
    const lengths = [0];
    for (let k = 1; k < samples.length; k++) lengths.push(lengths[k - 1] + Math.hypot(samples[k].x - samples[k - 1].x, samples[k].z - samples[k - 1].z));
    const length = lengths.at(-1)!;
    // Each edge's end is the next edge's start; the last edge keeps its end.
    const count = i + 2 < pts.length ? samples.length - 1 : samples.length;
    for (let k = 0; k < count; k++) {
      const f = length > 0 ? lengths[k] / length : 0;
      raw.push({ x: samples[k].x, z: samples[k].z, s: s + lengths[k], y: a.y + (b.y - a.y) * f });
    }
    s += length;
    at.push(s);
  }
  pointDistances.set(ramp, at);
  const half = ramp.width / 2;
  const dir = (p: Point, q: Point) => {
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    return { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
  };
  const stations = raw.map((p, k): RampStation => {
    const din = k > 0 ? dir(raw[k - 1], p) : dir(p, raw[k + 1]);
    const dout = k + 1 < raw.length ? dir(p, raw[k + 1]) : din;
    // The left normal of each direction, averaged, lengthened at a corner (at most 4×) to keep the width.
    const n1 = { x: din.z, z: -din.x };
    const n2 = { x: dout.z, z: -dout.x };
    const m = { x: n1.x + n2.x, z: n1.z + n2.z };
    const ml = Math.hypot(m.x, m.z) || 1;
    const cos = Math.max(0.25, (m.x * n1.x + m.z * n1.z) / ml);
    const k2 = half / cos / ml;
    return { ...p, left: { x: p.x + m.x * k2, z: p.z + m.z * k2 }, right: { x: p.x - m.x * k2, z: p.z - m.z * k2 } };
  });
  stationCache.set(ramp, stations);
  return stations;
}

/** A ramp's left and right edges on the ground (for its bounds and its outline). */
export const rampEdges = (ramp: Ramp): [Point[], Point[]] => {
  const st = rampStations(ramp);
  return [st.map((p) => p.left), st.map((p) => p.right)];
};

/** A ramp's bottom: flat just below its lowest point (solid), or its smooth surface lowered by the slab (floating). */
export function rampBottom(ramp: Ramp, station: { y: number }): number {
  if (ramp.base === "floating") return station.y - RAMP_SLAB;
  return Math.min(...ramp.points.map((p) => p.y)) - RAMP_SINK;
}

/** A ramp's lowest and highest points: its bottom, and its highest point's height. */
export function rampRange(ramp: Ramp): [number, number] {
  const st = rampStations(ramp);
  return [Math.min(...st.map((p) => rampBottom(ramp, p))), Math.max(...ramp.points.map((p) => p.y))];
}

/** A ramp can have at most this many steps in all. */
export const MAX_STEPS = 1000;

/** The radius of the circle through three points on the ground (Infinity when they're in a line). */
function turnRadius(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }): number {
  const ab = Math.hypot(b.x - a.x, b.z - a.z);
  const bc = Math.hypot(c.x - b.x, c.z - b.z);
  const ca = Math.hypot(a.x - c.x, a.z - c.z);
  const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return cross < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cross);
}

/**
 * What's wrong with a ramp, or null: fewer than 2 points, neighbors in the same place on the ground, a turn too
 * tight for its width (an edge would fold back on itself), or too many steps.
 */
export function rampProblem(ramp: Ramp): string | null {
  const pts = ramp.points;
  if (pts.length < MIN_LINE_POINTS) return `a ramp needs at least ${MIN_LINE_POINTS} points`;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pts[i].x === pts[i + 1].x && pts[i].z === pts[i + 1].z) return `points ${i} and ${i + 1} are in the same place on the ground`;
  }
  const st = rampStations(ramp);
  for (let k = 0; k + 1 < st.length; k++) {
    const [p, q] = [st[k], st[k + 1]];
    const along = { x: q.x - p.x, z: q.z - p.z };
    for (const side of ["left", "right"] as const) {
      const e = { x: q[side].x - p[side].x, z: q[side].z - p[side].z };
      if (e.x * along.x + e.z * along.z <= 1e-9) {
        const near = pts.reduce((best, pt, i) => (Math.hypot(pt.x - p.x, pt.z - p.z) < Math.hypot(pts[best].x - p.x, pts[best].z - p.z) ? i : best), 0);
        // How tight the centerline turns there (14.2): the smallest radius through three stations nearby.
        let radius = Infinity;
        for (let j = Math.max(0, k - 3); j + 2 < Math.min(st.length, k + 5); j++) radius = Math.min(radius, turnRadius(st[j], st[j + 1], st[j + 2]));
        // A curve too tight says how much wider it must be; a corner that folds a wide ramp's edge says to round it.
        const allowed =
          Number.isFinite(radius) && radius < ramp.width / 2
            ? ` Its centerline turns with a radius of about ${round2(radius)} m there, and a ${ramp.width} m wide ramp needs at least ${round2(ramp.width / 2)} m: widen the curve to that, or narrow the ramp to at most ${round2(Math.max(MIN_RAMP_WIDTH, radius * 2 * 0.95))} m.`
            : ` The corner there is too sharp for the width (its edge folds back): round it with handles (in / out), or split it into two gentler turns.`;
        return `the ramp turns too tightly for its ${ramp.width} m width near point ${near} (make the curve wider or the ramp narrower).${allowed}`;
      }
    }
  }
  if (ramp.step !== undefined) {
    const steps = pts.slice(1).reduce((n, p, i) => n + Math.max(1, Math.round(Math.abs(p.y - pts[i].y) / ramp.step!)), 0);
    if (steps > MAX_STEPS) return `${steps} steps is too many (at most ${MAX_STEPS}): make the step taller`;
  }
  return null;
}

/**
 * A spiral's points: one every 90° at most (evenly spread over the turn), on a circle of `radius` around (x, z),
 * from angle `from` (0 = east, +x; 90 = north, -z) through `turn` degrees (counterclockwise seen from above when
 * positive), rising evenly by `rise` from `y`. Each point gets circle handles, so the path is a true circle.
 */
export function spiralPoints(sp: { x: number; z: number; radius: number; turn: number; y: number; rise: number; from?: number }): RampPoint[] {
  const n = Math.max(1, Math.ceil(Math.abs(sp.turn) / 90 - 1e-9));
  const step = sp.turn / n;
  const k = (4 / 3) * Math.tan((Math.abs(step) * Math.PI) / 180 / 4) * sp.radius;
  const sign = Math.sign(sp.turn) || 1;
  return roundPoints(
    Array.from({ length: n + 1 }, (_, i) => {
      const a = (((sp.from ?? 0) + i * step) * Math.PI) / 180;
      // Counterclockwise seen from above is +x toward -z; its tangent that way is (-sin a, -cos a).
      const t = { x: -Math.sin(a) * sign * k, z: -Math.cos(a) * sign * k };
      return {
        x: sp.x + Math.cos(a) * sp.radius,
        y: sp.y + (sp.rise * i) / n,
        z: sp.z - Math.sin(a) * sp.radius,
        ...(i > 0 ? { in: { x: -t.x, z: -t.z } } : {}),
        ...(i < n ? { out: t } : {}),
      };
    }),
  );
}

/**
 * A spiral as a line's (or a path layout's) points (plan 13 §5): `spiralPoints`, with 3D handles that climb a third
 * of each segment's rise, so the curve rises evenly between its points instead of in steps at them.
 */
export function spiralLinePoints(sp: Parameters<typeof spiralPoints>[0]): LinePoint[] {
  const points = spiralPoints(sp);
  const climb = sp.rise / Math.max(1, points.length - 1) / 3;
  return roundPoints(
    points.map((p) => ({
      x: p.x,
      y: p.y,
      z: p.z,
      ...(p.in ? { in: { x: p.in.x, y: -climb, z: p.in.z } } : {}),
      ...(p.out ? { out: { x: p.out.x, y: climb, z: p.out.z } } : {}),
    })),
  );
}

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

/** A room's wall thickness: its own, or the default. */
export const wallOf = (shape: ClosedShape) => shape.wall ?? DEFAULT_WALL;

/**
 * A room's walls on the ground, in the shape's own frame. The footprint is the room's outside, and the walls grow
 * inward from it by the wall thickness: `outer` is the footprint (what a click or the marquee can hit), `inner` the
 * footprint shrunk by the thickness (the open inside; none if the room is too narrow to have one) and `walls` the
 * region between them as rings (solid ones wound one way, holes the other). An outline with no area gives no rings.
 * Cached per shape object, since picking asks for it on every pointer move.
 */
const wallCache = new WeakMap<ClosedShape, { outer: Point[][]; inner: Point[][]; walls: Point[][] }>();
export function roomWalls(shape: ClosedShape): { outer: Point[][]; inner: Point[][]; walls: Point[][] } {
  const cached = wallCache.get(shape);
  if (cached) return cached;
  const local = localFootprint(shape);
  let result: { outer: Point[][]; inner: Point[][]; walls: Point[][] };
  if (Math.abs(signedArea2(local)) < 1e-9) result = { outer: [], inner: [], walls: [] };
  else {
    const convex = isFootprinted(shape);
    const inner = offsetRings(local, -wallOf(shape), convex);
    const walls = convex
      ? [local, ...inner.map((r) => [...r].reverse())]
      : differenceD([toPath(local)], inner.map(toPath), FillRule.NonZero, OFFSET_PRECISION).map(fromPath);
    result = { outer: [local], inner, walls };
  }
  wallCache.set(shape, result);
  return result;
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
  if (!isFootprinted(shape) || isTilted(shape) || (shape.type === "cylinder" && shape.sides !== undefined)) return polygonBounds(groundPoints(shape));
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
    const [y0, y1] = verticalRange(shape);
    b.minY = Math.min(b.minY, y0);
    b.maxY = Math.max(b.maxY, y1);
  }
  return b;
}

/**
 * A shape's bottom and top: a closed shape's elevation and top (a tilted one's lowest and highest point), a line's
 * lowest and highest point (curves included).
 */
export function verticalRange(shape: Shape): [number, number] {
  if (isTilted(shape)) {
    const ys = tiltedPoints(shape as ClosedShape).map((p) => p.y);
    return [Math.min(...ys), Math.max(...ys)];
  }
  if (isClosed(shape)) return [shape.y, shape.y + shape.height];
  if (shape.type === "ramp") return rampRange(shape);
  if (shape.type === "note") return [shape.y, shape.y];
  if (shape.type === "instance" || shape.type === "array") {
    const ranges = (shape.type === "instance" ? instanceShapes(shape) : arrayShapes(shape)).map(verticalRange);
    if (ranges.length > 0) return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
    const y = shape.type === "instance" ? shape.y : layoutAnchor(shape.layout).y;
    return [y, y];
  }
  const ys = polyline(shape).map((p) => p.y);
  return [Math.min(...ys), Math.max(...ys)];
}

/** The rectangle the gizmo's scale and rotate handles sit on: a box's or cylinder's own, a free-form's world-axis bounds. */
export function handleFrame(shape: Shape): Frame {
  if (isFootprinted(shape)) return shape;
  const b = footprintBounds(shape);
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, width: b.maxX - b.minX, depth: b.maxZ - b.minZ, rotation: 0 };
}

/**
 * A point that moves with the shape (a box's center, a free-form's or a line's first point), for measuring how far
 * a drag took it.
 */
export const anchorOf = (shape: Shape) => {
  if (isFootprinted(shape) || shape.type === "note" || shape.type === "instance") return { x: shape.x, y: shape.y, z: shape.z };
  if (shape.type === "array") return layoutAnchor(shape.layout);
  const p = shape.points[0];
  return { x: p.x, y: shape.type === "freeform" ? shape.y : shape.points[0].y, z: p.z };
};

/** A point's or a handle's y, when it has one (a line's): rounded along with x and z. */
type MaybeY = { y?: number };
const roundY = <T extends MaybeY>(v: T): MaybeY => (v.y !== undefined ? { y: round2(v.y) } : {});

/**
 * Points (and their handles) with every value rounded to 2 decimals; a handle that rounds to nothing is dropped.
 * Works for a free-form's points and a line's (which also have y).
 */
export function roundPoints<P extends FootPoint>(points: P[]): P[] {
  const handle = (h: (Offset & MaybeY) | undefined) => {
    if (!h) return undefined;
    const r = { x: round2(h.x), ...roundY(h), z: round2(h.z) };
    return r.x === 0 && r.z === 0 && (r.y ?? 0) === 0 ? undefined : r;
  };
  return points.map((p) => {
    const out: FootPoint & MaybeY = { x: round2(p.x), ...roundY(p as P & MaybeY), z: round2(p.z) };
    const i = handle(p.in);
    const o = handle(p.out);
    if (i) out.in = i;
    if (o) out.out = o;
    return out as P;
  });
}

/**
 * Every point (with its handles) through `f`, which maps a ground position; handles map through `h`, which maps a
 * ground offset. A line's y (on its points and handles) is kept, unless `dy` shifts its points up.
 */
const mapPoints = <P extends FootPoint>(points: P[], f: (p: Point) => Point, h: (o: Offset) => Offset, dy = 0): P[] =>
  roundPoints(
    points.map((p) => {
      const q = p as P & MaybeY;
      return {
        ...p,
        ...f(p),
        ...(q.y !== undefined ? { y: q.y + dy } : {}),
        ...(p.in ? { in: { ...p.in, ...h(p.in) } } : {}),
        ...(p.out ? { out: { ...p.out, ...h(p.out) } } : {}),
      };
    }),
  );

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
    for (const p of groundPoints(shape)) {
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
export function splitEdge<P extends FootPoint>(points: P[], i: number, t: number): P[] {
  // Points and handles are ground points, or 3D ones on a line (a missing y reads as 0 and stays missing).
  type V = Point & MaybeY;
  const has3d = (points[0] as P & MaybeY).y !== undefined;
  const a = points[i];
  const j = (i + 1) % points.length;
  const b = points[j];
  const v = (p: V): V => (has3d ? { x: p.x, y: p.y ?? 0, z: p.z } : { x: p.x, z: p.z });
  const plus = (p: V, o: V): V => v({ x: p.x + o.x, y: (p.y ?? 0) + (o.y ?? 0), z: p.z + o.z });
  const lerp = (p: V, q: V): V => v({ x: p.x + (q.x - p.x) * t, y: (p.y ?? 0) + ((q.y ?? 0) - (p.y ?? 0)) * t, z: p.z + (q.z - p.z) * t });
  const offset = (p: V, from: V): V | undefined => {
    const o = v({ x: p.x - from.x, y: (p.y ?? 0) - (from.y ?? 0), z: p.z - from.z });
    return o.x === 0 && o.z === 0 && (o.y ?? 0) === 0 ? undefined : o;
  };
  const withHandle = (p: V & { in?: V; out?: V }, side: "in" | "out", h: V | undefined) => {
    const { [side]: _old, ...rest } = p;
    return h ? { ...rest, [side]: h } : rest;
  };
  let inserted: V & { in?: V; out?: V };
  let [na, nb]: (V & { in?: V; out?: V })[] = [a, b];
  if (!a.out && !b.in) inserted = lerp(a, b);
  else {
    const p1 = a.out ? plus(a, a.out) : v(a);
    const p2 = b.in ? plus(b, b.in) : v(b);
    const [p01, p12, p23] = [lerp(a, p1), lerp(p1, p2), lerp(p2, b)];
    const [p012, p123] = [lerp(p01, p12), lerp(p12, p23)];
    const m = lerp(p012, p123);
    inserted = withHandle(withHandle(m, "in", offset(p012, m)), "out", offset(p123, m));
    na = withHandle(a, "out", a.out && offset(p01, a));
    nb = withHandle(b, "in", b.in && offset(p23, b));
  }
  const next = points.map((p, k) => (k === i ? na : k === j ? nb : p)) as P[];
  next.splice(i + 1, 0, inserted as P);
  return next;
}

/** A line's points in the other order, each point's handles swapped (in ↔ out), so the path's shape doesn't change. */
export const reversePoints = (points: LinePoint[]): LinePoint[] =>
  [...points].reverse().map(({ in: i, out: o, ...p }) => ({ ...p, ...(o ? { in: o } : {}), ...(i ? { out: i } : {}) }));

/**
 * What's wrong with a line's path, or null if it's fine: fewer than 2 points, or two neighbors in the same place
 * (a line may cross itself). Points are named by their index.
 */
export function lineProblem(points: LinePoint[]): string | null {
  if (points.length < MIN_LINE_POINTS) return `a line needs at least ${MIN_LINE_POINTS} points`;
  for (let i = 0; i + 1 < points.length; i++) {
    const [p, q] = [points[i], points[i + 1]];
    if (p.x === q.x && p.y === q.y && p.z === q.z) return `points ${i} and ${i + 1} are in the same place`;
  }
  return null;
}

/**
 * A shape moved by an offset (2 decimals). Only the axes that move are in the patch, so a drag along x is a "move"
 * and not also an elevation change.
 */
export function moveShape(shape: Shape, dx: number, dy: number, dz: number): ShapePatch {
  if (shape.type === "array") return moveArray(shape, dx, dy, dz);
  const patch: ShapePatch = {};
  if (shape.type === "note" || shape.type === "instance") {
    if (dx !== 0) patch.x = round2(shape.x + dx);
    if (dy !== 0) patch.y = round2(shape.y + dy);
    if (dz !== 0) patch.z = round2(shape.z + dz);
    return patch;
  }
  if (shape.type === "line" || shape.type === "ramp") {
    // A line or a ramp has no elevation of its own: moving it up moves its points.
    if (dx !== 0 || dy !== 0 || dz !== 0) patch.points = mapPoints(shape.points, (p) => ({ x: p.x + dx, z: p.z + dz }), (o) => o, dy);
    return patch;
  }
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
  // A tilted free-form's or array's tilt is around the world's axes (14.4), so a turn changes it: turn it rigidly.
  if ((shape.type === "freeform" || shape.type === "array") && (shape.pitch || shape.roll)) {
    return tiltShape(shape, rotY(degrees), { x: pivot.x, y: 0, z: pivot.z });
  }
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const turn = (o: Offset) => ({ x: o.x * cos + o.z * sin, z: -o.x * sin + o.z * cos });
  const orbit = (p: Point) => {
    const t = turn({ x: p.x - pivot.x, z: p.z - pivot.z });
    return { x: pivot.x + t.x, z: pivot.z + t.z };
  };
  if (shape.type === "note") {
    const c = orbit(shape);
    return { x: round2(c.x), z: round2(c.z) };
  }
  if (shape.type === "array") return rotateArray(shape, pivot, degrees);
  if (shape.type === "instance") {
    const c = orbit(shape);
    return { x: round2(c.x), z: round2(c.z), rotation: round2(normalizeDeg(shape.rotation + degrees)) % 360 };
  }
  if (!isFootprinted(shape)) return { points: mapPoints<FootPoint>(shape.points, orbit, turn) };
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
  if (shape.type === "line" || shape.type === "ramp" || shape.type === "note" || shape.type === "instance" || shape.type === "array") return {}; // these have no scale handles
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

/** A point in the world, for scaling about (14.3). */
export type Pivot3 = { x: number; y: number; z: number };

/**
 * A shape scaled uniformly by `factor` about `pivot` (14.3): every position moves away from (or toward) the pivot and
 * every length in meters grows with it, walls, heights and steps included. What isn't in meters keeps: angles, the
 * taper and bevel fractions, a line's thickness (screen px). An instance's or array's entity grows through its
 * `scale`. Two decimals.
 */
export function scaleShape(shape: Shape, factor: number, pivot: Pivot3): ShapePatch {
  const f = factor;
  const px = (x: number) => round2(pivot.x + (x - pivot.x) * f);
  const py = (y: number) => round2(pivot.y + (y - pivot.y) * f);
  const pz = (z: number) => round2(pivot.z + (z - pivot.z) * f);
  const len = (n: number) => round2(n * f);
  const scaleOf = (s: number | undefined) => round2((s ?? 1) * f);
  if (shape.type === "array") return scaleArray(shape, f, pivot);
  if (shape.type === "note") return { x: px(shape.x), y: py(shape.y), z: pz(shape.z) };
  if (shape.type === "instance") return { x: px(shape.x), y: py(shape.y), z: pz(shape.z), scale: scaleOf(shape.scale) };
  if (shape.type === "line") return { points: scaledPoints3(shape.points, f, pivot) };
  if (shape.type === "ramp") {
    return { points: scaledPoints3(shape.points, f, pivot) as RampPoint[], width: len(shape.width), ...(shape.step !== undefined ? { step: len(shape.step) } : {}) };
  }
  const wall = shape.kind === "room" ? { wall: len(wallOf(shape)) } : {};
  const vertical = { y: py(shape.y), height: len(shape.height), ...wall };
  if (!isFootprinted(shape)) {
    return {
      ...vertical,
      points: roundPoints(
        shape.points.map((p) => ({
          ...p,
          x: pivot.x + (p.x - pivot.x) * f,
          z: pivot.z + (p.z - pivot.z) * f,
          ...(p.in ? { in: { x: p.in.x * f, z: p.in.z * f } } : {}),
          ...(p.out ? { out: { x: p.out.x * f, z: p.out.z * f } } : {}),
        })),
      ),
    };
  }
  return { ...vertical, x: px(shape.x), z: pz(shape.z), width: len(shape.width), depth: len(shape.depth) };
}

/** A tilt as stored: degrees in -180..180, 2 decimals, 0 for none (the store leaves a 0 out). */
const tiltAngle = (d: number) => {
  const a = round2(normalizeDeg(d + 180) - 180);
  return a === -180 ? 180 : a + 0;
};

/**
 * A shape turned rigidly by the rotation `m` about a point (14.4: tilting a group, or anything, as one): its place
 * orbits the pivot in 3D and its orientation becomes m times its own.
 * - A box or cylinder (and an instance, around its pivot) keeps its orientation as yaw, pitch and roll (m · Ry Rx Rz,
 *   split again as YXZ).
 * - A free-form has no yaw: its tilt is split as Rx · Rz · Ry, and the Ry part turns its points around its center.
 * - An array, likewise: its tilt is Rx · Rz about its layout's anchor, and the Ry part turns its layout.
 * - A line's points (and handles) turn exactly; a ramp's too, but its width stays level (a ramp's surface is always
 *   level across), so a tilted ramp is only roughly one. A note's point orbits.
 */
export function tiltShape(shape: Shape, m: Mat3, pivot: Pivot3): ShapePatch {
  const round3 = (p: Pivot3) => ({ x: round2(p.x), y: round2(p.y), z: round2(p.z) });
  if (shape.type === "note") return round3(orbit3(m, pivot, shape));
  if (shape.type === "line" || shape.type === "ramp") {
    const turn = (o: { x: number; y?: number; z: number }) => {
      const r = apply(m, { x: o.x, y: o.y ?? 0, z: o.z });
      return shape.type === "ramp" ? { x: r.x, z: r.z } : r;
    };
    const points = shape.points.map((p) => ({
      ...p,
      ...orbit3(m, pivot, p),
      ...(p.in ? { in: turn(p.in) } : {}),
      ...(p.out ? { out: turn(p.out) } : {}),
    }));
    return { points: roundPoints(points) as LinePoint[] | RampPoint[] };
  }
  if (shape.type === "instance") {
    const o = toYXZ(mul(m, orientationYXZ(shape.rotation, shape.pitch ?? 0, shape.roll ?? 0)));
    return { ...round3(orbit3(m, pivot, shape)), rotation: round2(normalizeDeg(o.yaw)) % 360, pitch: tiltAngle(o.pitch), roll: tiltAngle(o.roll) };
  }
  if (shape.type === "array") return tiltArray(shape, m, pivot);
  if (isFootprinted(shape)) {
    const h = shape.height / 2;
    const c = orbit3(m, pivot, { x: shape.x, y: shape.y + h, z: shape.z });
    const o = toYXZ(mul(m, orientationYXZ(shape.rotation, shape.pitch ?? 0, shape.roll ?? 0)));
    return { x: round2(c.x), y: round2(c.y - h), z: round2(c.z), rotation: round2(normalizeDeg(o.yaw)) % 360, pitch: tiltAngle(o.pitch), roll: tiltAngle(o.roll) };
  }
  // A free-form: its center orbits, its tilt composes, and the turn inside it goes into its points.
  const center = freeformCenter(shape);
  const h = shape.height / 2;
  const c = orbit3(m, pivot, { x: center.x, y: shape.y + h, z: center.z });
  const o = toXZY(mul(m, tiltXZ(shape.pitch ?? 0, shape.roll ?? 0)));
  const r = (o.turn * Math.PI) / 180;
  const [cos, sin] = [Math.cos(r), Math.sin(r)];
  const spin = (v: Offset) => ({ x: v.x * cos + v.z * sin, z: -v.x * sin + v.z * cos });
  const points = shape.points.map((p) => {
    const l = spin({ x: p.x - center.x, z: p.z - center.z });
    return { ...p, x: c.x + l.x, z: c.z + l.z, ...(p.in ? { in: spin(p.in) } : {}), ...(p.out ? { out: spin(p.out) } : {}) };
  });
  // The outline's center after turning is where the center went (a turn about the center keeps it), up to rounding.
  return { points: roundPoints(points), y: round2(c.y - h), pitch: tiltAngle(o.pitch), roll: tiltAngle(o.roll) };
}

/**
 * A transform about one pivot (14.3): scale, then tilt (14.4: pitch and roll around the world's x and z axes, roll
 * first), then turn, then mirror, all about the pivot, then move.
 */
export type Transform = {
  pivot: Pivot3;
  scale?: number;
  tilt?: { pitch?: number; roll?: number };
  rotate?: number;
  mirror?: MirrorAxis;
  move?: { dx: number; dy: number; dz: number };
};

/** A shape with a transform applied (see `Transform`): the whole patch, from the shape as it is. */
export function transformShape(shape: Shape, t: Transform): ShapePatch {
  let s = shape;
  const step = (patch: ShapePatch) => {
    s = { ...s, ...patch } as Shape;
  };
  if (t.scale !== undefined && t.scale !== 1) step(scaleShape(s, t.scale, t.pivot));
  if (t.tilt && (t.tilt.pitch || t.tilt.roll)) step(tiltShape(s, tiltXZ(t.tilt.pitch ?? 0, t.tilt.roll ?? 0), t.pivot));
  if (t.rotate) step(rotateShape(s, t.pivot, t.rotate));
  if (t.mirror) step(mirrorShape(s, t.mirror, round2(2 * (t.mirror === "x" ? t.pivot.x : t.pivot.z))));
  if (t.move && (t.move.dx || t.move.dy || t.move.dz)) step(moveShape(s, t.move.dx, t.move.dy, t.move.dz));
  const patch: ShapePatch = {};
  for (const k of Object.keys(s) as (keyof ShapePatch)[]) {
    if ((s as ShapePatch)[k] !== (shape as ShapePatch)[k]) (patch as Record<string, unknown>)[k] = (s as ShapePatch)[k];
  }
  return patch;
}

/** 3D points (a line's, a ramp's, a path layout's) and their handles scaled about a pivot, rounded. */
export function scaledPoints3<P extends LinePoint | RampPoint>(points: P[], f: number, pivot: Pivot3): P[] {
  const h = (o: { x: number; y?: number; z: number }) => ({ x: o.x * f, ...(o.y !== undefined ? { y: o.y * f } : {}), z: o.z * f });
  return roundPoints(
    points.map((p) => ({
      ...p,
      x: pivot.x + (p.x - pivot.x) * f,
      y: pivot.y + (p.y - pivot.y) * f,
      z: pivot.z + (p.z - pivot.z) * f,
      ...(p.in ? { in: h(p.in) } : {}),
      ...(p.out ? { out: h(p.out) } : {}),
    })),
  ) as P[];
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
 * - A tilt reflects with it: on Z the pitch changes sign; on X the roll does (an odd-sided cylinder's pitch).
 * - A free-form isn't symmetric: each point reflects and its handles flip on that axis. The points keep their
 *   order (so their indices stay stable), which only reverses the outline's winding.
 */
export function mirrorShape(shape: Shape, axis: MirrorAxis, sum: number): ShapePatch {
  // A tilt reflects (14.4): on X the roll flips, on Z the pitch (a free-form's, an instance's, an array's).
  const flipTilt = (s: { pitch?: number; roll?: number }): ShapePatch => {
    const f = axis === "x" ? "roll" : "pitch";
    const v = s[f];
    return v ? { [f]: v === 180 ? 180 : -v } : {};
  };
  if (shape.type === "array") return { ...mirrorArray(shape, axis, sum), ...flipTilt(shape) };
  if (shape.type === "note") return axis === "x" ? { x: round2(sum - shape.x) } : { z: round2(sum - shape.z) };
  // An instance moves to its mirrored point and turns to face the mirrored way; the entity itself isn't flipped.
  if (shape.type === "instance") {
    return axis === "x"
      ? { x: round2(sum - shape.x), rotation: round2(normalizeDeg(180 - shape.rotation)) % 360, ...flipTilt(shape) }
      : { z: round2(sum - shape.z), rotation: round2(normalizeDeg(-shape.rotation)) % 360, ...flipTilt(shape) };
  }
  if (!isFootprinted(shape)) {
    const points: FootPoint[] = shape.points;
    const tilt = shape.type === "freeform" ? flipTilt(shape) : {};
    return axis === "x"
      ? { points: mapPoints(points, (p) => ({ x: sum - p.x, z: p.z }), (o) => ({ x: -o.x, z: o.z })), ...tilt }
      : { points: mapPoints(points, (p) => ({ x: p.x, z: sum - p.z }), (o) => ({ x: o.x, z: -o.z })), ...tilt };
  }
  const odd = shape.type === "cylinder" && shape.sides !== undefined && shape.sides % 2 === 1;
  const rotation = round2(normalizeDeg(axis === "x" && odd ? 180 - shape.rotation : -shape.rotation)) % 360;
  // A tilt reflects too: on Z the pitch flips; on X the roll flips, or for an odd-sided cylinder (turned a half
  // turn instead) the pitch.
  const flip = (a: number | undefined) => (a === undefined || a === 180 ? a : -a);
  const tilt: ShapePatch = {};
  const flipsPitch = axis === "z" || odd;
  if (shape.pitch !== undefined && flipsPitch) tilt.pitch = flip(shape.pitch);
  if (shape.roll !== undefined && !flipsPitch) tilt.roll = flip(shape.roll);
  return axis === "x" ? { x: round2(sum - shape.x), rotation, ...tilt } : { z: round2(sum - shape.z), rotation, ...tilt };
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

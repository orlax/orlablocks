import type { Box, BoxPatch } from "./scene.types";

/**
 * Pure shape geometry shared by the server (group moves and rotations) and the editor (picking, the marquee, the
 * gizmo, rendering). Ground coordinates are x/z; rotation is counterclockwise seen from above (a right-handed turn
 * about +y). Every closed shape reduces to a **footprint** polygon, and what's specific to a shape type (its
 * footprint, how it moves, turns and mirrors) is one function each here, so a new shape adds its own cases.
 */

/** A point on the ground. */
export type Point = { x: number; z: number };

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

/** 2 decimals, and never -0. */
export const round2 = (n: number) => Math.round(n * 100) / 100 + 0;
export const normalizeDeg = (deg: number) => ((deg % 360) + 360) % 360;

/** The box's local axes on the ground, in world x/z: `ex` along its width, `ez` along its depth. */
export function boxAxes(box: Box) {
  const a = (box.rotation * Math.PI) / 180;
  return { ex: { x: Math.cos(a), z: -Math.sin(a) }, ez: { x: Math.sin(a), z: Math.cos(a) } };
}

/** A world ground point in the box's frame (origin at its center, axes along width and depth). */
export function toBoxLocal(box: Box, p: { x: number; z: number }) {
  const { ex, ez } = boxAxes(box);
  const dx = p.x - box.x;
  const dz = p.z - box.z;
  return { x: dx * ex.x + dz * ex.z, z: dx * ez.x + dz * ez.z };
}

/** A point in the box's frame back in world x/z. */
export function fromBoxLocal(box: Box, l: { x: number; z: number }) {
  const { ex, ez } = boxAxes(box);
  return { x: box.x + l.x * ex.x + l.z * ez.x, z: box.z + l.x * ex.z + l.z * ez.z };
}

/**
 * The shape's footprint in its own frame (see `shapeFrame`): for a box its 4 corners around its center, going
 * (-x, -z), (+x, -z), (+x, +z), (-x, +z) in its own axes.
 */
export function localFootprint(box: Box): Point[] {
  const hw = box.width / 2;
  const hd = box.depth / 2;
  return [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd },
  ];
}

/** Where a shape's own frame sits in the world and how it's turned (degrees). `localFootprint` is in this frame. */
export const shapeFrame = (box: Box) => ({ x: box.x, z: box.z, rotation: box.rotation });

/** The shape's footprint in world x/z. */
export const footprint = (box: Box): Point[] => localFootprint(box).map((p) => fromBoxLocal(box, p));

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

/**
 * The polygon grown outward by `d` meters (negative shrinks it), with mitered corners, in either winding. Exact
 * for convex polygons (boxes); concave outlines will need a robust offset. Null if shrinking collapses it (an
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

/** The axis-aligned bounds of a box's (possibly rotated) footprint. */
export function footprintBounds(box: Box): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const a = (box.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const hx = (box.width * cos + box.depth * sin) / 2;
  const hz = (box.width * sin + box.depth * cos) / 2;
  return { minX: box.x - hx, maxX: box.x + hx, minZ: box.z - hz, maxZ: box.z + hz };
}

/** The axis-aligned box around all of `boxes` (at least one). */
export function boundsOf(boxes: Box[]): Bounds {
  const b: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const box of boxes) {
    const f = footprintBounds(box);
    b.minX = Math.min(b.minX, f.minX);
    b.maxX = Math.max(b.maxX, f.maxX);
    b.minZ = Math.min(b.minZ, f.minZ);
    b.maxZ = Math.max(b.maxZ, f.maxZ);
    b.minY = Math.min(b.minY, box.y);
    b.maxY = Math.max(b.maxY, box.y + box.height);
  }
  return b;
}

/**
 * A shape moved by an offset (2 decimals). Only the axes that move are in the patch, so a drag along x is a "move"
 * and not also an elevation change.
 */
export function moveShape(box: Box, dx: number, dy: number, dz: number): BoxPatch {
  const patch: BoxPatch = {};
  if (dx !== 0) patch.x = round2(box.x + dx);
  if (dy !== 0) patch.y = round2(box.y + dy);
  if (dz !== 0) patch.z = round2(box.z + dz);
  return patch;
}

/** A shape turned by `degrees` around the vertical axis through `pivot`: its center orbits the pivot and the angle adds to its rotation. */
export function rotateShape(box: Box, pivot: Point, degrees: number): BoxPatch {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = box.x - pivot.x;
  const dz = box.z - pivot.z;
  return {
    x: round2(pivot.x + dx * cos + dz * sin),
    z: round2(pivot.z - dx * sin + dz * cos),
    rotation: round2(normalizeDeg(box.rotation + degrees)) % 360,
  };
}

/** Turns shapes by `degrees` around the vertical axis through `pivot` (see `rotateShape`). Returns the patches. */
export function rotateAround(boxes: Box[], pivot: Point, degrees: number): Record<string, BoxPatch> {
  return Object.fromEntries(boxes.map((box) => [box.id, rotateShape(box, pivot, degrees)]));
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
 * One shape reflected across the plane where `axis` = sum / 2 (sum = twice the pivot). A box is symmetric, so only
 * its center and angle change: the center reflects and the rotation becomes -rotation. Shapes that aren't
 * symmetric (outlines, things that face a direction) need their own case.
 */
export function mirrorShape(box: Box, axis: MirrorAxis, sum: number): BoxPatch {
  const rotation = round2(normalizeDeg(-box.rotation)) % 360;
  return axis === "x" ? { x: round2(sum - box.x), rotation } : { z: round2(sum - box.z), rotation };
}

/**
 * Mirrors boxes on a world axis across the center of their combined footprint bounds, in place. Mirroring the
 * result again restores the original values exactly. Returns the patches.
 */
export function mirrorAcross(boxes: Box[], axis: MirrorAxis): Record<string, BoxPatch> {
  const b = boundsOf(boxes);
  const sum = round2HalfEven(axis === "x" ? b.minX + b.maxX : b.minZ + b.maxZ);
  return Object.fromEntries(boxes.map((box) => [box.id, mirrorShape(box, axis, sum)]));
}

import { ShapeUtils, Vector2 } from "three";
import { fromShapeLocal, isFootprinted, localFootprint, pointInPolygon, roomWalls, shapeFrame, signedArea2, type Point } from "./geometry";
import type { ClosedShape } from "./scene.types";

/**
 * Every closed shape as triangles: the one place a shape becomes a mesh. Rendering draws these meshes, and picking
 * and the marquee test against them, so a shape that isn't a straight prism (a taper, a bevel, a tilt) only needs
 * its own mesh here.
 */

/**
 * A triangle mesh: vertex positions (x, y, z per vertex) and triangles as index triples, each wound
 * counterclockwise seen from outside (three.js's front face). Faces share their vertices, so a closed mesh is
 * watertight.
 */
export type Mesh = { positions: number[]; indices: number[] };

/** A room's floor: a thin slab just above the room's bottom, so it hides the grid inside the room. */
export const FLOOR_THICKNESS = 0.04;

/** Rings (read as in `extrude`: wound like the first are solid, the others are holes) grouped into solids with their holes. */
function regions(rings: Point[][]): { outer: Point[]; holes: Point[][] }[] {
  const solid = Math.sign(signedArea2(rings[0]));
  const out = rings.filter((r) => Math.sign(signedArea2(r)) === solid).map((outer) => ({ outer, holes: [] as Point[][] }));
  for (const hole of rings.filter((r) => Math.sign(signedArea2(r)) !== solid)) {
    (out.find((s) => pointInPolygon(s.outer, hole[0])) ?? out[0]).holes.push(hole);
  }
  return out;
}

/** The ring wound so its region is on the left going around (positive area in x/z) or, for a hole, on the right. */
const wound = (ring: Point[], positive: boolean) => (signedArea2(ring) > 0 === positive ? ring : [...ring].reverse());

/**
 * A region on the ground (rings, see `regions`) extruded from y0 to y1: its top and bottom (triangulated) and one
 * quad per ring edge, sharing vertices. Null if there's nothing to extrude.
 */
export function prism(rings: Point[][], y0: number, y1: number): Mesh | null {
  const usable = rings.filter((r) => r.length >= 3 && Math.abs(signedArea2(r)) > 1e-12);
  if (usable.length === 0) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const { outer, holes } of regions(usable)) {
    // Solids go counterclockwise in x/z and holes the other way, so the solid is always on the left of an edge.
    const loops = [wound(outer, true), ...holes.map((h) => wound(h, false))];
    const bottom: number[][] = [];
    const top: number[][] = [];
    for (const loop of loops) {
      bottom.push(loop.map((p) => (positions.push(p.x, y0, p.z), positions.length / 3 - 1)));
      top.push(loop.map((p) => (positions.push(p.x, y1, p.z), positions.length / 3 - 1)));
    }
    // Caps: triangulated on the ground, then each triangle turned to face up (top) or down (bottom).
    const flatBottom = bottom.flat();
    const flatTop = top.flat();
    const faces = ShapeUtils.triangulateShape(
      loops[0].map((p) => new Vector2(p.x, p.z)),
      loops.slice(1).map((h) => h.map((p) => new Vector2(p.x, p.z))),
    );
    const all = loops.flat();
    for (const [a, b, c] of faces) {
      // The triangle's normal points up when it's clockwise in x/z (with y up, x × z points down).
      const up = signedArea2([all[a], all[b], all[c]]) < 0;
      indices.push(...(up ? [flatTop[a], flatTop[b], flatTop[c]] : [flatTop[a], flatTop[c], flatTop[b]]));
      indices.push(...(up ? [flatBottom[a], flatBottom[c], flatBottom[b]] : [flatBottom[a], flatBottom[b], flatBottom[c]]));
    }
    // Sides: the solid is on the left of each edge, so outward is to its right.
    for (let k = 0; k < loops.length; k++) {
      const n = loops[k].length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [bi, bj, ti, tj] = [bottom[k][i], bottom[k][j], top[k][i], top[k][j]];
        indices.push(bi, ti, tj, bi, tj, bj);
      }
    }
  }
  return { positions, indices };
}

/** Whether a triangle's normal points up (+y): it's clockwise in x/z, since with y up x × z points down. */
const facesUp = (a: Point, b: Point, c: Point) => signedArea2([a, b, c]) < 0;

/**
 * Rings with the same number of points stacked from the bottom up, point i of each above point i of the one below,
 * stitched with a quad per edge and capped at the bottom and the top. A ring can shrink to a line or a point (a
 * ridge, the tip of a cone): its points in the same place are welded into one vertex, the triangles that vanish are
 * dropped and a flat ring gets no cap, so the mesh stays watertight. All rings are read in the bottom ring's
 * winding.
 */
export function loft(stack: { ring: Point[]; y: number }[]): Mesh | null {
  const base = stack[0].ring;
  const area = signedArea2(base);
  if (base.length < 3 || Math.abs(area) < 1e-12) return null;
  // Counterclockwise in x/z, so the solid is on the left of each edge (as in `prism`).
  const rings = stack.map(({ ring, y }) => ({ ring: area > 0 ? ring : [...ring].reverse(), y }));
  const positions: number[] = [];
  const indices: number[] = [];
  const levels = rings.map(({ ring, y }) => {
    const welded = new Map<string, number>();
    return ring.map((p) => {
      const key = `${Math.round(p.x * 1e7)},${Math.round(p.z * 1e7)}`;
      let i = welded.get(key);
      if (i === undefined) {
        i = positions.length / 3;
        positions.push(p.x, y, p.z);
        welded.set(key, i);
      }
      return i;
    });
  });
  const tri = (a: number, b: number, c: number) => {
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  };
  const n = base.length;
  for (let k = 0; k + 1 < levels.length; k++) {
    const [lo, hi] = [levels[k], levels[k + 1]];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(lo[i], hi[i], hi[j]);
      tri(lo[i], hi[j], lo[j]);
    }
  }
  const capOf = (ring: Point[], idx: number[], up: boolean) => {
    if (Math.abs(signedArea2(ring)) < 1e-9) return;
    for (const [a, b, c] of ShapeUtils.triangulateShape(ring.map((p) => new Vector2(p.x, p.z)), [])) {
      const ok = facesUp(ring[a], ring[b], ring[c]) === up;
      if (ok) tri(idx[a], idx[b], idx[c]);
      else tri(idx[a], idx[c], idx[b]);
    }
  };
  capOf(rings[0].ring, levels[0], false);
  capOf(rings.at(-1)!.ring, levels.at(-1)!, true);
  return { positions, indices };
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
 * A flat region at height y (a room's floor, for picking): a prism with no height. Its sides are empty triangles
 * and its bottom repeats its top, which a ray test and the marquee don't mind.
 */
const cap = (rings: Point[][], y: number): Mesh | null => prism(rings, y, y);

/** The parts a closed shape is drawn with, in its own frame (see `shapeFrame`), from 0 (its elevation) up. */
export type ShapeParts = {
  /** A volume's solid, or a room's walls. */
  body: Mesh | null;
  /** A room's floor slab. */
  floor: Mesh | null;
};

const partsCache = new WeakMap<ClosedShape, ShapeParts>();

/**
 * A closed shape's meshes in its own frame: a volume is its footprint extruded to its height (tapered and beveled,
 * see `volumeRings`); a room is its walls
 * (see `roomWalls`) plus a floor slab, with no ceiling. An outline with no area (a preview can have one) gives no
 * meshes. Cached per shape object.
 */
export function shapeMesh(shape: ClosedShape): ShapeParts {
  const cached = partsCache.get(shape);
  if (cached) return cached;
  const outline = localFootprint(shape);
  let parts: ShapeParts;
  if (Math.abs(signedArea2(outline)) < 1e-9) parts = { body: null, floor: null };
  else if (shape.kind === "volume") parts = { body: loft(volumeRings(shape)), floor: null };
  else parts = { body: prism(roomWalls(shape).walls, 0, shape.height), floor: prism([outline], 0, FLOOR_THICKNESS) };
  partsCache.set(shape, parts);
  return parts;
}

/** A mesh with its axis-aligned bounds, for a quick reject before testing triangles. */
export type BoundedMesh = Mesh & { min: [number, number, number]; max: [number, number, number] };

const worldCache = new WeakMap<ClosedShape, BoundedMesh | null>();

/**
 * What a click or the marquee can hit, in world coordinates: the body, plus a room's floor at its elevation (so a
 * point picked on a floor is on the ground the room stands on, not on top of the slab). Cached per shape object.
 */
export function hitMesh(shape: ClosedShape): BoundedMesh | null {
  if (worldCache.has(shape)) return worldCache.get(shape)!;
  const { body } = shapeMesh(shape);
  const floor = shape.kind === "room" && body ? cap([localFootprint(shape)], 0) : null;
  const frame = shapeFrame(shape);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const m of [body, floor]) {
    if (!m) continue;
    const base = positions.length / 3;
    for (let i = 0; i < m.positions.length; i += 3) {
      const w = fromShapeLocal(frame, { x: m.positions[i], z: m.positions[i + 2] });
      positions.push(w.x, m.positions[i + 1] + shape.y, w.z);
    }
    indices.push(...m.indices.map((i) => i + base));
  }
  let result: BoundedMesh | null = null;
  if (indices.length > 0) {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], positions[i]);
      max[i % 3] = Math.max(max[i % 3], positions[i]);
    }
    result = { positions, indices, min, max };
  }
  worldCache.set(shape, result);
  return result;
}

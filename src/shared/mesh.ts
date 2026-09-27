import { ShapeUtils, Vector2 } from "three";
import { fromShapeLocal, localFootprint, pointInPolygon, roomWalls, shapeFrame, signedArea2, type Point } from "./geometry";
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
 * A closed shape's meshes in its own frame: a volume is its footprint extruded to its height; a room is its walls
 * (see `roomWalls`) plus a floor slab, with no ceiling. An outline with no area (a preview can have one) gives no
 * meshes. Cached per shape object.
 */
export function shapeMesh(shape: ClosedShape): ShapeParts {
  const cached = partsCache.get(shape);
  if (cached) return cached;
  const outline = localFootprint(shape);
  let parts: ShapeParts;
  if (Math.abs(signedArea2(outline)) < 1e-9) parts = { body: null, floor: null };
  else if (shape.kind === "volume") parts = { body: prism([outline], 0, shape.height), floor: null };
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

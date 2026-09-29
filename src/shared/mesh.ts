import { ShapeUtils, Vector2 } from "three";
import { localFootprint, pointInPolygon, rampBottom, rampPointDistances, rampStations, roomWalls, signedArea2, toWorld3, volumeRings, type Point } from "./geometry";
import type { ClosedShape, Ramp, Solid } from "./scene.types";

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

/**
 * A flat region at height y (a room's floor, for picking): a prism with no height. Its sides are empty triangles
 * and its bottom repeats its top, which a ray test and the marquee don't mind.
 */
const cap = (rings: Point[][], y: number): Mesh | null => prism(rings, y, y);

/**
 * A ramp as one closed solid, in world coordinates. Seen from the side, it's a profile over the distance s along its
 * path: the walking surface on top (sloped, or flat treads with vertical risers for a stepped ramp) and its
 * underside (flat just below its lowest point, or a slab under the slope). That profile is cut into vertical columns
 * (at every station along the path and every riser), each side of the ramp is zipped column by column, and the
 * profile's outline is swept across the width, so curves bend and the mesh is watertight.
 *
 * Steps: an edge rising `rise` gets n = max(1, round(|rise| / step)) equal steps with equal treads. Seen from its
 * lower end, the first riser is at the start and the last tread is flush with the higher end, going either way.
 */
export function rampMesh(ramp: Ramp): Mesh | null {
  const st = rampStations(ramp);
  const pts = ramp.points;
  const total = st.at(-1)!.s;
  if (total <= 0) return null;
  // How far along the path each point is: edge i runs from edgeS[i] to edgeS[i + 1].
  const edgeS = rampPointDistances(ramp);
  // The top at distance s, just before (`from` -1) or just after (+1) s: a stepped edge's tread, or the smooth slope.
  const smoothAt = (s: number) => {
    let k = 0;
    while (k + 1 < st.length && st[k + 1].s < s) k++;
    const [a, b] = [st[k], st[Math.min(k + 1, st.length - 1)]];
    const f = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    return a.y + (b.y - a.y) * Math.max(0, Math.min(1, f));
  };
  const risers: number[] = [];
  const topAt = (s: number, side: -1 | 1): number => {
    let i = 0;
    // Tolerances well above the rounding of `cuts` (1e-7), so a riser or a point is never read as the wrong side.
    while (i + 2 < pts.length && (side < 0 ? edgeS[i + 1] < s - 1e-6 : edgeS[i + 1] <= s + 1e-6)) i++;
    const [y0, y1] = [pts[i].y, pts[i + 1].y];
    const rise = y1 - y0;
    if (ramp.step === undefined || Math.abs(rise) < 1e-9) return smoothAt(s);
    const n = Math.max(1, Math.round(Math.abs(rise) / ramp.step));
    const len = edgeS[i + 1] - edgeS[i];
    const f = len > 0 ? (s - edgeS[i]) / len : 0;
    // Which tread s is on, seen from the side asked for (a riser belongs to both).
    let k = Math.floor(f * n + (side < 0 ? -1e-6 : 1e-6));
    k = Math.max(0, Math.min(n - 1, k));
    return rise > 0 ? y0 + (rise * (k + 1)) / n : y0 + (rise * k) / n;
  };
  if (ramp.step !== undefined) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const rise = pts[i + 1].y - pts[i].y;
      if (Math.abs(rise) < 1e-9) continue;
      const n = Math.max(1, Math.round(Math.abs(rise) / ramp.step));
      for (let k = 1; k < n; k++) risers.push(edgeS[i] + ((edgeS[i + 1] - edgeS[i]) * k) / n);
    }
  }
  // The columns: every station and every riser, in order, with the edges there (interpolated between stations).
  const cuts = [...new Set([...st.map((p) => p.s), ...risers, ...edgeS].map((v) => Math.round(v * 1e7) / 1e7))].sort((a, b) => a - b);
  const edgesAt = (s: number) => {
    let k = 0;
    while (k + 1 < st.length && st[k + 1].s < s - 1e-9) k++;
    const [a, b] = [st[k], st[Math.min(k + 1, st.length - 1)]];
    const f = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0;
    const lerp = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f });
    return { left: lerp(a.left, b.left), right: lerp(a.right, b.right) };
  };
  const positions: number[] = [];
  const indices: number[] = [];
  // Each column's heights, bottom first, each with a vertex on the left and on the right.
  const columns = cuts.map((s, c) => {
    const bottom = rampBottom(ramp, { y: smoothAt(s) });
    const before = c > 0 ? topAt(s, -1) : null;
    const after = c + 1 < cuts.length ? topAt(s, 1) : null;
    const ys = [...new Set([bottom, before, after].filter((y): y is number => y !== null).map((y) => Math.round(y * 1e7) / 1e7))].sort((a, b) => a - b);
    const e = edgesAt(s);
    const vs = ys.map((y) => {
      const l = positions.length / 3;
      positions.push(e.left.x, y, e.left.z, e.right.x, y, e.right.z);
      return { y, l, r: l + 1 };
    });
    return { s, vs, before, after, bottom };
  });
  const tri = (a: number, b: number, c: number) => {
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  };
  // The sides, strip by strip: between column c and c + 1, the vertices on each column up to the strip's top there,
  // zipped from the bottom up.
  for (let c = 0; c + 1 < columns.length; c++) {
    const [A, B] = [columns[c], columns[c + 1]];
    // (The vertices' heights are rounded to 1e-7, the tops aren't: compare with a tolerance above that rounding.)
    const la = A.vs.filter((v) => v.y <= (A.after ?? A.bottom) + 1e-6);
    const lb = B.vs.filter((v) => v.y <= (B.before ?? B.bottom) + 1e-6);
    for (const side of ["l", "r"] as const) {
      let [i, j] = [0, 0];
      while (i + 1 < la.length || j + 1 < lb.length) {
        const nextA = i + 1 < la.length ? la[i + 1].y : Infinity;
        const nextB = j + 1 < lb.length ? lb[j + 1].y : Infinity;
        if (nextA <= nextB) {
          if (side === "l") tri(la[i].l, lb[j].l, la[i + 1].l);
          else tri(la[i].r, la[i + 1].r, lb[j].r);
          i++;
        } else {
          if (side === "l") tri(la[i].l, lb[j].l, lb[j + 1].l);
          else tri(la[i].r, lb[j + 1].r, lb[j].r);
          j++;
        }
      }
    }
  }
  // The outline of the profile, swept across the width: up the start, along the top (with its risers), down the
  // end, and back along the bottom.
  const loop: { l: number; r: number }[] = [];
  const first = columns[0];
  loop.push(...first.vs);
  for (let c = 1; c < columns.length; c++) {
    const col = columns[c];
    const top = (y: number | null) => col.vs.find((v) => y !== null && Math.abs(v.y - y) < 1e-6);
    const bt = top(col.before);
    const at = top(col.after);
    if (c + 1 < columns.length) {
      if (bt) loop.push(bt);
      if (at && at !== bt) {
        // A riser: every vertex on the column between the two treads.
        const [lo, hi] = [Math.min(bt!.y, at.y), Math.max(bt!.y, at.y)];
        const between = col.vs.filter((v) => v.y > lo + 1e-9 && v.y < hi - 1e-9);
        loop.push(...(at.y > bt!.y ? between : [...between].reverse()), at);
      }
    } else loop.push(...[...col.vs].reverse());
  }
  for (let c = columns.length - 2; c > 0; c--) loop.push(columns[c].vs[0]);
  for (let k = 0; k < loop.length; k++) {
    const [p, q] = [loop[k], loop[(k + 1) % loop.length]];
    if (p === q) continue;
    tri(p.l, q.l, q.r);
    tri(p.l, q.r, p.r);
  }
  // Wind every triangle outward: flip them all if the volume came out negative.
  if (signedVolume(positions, indices) < 0) {
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  }
  return { positions, indices };
}

/** A closed mesh's signed volume: positive when its triangles face outward. */
export function signedVolume(p: number[], idx: number[]): number {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** The parts a closed shape is drawn with, in its own frame (see `shapeFrame`), from 0 (its elevation) up. */
export type ShapeParts = {
  /** A volume's solid, or a room's walls. */
  body: Mesh | null;
  /** A room's floor slab. */
  floor: Mesh | null;
};

const partsCache = new WeakMap<Solid, ShapeParts>();

/**
 * A closed shape's meshes in its own frame: a volume (or a hole) is its footprint extruded to its height (tapered and beveled,
 * see `volumeRings`); a room is its walls
 * (see `roomWalls`) plus a floor slab, with no ceiling. An outline with no area (a preview can have one) gives no
 * meshes. A ramp is its `rampMesh` (in world coordinates: its frame is the world's). Cached per shape object.
 */
export function shapeMesh(shape: Solid): ShapeParts {
  const cached = partsCache.get(shape);
  if (cached) return cached;
  if (shape.type === "ramp") {
    const parts = { body: rampMesh(shape), floor: null };
    partsCache.set(shape, parts);
    return parts;
  }
  const outline = localFootprint(shape);
  let parts: ShapeParts;
  if (Math.abs(signedArea2(outline)) < 1e-9) parts = { body: null, floor: null };
  else if (shape.kind !== "room") parts = { body: loft(volumeRings(shape)), floor: null };
  else parts = { body: prism(roomWalls(shape).walls, 0, shape.height), floor: prism([outline], 0, FLOOR_THICKNESS) };
  partsCache.set(shape, parts);
  return parts;
}

/** A mesh with its axis-aligned bounds, for a quick reject before testing triangles. */
export type BoundedMesh = Mesh & { min: [number, number, number]; max: [number, number, number] };

const worldCache = new WeakMap<Solid, BoundedMesh | null>();

/**
 * What a click or the marquee can hit, in world coordinates (tilted, turned and moved with the shape): the body, plus a room's floor at its elevation (so a
 * point picked on a floor is on the ground the room stands on, not on top of the slab). Cached per shape object.
 */
export function hitMesh(shape: Solid): BoundedMesh | null {
  if (worldCache.has(shape)) return worldCache.get(shape)!;
  const { body } = shapeMesh(shape);
  const floor = shape.kind === "room" && body ? cap([localFootprint(shape)], 0) : null;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const m of [body, floor]) {
    if (!m) continue;
    const base = positions.length / 3;
    for (let i = 0; i < m.positions.length; i += 3) {
      const w = toWorld3(shape, { x: m.positions[i], y: m.positions[i + 1], z: m.positions[i + 2] });
      positions.push(w.x, w.y, w.z);
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

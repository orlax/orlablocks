import {
  footprint,
  fromShapeLocal,
  isClosed,
  isFootprinted,
  isTilted,
  localFootprint,
  normalizeDeg,
  offsetPolygon,
  offsetRings,
  pointInPolygon,
  polyline,
  rampStations,
  round2,
  roundPoints,
  sampleEdge3,
  sampleOutline,
  shapeAxes,
  shapeFrame,
  signedArea2,
  toFreeformPoints,
  volumeRings,
  wallOf,
  type MirrorAxis,
  type Point,
  type Point3,
} from "./geometry";
import {
  MAX_ARRAY_ITEMS,
  type ArrayFacing,
  type ArrayLayout,
  type ArrayNode,
  type ClosedShape,
  type FootPoint,
  type Follow,
  type LinePoint,
  type SceneNode,
  type Shape,
  type ShapePatch,
} from "./scene.types";

/** Whether an array follows another node (its path is that node's). */
export const isFollowing = (n: SceneNode): n is ArrayNode & { layout: { type: "path"; along: Follow } } => n.type === "array" && n.layout.type === "path" && !!n.layout.along;

/**
 * Arrays (plan 10 §4): where an array's items go, as one pure function of the array, and how moving, turning and
 * mirroring an array change its layout. An item is an instance's place: an entity, a point (its pivot, the entity's
 * bottom center) and a turn (degrees, counterclockwise seen from above; at 0 the entity shows as drawn).
 *
 * Every item's randomness (its entity among several, its noise) comes from a hash of the seed, its index and a
 * channel, not from a running sequence, so adding items to a path leaves the others as they were.
 */

export type ArrayItem = { index: number; entity: string; x: number; y: number; z: number; rotation: number };

/** A pose on the layout, before the array's turn and noise: where, and the facing's turn there. */
type Pose = { x: number; y: number; z: number; facing: number };

/** The facing an array uses: its own, or its layout's default (along a path, tangent on a circle, fixed on a grid). */
export function facingOf(array: Pick<ArrayNode, "facing" | "layout">): ArrayFacing {
  if (array.facing) return array.facing;
  return array.layout.type === "path" ? "along" : array.layout.type === "circle" ? "tangent" : "fixed";
}

/** A number in [0, 1) from the seed, an item's index and a channel (0 the entity, 1–2 the jitter, 3 the turn). */
export function hash01(seed: number, index: number, channel: number): number {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b) ^ Math.imul(channel + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The turn (degrees) that points an entity's local +x along a ground direction. */
const turnToward = (dx: number, dz: number) => (Math.atan2(-dz, dx) * 180) / Math.PI;

/** A path as a 3D polyline: every edge sampled, then its last point (a closed path ends back at its first). */
function samplePath(points: LinePoint[], closed: boolean) {
  const pts: Point3[] = [];
  const edge: number[] = [];
  const edges = closed ? points.length : points.length - 1;
  for (let i = 0; i < edges; i++) {
    const samples = sampleEdge3(points[i], points[(i + 1) % points.length]);
    pts.push(...samples);
    edge.push(...samples.map(() => i));
  }
  const end = closed ? points[0] : points[points.length - 1];
  pts.push({ x: end.x, y: end.y, z: end.z });
  // The distance along the path to each vertex.
  const at = [0];
  for (let k = 1; k < pts.length; k++) at.push(at[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y, pts[k].z - pts[k - 1].z));
  return { pts, edge, at, length: at[at.length - 1] };
}

/** The ground direction of the path's segment k, or of the nearest one that has one (a vertical stretch has none). */
function directionAt(pts: Point3[], k: number): Point | null {
  for (let d = 0; d < pts.length; d++) {
    for (const j of [k + d, k - d]) {
      if (j < 0 || j + 1 >= pts.length) continue;
      const dx = pts[j + 1].x - pts[j].x;
      const dz = pts[j + 1].z - pts[j].z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-9) return { x: dx / len, z: dz / len };
    }
  }
  return null;
}

/** How many items a path layout places, before the cap: from its length and how it places them. */
function pathCount(layout: Extract<ArrayLayout, { type: "path" }>, length: number): number {
  const closed = !!layout.closed;
  const edges = closed ? layout.points.length : layout.points.length - 1;
  switch (layout.place) {
    case "corners":
      return layout.points.length;
    case "midpoints":
      return edges;
    case "count":
      return layout.count ?? 1;
    case "spacing": {
      if (length < 1e-9) return 1;
      const gaps = Math.max(1, Math.round(length / (layout.spacing ?? 1)));
      return closed ? gaps : gaps + 1;
    }
  }
}

function pathPoses(layout: Extract<ArrayLayout, { type: "path" }>, limit: number): { poses: Pose[]; total: number } {
  const closed = !!layout.closed;
  const { pts, edge, at, length } = samplePath(layout.points, closed);
  const total = pathCount(layout, length);
  const n = Math.min(total, limit);
  const poseAtDistance = (d: number): Pose => {
    let k = 0;
    while (k + 2 < pts.length && at[k + 1] < d) k++;
    const span = at[k + 1] - at[k];
    const t = span > 1e-9 ? Math.min(1, Math.max(0, (d - at[k]) / span)) : 0;
    const [a, b] = [pts[k], pts[k + 1] ?? pts[k]];
    const dir = directionAt(pts, k);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, facing: dir ? turnToward(dir.x, dir.z) : 0 };
  };
  // Where each edge starts and ends along the path.
  const edgeStart = (i: number) => at[edge.indexOf(i)];
  const edgeEnd = (i: number) => (edge.lastIndexOf(i) + 1 < at.length ? at[edge.lastIndexOf(i) + 1] : length);
  const poses: Pose[] = [];
  if (layout.place === "corners") {
    for (let i = 0; i < n; i++) {
      const p = layout.points[i];
      // Facing along the bisector of the edges in and out (an open path's ends have one of them).
      const k = edge.indexOf(i);
      const out = k >= 0 ? directionAt(pts, k) : null;
      const kin = closed ? edge.lastIndexOf((i - 1 + layout.points.length) % layout.points.length) : edge.lastIndexOf(i - 1);
      const inn = kin >= 0 ? directionAt(pts, kin) : null;
      const dir = out && inn ? { x: out.x + inn.x, z: out.z + inn.z } : (out ?? inn);
      const facing = dir && Math.hypot(dir.x, dir.z) > 1e-9 ? turnToward(dir.x, dir.z) : out ? turnToward(out.x, out.z) : 0;
      poses.push({ x: p.x, y: p.y, z: p.z, facing });
    }
  } else if (layout.place === "midpoints") {
    for (let i = 0; i < n; i++) poses.push(poseAtDistance((edgeStart(i) + edgeEnd(i)) / 2));
  } else {
    const gaps = closed ? total : total - 1;
    for (let i = 0; i < n; i++) poses.push(poseAtDistance(gaps > 0 ? (length * i) / gaps : 0));
  }
  return { poses, total };
}

/** The angle of a circle's item i (degrees), and the angle the whole set spans. */
export function circleAngles(layout: Extract<ArrayLayout, { type: "circle" }>) {
  const sweep = layout.sweep ?? 360;
  const start = layout.start ?? 0;
  const step = layout.count <= 1 ? 0 : sweep >= 360 ? 360 / layout.count : sweep / (layout.count - 1);
  return { start, step, span: step * (layout.count - 1) };
}

/** A seeded stream of numbers in [0, 1) (mulberry32). */
function stream(seed: number): () => number {
  let a = (seed ^ 0x5bd1e995) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many tries scattering gets per item, before it settles for fewer items. */
const SCATTER_TRIES = 30;

/**
 * A scatter's poses (10.2): dart throwing from the seed's stream. Candidates are drawn in the circle, or in the
 * area's bounds in the scatter's own (turned) frame, and kept when inside the area and at least `minDistance` from
 * every kept one, until there are `count` or the tries run out. The stream doesn't depend on the count, so a larger
 * count keeps the earlier items; drawing in the frame means moving or turning the scatter moves or turns the same
 * pattern.
 */
function scatterPoses(layout: Extract<ArrayLayout, { type: "scatter" }>, limit: number, seed: number): Pose[] {
  const n = Math.min(layout.count, limit);
  const g = layout.rotation ?? 0;
  const { ex, ez } = shapeAxes({ rotation: g });
  const min = layout.minDistance ?? 0;
  const next = stream(seed);
  const polygon = layout.area ? sampleOutline(layout.area).polygon : null;
  const us = polygon?.map((p) => p.x * ex.x + p.z * ex.z) ?? [];
  const vs = polygon?.map((p) => p.x * ez.x + p.z * ez.z) ?? [];
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const candidate = (): Point | null => {
    const [a, b] = [next(), next()];
    if (polygon) {
      const [u, v] = [u0 + a * (u1 - u0), v0 + b * (v1 - v0)];
      const p = { x: u * ex.x + v * ez.x, z: u * ex.z + v * ez.z };
      return pointInPolygon(polygon, p) ? p : null;
    }
    const r = (layout.radius ?? 0) * Math.sqrt(a);
    const t = b * 2 * Math.PI;
    const [lu, lv] = [Math.cos(t) * r, Math.sin(t) * r];
    return { x: (layout.x ?? 0) + lu * ex.x + lv * ez.x, z: (layout.z ?? 0) + lu * ex.z + lv * ez.z };
  };
  // Kept points by grid cell (a cell is minDistance wide), so each check looks at the 9 cells around.
  const cells = new Map<string, Point[]>();
  const cell = (p: Point) => [Math.floor(p.x / min), Math.floor(p.z / min)];
  const clear = (p: Point) => {
    if (min <= 0) return true;
    const [cx, cz] = cell(p);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of cells.get(`${cx + i},${cz + j}`) ?? []) if (Math.hypot(q.x - p.x, q.z - p.z) < min) return false;
    return true;
  };
  const poses: Pose[] = [];
  for (let tries = 0; poses.length < n && tries < SCATTER_TRIES * Math.max(n, 10); tries++) {
    const p = candidate();
    if (!p || !clear(p)) continue;
    poses.push({ x: p.x, y: layout.y, z: p.z, facing: g });
    if (min > 0) {
      const key = cell(p).join(",");
      cells.set(key, [...(cells.get(key) ?? []), p]);
    }
  }
  return poses;
}

function layoutPoses(layout: ArrayLayout, limit: number, seed = 1): { poses: Pose[]; total: number } {
  if (layout.type === "path") return pathPoses(layout, limit);
  if (layout.type === "scatter") return { poses: scatterPoses(layout, limit, seed), total: layout.count };
  if (layout.type === "circle") {
    const { start, step } = circleAngles(layout);
    const n = Math.min(layout.count, limit);
    const poses = Array.from({ length: n }, (_, i) => {
      const a = start + step * i;
      const r = (a * Math.PI) / 180;
      // The facing here is the angle itself (out); tangent and in are turned from it below.
      return { x: layout.x + Math.cos(r) * layout.radius, y: layout.y, z: layout.z - Math.sin(r) * layout.radius, facing: a };
    });
    return { poses, total: layout.count };
  }
  const { columns, rows } = layout;
  const layers = layout.layers ?? 1;
  const total = columns * rows * layers;
  const g = layout.rotation ?? 0;
  const { ex, ez } = shapeAxes({ rotation: g });
  const poses: Pose[] = [];
  for (let l = 0; l < layers && poses.length < limit; l++) {
    for (let r = 0; r < rows && poses.length < limit; r++) {
      for (let c = 0; c < columns && poses.length < limit; c++) {
        const u = (c - (columns - 1) / 2) * layout.spacing.x + (layout.stagger && r % 2 === 1 ? layout.spacing.x / 2 : 0);
        const v = (r - (rows - 1) / 2) * layout.spacing.z;
        poses.push({ x: layout.x + u * ex.x + v * ez.x, y: layout.y + l * (layout.spacing.y ?? 0), z: layout.z + u * ex.z + v * ez.z, facing: g });
      }
    }
  }
  return { poses, total };
}

/** The facing's turn for a pose: what the layout gives, read for the array's facing. */
function facingTurn(layout: ArrayLayout, facing: ArrayFacing, pose: Pose, random: () => number): number {
  if (facing === "random") return random() * 360;
  if (layout.type === "circle") {
    if (facing === "tangent" || facing === "along") return pose.facing + 90;
    if (facing === "out") return pose.facing;
    if (facing === "in") return pose.facing + 180;
    return 0;
  }
  if (layout.type === "path") return facing === "along" || facing === "tangent" ? pose.facing : 0;
  // A grid's and a scatter's items turn with their frame.
  return pose.facing;
}

/** Picks an entity by weight, from a number in [0, 1). */
function pickEntity(entities: ArrayNode["entities"], u: number): string {
  if (entities.length === 1) return entities[0].entity;
  const total = entities.reduce((sum, e) => sum + (e.weight ?? 1), 0);
  let at = u * total;
  for (const e of entities) {
    at -= e.weight ?? 1;
    if (at < 0) return e.entity;
  }
  return entities[entities.length - 1].entity;
}

const itemsCache = new WeakMap<ArrayNode, { items: ArrayItem[]; total: number; made: number }>();

/**
 * An array's items, skipped ones left out, rounded to 2 decimals; how many its layout asks for (`total`, which can be
 * past MAX_ARRAY_ITEMS, when only that many are made); and how many were made before skipping (`made`: fewer than
 * `total` past the cap, or when a scatter can't fit them all). Cached per array object.
 */
export function arrayLayout(array: ArrayNode): { items: ArrayItem[]; total: number; made: number } {
  const hit = itemsCache.get(array);
  if (hit) return hit;
  const seed = array.seed ?? 1;
  const { poses, total } = layoutPoses(array.layout, MAX_ARRAY_ITEMS, seed);
  const facing = facingOf(array);
  const skip = new Set(array.skip ?? []);
  const items: ArrayItem[] = [];
  poses.forEach((pose, index) => {
    if (skip.has(index)) return;
    const u = (channel: number) => hash01(seed, index, channel);
    let { x, z } = pose;
    if (array.jitter) {
      const r = array.jitter * Math.sqrt(u(1));
      const a = u(2) * 2 * Math.PI;
      x += Math.cos(a) * r;
      z += Math.sin(a) * r;
    }
    const turn = facingTurn(array.layout, facing, pose, () => u(4)) + (array.rotation ?? 0) + (array.turnJitter ? (u(3) * 2 - 1) * array.turnJitter : 0);
    items.push({
      index,
      entity: pickEntity(array.entities, u(0)),
      x: round2(x),
      y: round2(pose.y),
      z: round2(z),
      rotation: round2(normalizeDeg(turn)) % 360,
    });
  });
  const result = { items, total, made: poses.length };
  itemsCache.set(array, result);
  return result;
}

/** Why an array has fewer items than its layout asks for (past the cap, or a scatter that can't fit), or null. */
export function arrayShortfall(array: ArrayNode): string | null {
  const { total, made } = arrayLayout(array);
  if (made >= total) return null;
  if (array.layout.type === "scatter" && made < Math.min(total, MAX_ARRAY_ITEMS)) {
    return `${made} of ${total} fit ${array.layout.minDistance ?? 0} m apart: lower minDistance or grow the area`;
  }
  return `its layout places ${total} items, but an array makes at most ${MAX_ARRAY_ITEMS}: widen its spacing or shrink it`;
}

export const arrayItems = (array: ArrayNode): ArrayItem[] => arrayLayout(array).items;

/** A layout in a few words: `path, every 1.2 m`, `loop, 5 evenly`, `circle r 9.4, arc 180°`, `grid 3 × 2 × 2`. */
export function describeLayout(layout: ArrayLayout): string {
  if (layout.type === "path") {
    const how =
      layout.place === "spacing" ? `every ${layout.spacing} m` : layout.place === "count" ? `${layout.count} evenly` : layout.place === "corners" ? "on its corners" : "mid-edge";
    if (layout.along) return `along ${layout.along.id}${layout.along.at === "bottom" ? " (bottom)" : ""}, ${how}`;
    return `${layout.closed ? "loop" : "path"}, ${how}`;
  }
  if (layout.type === "circle") return `circle r ${layout.radius}${layout.sweep !== undefined ? `, arc ${layout.sweep}°` : ""}`;
  if (layout.type === "scatter") return `scattered in ${layout.area ? "an area" : `a circle r ${layout.radius}`}${layout.minDistance ? `, ${layout.minDistance} m apart` : ""}`;
  return `grid ${layout.columns} × ${layout.rows}${layout.layers ? ` × ${layout.layers}` : ""}${layout.stagger ? ", staggered" : ""}`;
}

/** The ground points a layout covers (its path, its circle's points, its grid's corners): an empty array's bounds. */
export function layoutPoints(layout: ArrayLayout): Point3[] {
  if (layout.type === "path") return samplePath(layout.points, !!layout.closed).pts;
  if (layout.type === "scatter" && layout.area) return sampleOutline(layout.area).polygon.map((p) => ({ ...p, y: layout.y }));
  if (layout.type === "circle" || layout.type === "scatter") {
    const [x, z, r] = [layout.x ?? 0, layout.z ?? 0, layout.radius ?? 0];
    return Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * 2 * Math.PI;
      return { x: x + Math.cos(a) * r, y: layout.y, z: z - Math.sin(a) * r };
    });
  }
  return layoutPoses({ ...layout, layers: 1 }, MAX_ARRAY_ITEMS).poses.map((p) => ({ x: p.x, y: p.y, z: p.z }));
}

/**
 * A selected array's layout as a guide to draw (a thin dashed line): its path (closed back to its first point), its
 * circle or arc, or its grid's outline through the outer items.
 */
export function layoutGuide(layout: ArrayLayout): LinePoint[] {
  if (layout.type === "path") return layout.closed ? [...layout.points, { ...layout.points[0] }] : layout.points;
  if (layout.type === "scatter") {
    if (layout.area) {
      return [...layout.area, layout.area[0]].map(
        (p): LinePoint => ({
          x: p.x,
          y: layout.y,
          z: p.z,
          ...(p.in ? { in: { x: p.in.x, y: 0, z: p.in.z } } : {}),
          ...(p.out ? { out: { x: p.out.x, y: 0, z: p.out.z } } : {}),
        }),
      );
    }
    return layoutGuide({ type: "circle", x: layout.x ?? 0, y: layout.y, z: layout.z ?? 0, radius: layout.radius ?? 0, count: 1 });
  }
  if (layout.type === "circle") {
    const { start } = circleAngles(layout);
    const sweep = layout.sweep ?? 360;
    const n = Math.max(8, Math.ceil(sweep / 7.5));
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = ((start + (sweep * i) / n) * Math.PI) / 180;
      return { x: round2(layout.x + Math.cos(a) * layout.radius), y: layout.y, z: round2(layout.z - Math.sin(a) * layout.radius) };
    });
  }
  const { ex, ez } = shapeAxes({ rotation: layout.rotation ?? 0 });
  // The outer items' pivots, in the grid's own axes (a staggered row reaches half a column further).
  const u0 = -((layout.columns - 1) / 2) * layout.spacing.x;
  const u1 = -u0 + (layout.stagger && layout.rows > 1 ? layout.spacing.x / 2 : 0);
  const hv = ((layout.rows - 1) / 2) * layout.spacing.z;
  const at = (u: number, v: number) => ({ x: round2(layout.x + u * ex.x + v * ez.x), y: layout.y, z: round2(layout.z + u * ex.z + v * ez.z) });
  const corners = [at(u0, -hv), at(u1, -hv), at(u1, hv), at(u0, hv)];
  return [...corners, corners[0]];
}

/** A point that moves with the array (its path's first point, its circle's or grid's center). */
export function layoutAnchor(layout: ArrayLayout): Point3 {
  if (layout.type === "path") {
    const p = layout.points[0];
    return { x: p.x, y: p.y, z: p.z };
  }
  if (layout.type === "scatter") return layout.area ? { x: layout.area[0].x, y: layout.y, z: layout.area[0].z } : { x: layout.x ?? 0, y: layout.y, z: layout.z ?? 0 };
  return { x: layout.x, y: layout.y, z: layout.z };
}

/** A line's points through `f` (a ground position) and `h` (a ground offset), y shifted by `dy`, rounded. */
const mapLinePoints = (points: LinePoint[], f: (p: Point) => Point, h: (o: Point) => Point, dy = 0): LinePoint[] =>
  roundPoints(
    points.map((p) => ({
      ...p,
      ...f(p),
      y: p.y + dy,
      ...(p.in ? { in: { ...p.in, ...h(p.in) } } : {}),
      ...(p.out ? { out: { ...p.out, ...h(p.out) } } : {}),
    })),
  );

/** The array moved by an offset: its layout (a path's points, a circle's or grid's center). */
export function moveArray(array: ArrayNode, dx: number, dy: number, dz: number): ShapePatch {
  if (dx === 0 && dy === 0 && dz === 0) return {};
  const l = array.layout;
  if (l.type === "path") return { layout: { ...l, points: mapLinePoints(l.points, (p) => ({ x: p.x + dx, z: p.z + dz }), (o) => o, dy) } };
  if (l.type === "scatter") {
    const y = round2(l.y + dy);
    if (l.area) return { layout: { ...l, y, area: mapFootPoints(l.area, (p) => ({ x: p.x + dx, z: p.z + dz }), (o) => o) } };
    return { layout: { ...l, y, x: round2((l.x ?? 0) + dx), z: round2((l.z ?? 0) + dz) } };
  }
  return { layout: { ...l, x: round2(l.x + dx), y: round2(l.y + dy), z: round2(l.z + dz) } };
}

/** A free-form's points through `f` (a position) and `h` (a handle's offset), rounded. */
const mapFootPoints = (points: FootPoint[], f: (p: Point) => Point, h: (o: Point) => Point): FootPoint[] =>
  roundPoints(
    points.map((p) => ({
      ...p,
      ...f(p),
      ...(p.in ? { in: h(p.in) } : {}),
      ...(p.out ? { out: h(p.out) } : {}),
    })),
  );

/**
 * Degrees in 0..360, 2 decimals. A 0 stays 0 (not undefined): these patches travel as JSON to `update_nodes`, which
 * would drop an undefined and keep the old value; the store leaves a 0 out when it stores it.
 */
const turnValue = (deg: number) => round2(normalizeDeg(deg)) % 360;

/** An array patch as the store keeps it: a turn of 0 (the array's, a circle's start, a grid's) left out. */
export function tidyArrayPatch(patch: ShapePatch): ShapePatch {
  const out: ShapePatch = { ...patch };
  if (out.rotation === 0) out.rotation = undefined;
  if (out.layout) {
    const { ...layout } = out.layout as ArrayLayout & { start?: number; rotation?: number };
    if (layout.start === 0) delete layout.start;
    if (layout.rotation === 0) delete layout.rotation;
    out.layout = layout;
  }
  return out;
}

/**
 * The array turned by `degrees` around the vertical axis through `pivot`: its layout orbits the pivot, and its items
 * turn with it (a circle's start and a grid's rotation grow by the angle; a path's items follow its direction, and
 * fixed ones turn by the array's own rotation).
 */
export function rotateArray(array: ArrayNode, pivot: Point, degrees: number): ShapePatch {
  const a = (degrees * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  const turn = (o: Point) => ({ x: o.x * cos + o.z * sin, z: -o.x * sin + o.z * cos });
  const orbit = (p: Point) => {
    const t = turn({ x: p.x - pivot.x, z: p.z - pivot.z });
    return { x: pivot.x + t.x, z: pivot.z + t.z };
  };
  const l = array.layout;
  if (l.type === "path") {
    const follows = facingOf(array) === "along" || facingOf(array) === "tangent";
    return {
      layout: { ...l, points: mapLinePoints(l.points, orbit, turn) },
      ...(follows ? {} : { rotation: turnValue((array.rotation ?? 0) + degrees) }),
    };
  }
  if (l.type === "scatter") {
    const rotation = turnValue((l.rotation ?? 0) + degrees);
    if (l.area) return { layout: { ...l, rotation, area: mapFootPoints(l.area, orbit, turn) } };
    const c = orbit({ x: l.x ?? 0, z: l.z ?? 0 });
    return { layout: { ...l, rotation, x: round2(c.x), z: round2(c.z) } };
  }
  const c = orbit(l);
  const center = { x: round2(c.x), z: round2(c.z) };
  if (l.type === "circle") {
    const fixed = facingOf(array) === "fixed";
    return {
      layout: { ...l, ...center, start: turnValue((l.start ?? 0) + degrees) },
      ...(fixed ? { rotation: turnValue((array.rotation ?? 0) + degrees) } : {}),
    };
  }
  return { layout: { ...l, ...center, rotation: turnValue((l.rotation ?? 0) + degrees) } };
}

/**
 * The array mirrored across the plane where `axis` = sum / 2: its layout reflects, and each item goes to its
 * mirrored place turned to face the mirrored way, as an instance does (the entity itself isn't flipped). A circle's
 * items run the other way round after it, so its skipped indices are renumbered. Mirroring twice restores it.
 */
export function mirrorArray(array: ArrayNode, axis: MirrorAxis, sum: number): ShapePatch {
  const l = array.layout;
  const r = array.rotation ?? 0;
  const facing = facingOf(array);
  const reflect = (p: Point) => (axis === "x" ? { x: sum - p.x, z: p.z } : { x: p.x, z: sum - p.z });
  const flip = (o: Point) => (axis === "x" ? { x: -o.x, z: o.z } : { x: o.x, z: -o.z });
  // A turn that isn't the layout's own mirrors as an instance's does: 180 - r on X, -r on Z.
  const fixedTurn = turnValue(axis === "x" ? 180 - r : -r);
  if (l.type === "path") {
    const follows = facing === "along" || facing === "tangent";
    return { layout: { ...l, points: mapLinePoints(l.points, reflect, flip) }, rotation: follows ? turnValue(-r) : fixedTurn };
  }
  // A scatter's area (or circle) reflects, and its frame turns the other way; the items are scattered afresh in it.
  if (l.type === "scatter") {
    const rotation = turnValue(-(l.rotation ?? 0));
    const turnItems = axis === "x" ? turnValue(180 - r) : turnValue(-r);
    if (l.area) return { layout: { ...l, rotation, area: mapFootPoints(l.area, reflect, flip) }, rotation: turnItems };
    const c = reflect({ x: l.x ?? 0, z: l.z ?? 0 });
    return { layout: { ...l, rotation, x: round2(c.x), z: round2(c.z) }, rotation: turnItems };
  }
  const c = reflect(l);
  const center = { x: round2(c.x), z: round2(c.z) };
  if (l.type === "circle") {
    const { start, span } = circleAngles(l);
    const mirrored = axis === "x" ? 180 - start - span : -start - span;
    const rotation = facing === "tangent" || facing === "along" ? turnValue(180 - r) : facing === "out" || facing === "in" ? turnValue(-r) : fixedTurn;
    return {
      layout: { ...l, ...center, start: turnValue(mirrored) },
      rotation,
      ...(array.skip ? { skip: array.skip.map((i) => l.count - 1 - i).sort((a, b) => a - b) } : {}),
    };
  }
  return { layout: { ...l, ...center, rotation: turnValue(-(l.rotation ?? 0)) }, rotation: axis === "x" ? turnValue(180 - r) : turnValue(-r) };
}

// ---- Following (10.3) ----

/** A closed outline counterclockwise seen from above (x east, z south): the way every followed outline runs. */
function counterclockwise<P extends FootPoint>(points: P[], polygon: Point[] = points): P[] {
  // With z pointing south, a positive signed area runs clockwise seen from above.
  if (signedArea2(polygon) <= 0) return points;
  return [...points].reverse().map(({ in: i, out: o, ...p }) => ({ ...p, ...(o ? { in: o } : {}), ...(i ? { out: i } : {}) }) as P);
}

/** The default inward offset of a followed closed shape: on a room's wall's centerline, on a volume's edge. */
export const defaultFollowOffset = (target: Shape) => (isClosed(target) && target.kind === "room" ? wallOf(target) / 2 : 0);

/** Why a node can't be followed, or null. */
export function followProblem(target: SceneNode | undefined, id: string): string | null {
  if (!target) return `no node "${id}" to follow`;
  if (target.type === "group") return `"${id}" is a group; an array follows one shape (a box, a cylinder, a free-form, a ramp or a line)`;
  if (target.type === "note" || target.type === "instance" || target.type === "array") {
    return `"${id}" is a ${target.type}; an array follows a box, a cylinder, a free-form, a ramp or a line`;
  }
  if (isTilted(target)) return `"${id}" is tilted; an array can't follow a tilted shape (level it, or give the array points)`;
  return null;
}

/** A followed closed shape's outline at its top or bottom, inset by `d` meters, as free-form points (maybe curved). */
function closedOutline(shape: ClosedShape, top: boolean, d: number): FootPoint[] | null {
  const frame = shapeFrame(shape);
  const world = (ring: Point[]) => ring.map((p) => fromShapeLocal(frame, p));
  const inset = (poly: Point[]) => {
    if (Math.abs(d) < 1e-9) return poly;
    if (isFootprinted(shape)) return offsetPolygon(poly, -d);
    const rings = offsetRings(poly, -d, false);
    return rings.length > 0 ? rings.reduce((a, b) => (Math.abs(signedArea2(b)) > Math.abs(signedArea2(a)) ? b : a)) : null;
  };
  // A ring from an inset or a taper starts at its corner nearest the outline's own first point, so the items
  // don't shift round when the same outline comes another way (a box converted to a free-form).
  const first = counterclockwise(shape.type === "freeform" ? shape.points : footprint(shape))[0];
  const fromFirst = (ring: Point[]) => {
    const ccw = counterclockwise(ring);
    let k = 0;
    ccw.forEach((p, i) => {
      if (Math.hypot(p.x - first.x, p.z - first.z) < Math.hypot(ccw[k].x - first.x, ccw[k].z - first.z)) k = i;
    });
    return [...ccw.slice(k), ...ccw.slice(0, k)];
  };
  // A tapered or beveled volume's top is its top ring.
  if (top && (shape.taper || shape.bevel)) {
    const ring = inset(world(volumeRings(shape).at(-1)!.ring));
    return ring && ring.length >= 3 ? fromFirst(ring) : null;
  }
  if (shape.type === "box") {
    const [w, dp] = [shape.width - 2 * d, shape.depth - 2 * d];
    return w > 0 && dp > 0 ? counterclockwise(world(localFootprint({ ...shape, width: w, depth: dp }))) : null;
  }
  if (shape.type === "cylinder" && shape.sides === undefined) {
    const [w, dp] = [shape.width - 2 * d, shape.depth - 2 * d];
    return w > 0 && dp > 0 ? toFreeformPoints({ ...shape, width: w, depth: dp }) : null;
  }
  if (shape.type === "cylinder") {
    const ring = inset(footprint(shape));
    return ring ? counterclockwise(ring) : null;
  }
  const curved = shape.points.some((p) => p.in || p.out);
  if (Math.abs(d) < 1e-9) return counterclockwise(shape.points, sampleOutline(shape.points).polygon);
  const ring = inset(curved ? sampleOutline(shape.points).polygon : shape.points);
  return ring && ring.length >= 3 ? fromFirst(ring) : null;
}

/** A polyline moved `d` meters to the right of travel, on the ground (each point along the average of its segments' normals). */
function offsetRight(points: Point3[], d: number): Point3[] {
  if (Math.abs(d) < 1e-9) return points;
  const dir = (a: Point3, b: Point3) => {
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  };
  return points.map((p, k) => {
    const din = k > 0 ? dir(points[k - 1], p) : dir(p, points[k + 1]);
    const dout = k + 1 < points.length ? dir(p, points[k + 1]) : din;
    // The right normal of heading (x, z) is (-z, x) (heading east, right is south).
    const n = { x: -(din.z + dout.z) / 2, z: (din.x + dout.x) / 2 };
    const l = Math.hypot(n.x, n.z) || 1;
    return { ...p, x: p.x + (n.x / l) * d, z: p.z + (n.z / l) * d };
  });
}

type Followed = { points: LinePoint[]; closed: boolean } | { problem: string };
const followCache = new WeakMap<Shape, Map<string, Followed>>();

/**
 * The path an array following `node` takes (plan 10 §6): a closed shape's outline (counterclockwise seen from
 * above, closed) at its top or bottom, inset by the offset; a ramp's centerline at its surface's height, moved to
 * the right of travel; a line's path, the same. Rounded to 2 decimals. Cached per target object and follow.
 */
export function followPath(node: SceneNode | undefined, follow: Follow): Followed {
  const problem = followProblem(node, follow.id);
  if (problem || !node || node.type === "group") return { problem: problem! };
  const target: Shape = node;
  const key = JSON.stringify([follow.at, follow.offset]);
  const cached = followCache.get(target)?.get(key);
  if (cached) return cached;
  let result: Followed;
  if (isClosed(target)) {
    const top = follow.at !== "bottom";
    const y = top ? target.y + target.height : target.y;
    const outline = closedOutline(target, top, follow.offset ?? defaultFollowOffset(target));
    const toLine = (p: FootPoint): LinePoint => ({
      x: p.x,
      y,
      z: p.z,
      ...(p.in ? { in: { x: p.in.x, y: 0, z: p.in.z } } : {}),
      ...(p.out ? { out: { x: p.out.x, y: 0, z: p.out.z } } : {}),
    });
    result = outline ? { points: roundPoints(outline.map(toLine)), closed: true } : { problem: `the offset ${follow.offset} is more than "${follow.id}" is wide` };
  } else if (target.type === "ramp") {
    const centerline = rampStations(target).map((st) => ({ x: st.x, y: st.y, z: st.z }));
    result = { points: roundPoints(dedupe(offsetRight(centerline, follow.offset ?? 0))), closed: false };
  } else {
    const line = target as Extract<Shape, { type: "line" }>;
    const d = follow.offset ?? 0;
    result = { points: Math.abs(d) < 1e-9 ? line.points : roundPoints(dedupe(offsetRight(polyline(line), d))), closed: false };
  }
  if (!followCache.has(target)) followCache.set(target, new Map());
  followCache.get(target)!.set(key, result);
  return result;
}

/** Points without neighbors in the same place. */
const dedupe = (points: Point3[]) => points.filter((p, k) => k === 0 || p.x !== points[k - 1].x || p.y !== points[k - 1].y || p.z !== points[k - 1].z);

/**
 * The array with its path taken from what it follows, as `find` shows it: the same object when nothing changed (or
 * it follows nothing, or its target is gone or can't be followed: then it keeps the path it had).
 */
export function withFollowed(array: ArrayNode, find: (id: string) => SceneNode | undefined): ArrayNode {
  const l = array.layout;
  if (l.type !== "path" || !l.along) return array;
  const f = followPath(find(l.along.id), l.along);
  if ("problem" in f) return array;
  if (!!l.closed === f.closed && JSON.stringify(f.points) === JSON.stringify(l.points)) return array;
  const { closed: _closed, ...rest } = l;
  return { ...array, layout: { ...rest, points: f.points, ...(f.closed ? { closed: true as const } : {}) } };
}

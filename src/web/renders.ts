import type { SceneNode, Shape } from "../shared/scene.types";
import { boundsOf } from "../shared/geometry";
import { expandShapes } from "../shared/entities";
import { childrenOf, shapesUnder } from "../shared/tree";
import type { Box3 } from "./camera";
import type { Vec3 } from "./walk";

/**
 * `render_view`'s pure parts (plan 09 §6): which nodes get labels and where, how a plan fits its bounds, the sheet's
 * and the walk strip's layouts, and where a walk's frames stand. Drawing is in `renderView.ts`.
 */

/** A label on a render: a letter tag, the node it marks, and the point it sits on (its top center). */
export type LabelTarget = { tag: string; id: string; name?: string; anchor: Vec3 };

/** Above this many nodes to label, only the groups get one (the image stays readable). */
export const MAX_LABELS = 40;

/** A label's tag: A..Z, then AA, AB, ... */
export function labelTag(i: number): string {
  let n = i;
  let tag = "";
  do {
    tag = String.fromCharCode(65 + (n % 26)) + tag;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return tag;
}

/** Everything a node draws, as shapes (a group's contents and an instance's entity included). */
export const drawnShapes = (nodes: SceneNode[], id: string): Shape[] => expandShapes(shapesUnder(nodes, [id]));

/**
 * What a render labels: the top level (or, with `ids`, those nodes, a group standing for what's in it), without
 * notes, lines and hidden nodes, and nothing that draws no shape. More than MAX_LABELS: only the groups (and at most
 * that many).
 */
export function labelTargets(nodes: SceneNode[], ids: string[] | undefined, hidden: Set<string>): LabelTarget[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const picked = ids
    ? ids.flatMap((id) => {
        const n = byId.get(id);
        return !n ? [] : n.type === "group" && ids.length === 1 ? childrenOf(nodes, id) : [n];
      })
    : childrenOf(nodes, undefined);
  let marked = picked.filter((n) => n.type !== "note" && n.type !== "line" && !hidden.has(n.id));
  if (marked.length > MAX_LABELS) marked = marked.filter((n) => n.type === "group").slice(0, MAX_LABELS);
  return marked.flatMap((n) => {
    const shapes = drawnShapes(nodes, n.id).filter((s) => s.type !== "note" && s.type !== "line");
    if (shapes.length === 0) return [];
    const b = boundsOf(shapes);
    return [{ id: n.id, ...(n.name ? { name: n.name } : {}), anchor: { x: (b.minX + b.maxX) / 2, y: b.maxY, z: (b.minZ + b.maxZ) / 2 } }];
  }).map((t, i) => ({ tag: labelTag(i), ...t }));
}

/** The legend's line for a label: `A = group_3 "crypt"`. */
export const legendLine = (t: LabelTarget) => `${t.tag} = ${t.id}${t.name ? ` "${t.name}"` : ""}`;

/**
 * A plan's frame around bounds, for an image of `aspect` (width / height): the center, and the meters it spans each
 * way, with a margin, at least 4 m, and widened on one side to fit the image.
 */
export function planFrame(b: Box3, aspect: number): { x: number; z: number; width: number; height: number } {
  const margin = 1.12;
  let width = Math.max(4, (b.maxX - b.minX) * margin);
  let height = Math.max(4, (b.maxZ - b.minZ) * margin);
  if (width / height > aspect) height = width / aspect;
  else width = height * aspect;
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, width, height };
}

/** A plan image's shape: its bounds' aspect, kept between 1:1.8 and 1.8:1, at `size` on the long edge. */
export function planSize(b: Box3, size: number): { width: number; height: number } {
  const aspect = Math.min(1.8, Math.max(1 / 1.8, Math.max(1, b.maxX - b.minX) / Math.max(1, b.maxZ - b.minZ)));
  return aspect >= 1 ? { width: size, height: Math.round(size / aspect) } : { width: Math.round(size * aspect), height: size };
}

export type Cell = { x: number; y: number; width: number; height: number };

/** A sheet: 4:3 at `size` wide, in four panels (plan top left, then the three angles). */
export function sheetLayout(size: number): { width: number; height: number; cells: Cell[] } {
  const width = size - (size % 2);
  const height = Math.round((size * 3) / 4 / 2) * 2;
  const w = width / 2;
  const h = height / 2;
  return { width, height, cells: [0, 1, 2, 3].map((i) => ({ x: (i % 2) * w, y: Math.floor(i / 2) * h, width: w, height: h })) };
}

/** The sheet's three angles after the plan: the editor's pitch, from these yaws. */
export const SHEET_ANGLES = [
  { yaw: 135, name: "from the northeast" },
  { yaw: 0, name: "from the south" },
  { yaw: 270, name: "from the west" },
];

/** A walk strip: `n` 16:9 frames, up to 4 a row, `size` on the long edge. */
export function stripLayout(n: number, size: number): { width: number; height: number; cells: Cell[] } {
  const cols = Math.min(n, 4);
  const rows = Math.ceil(n / cols);
  let w = size / cols;
  let h = (w * 9) / 16;
  // A tall strip (two rows of few frames) keeps its long edge at `size` too.
  if (h * rows > size) {
    h = size / rows;
    w = (h * 16) / 9;
  }
  const fw = Math.floor(w);
  const fh = Math.floor(h);
  return {
    width: fw * cols,
    height: fh * rows,
    cells: Array.from({ length: n }, (_, i) => ({ x: (i % cols) * fw, y: Math.floor(i / cols) * fh, width: fw, height: fh })),
  };
}

/** The yaw (as the editor's: 0 north, counterclockwise) and pitch that look from `eye` at `target`. */
export function lookAt(eye: Vec3, target: Vec3): { yaw: number; pitch: number } {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const flat = Math.hypot(dx, dz);
  const yaw = flat < 1e-9 ? 0 : (((Math.atan2(-dx, -dz) * 180) / Math.PI) % 360 + 360) % 360;
  const pitch = Math.max(-89, Math.min(89, (Math.atan2(dy, flat) * 180) / Math.PI));
  return { yaw, pitch };
}

/**
 * A walk's frames along a path of feet positions: `n` points evenly spaced along it (both ends included), each
 * looking toward the path 2 m further on (the last one on, along its last stretch), level but for a little of the
 * slope, so a stair up looks a bit up.
 */
export function walkFrames(path: Vec3[], n: number): { feet: Vec3; yaw: number; pitch: number }[] {
  const lengths = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  const total = lengths.at(-1)!;
  const at = (s: number): Vec3 => {
    if (total === 0) return path[0];
    const d = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < lengths.length - 1 && lengths[i] < d) i++;
    const a = path[i - 1];
    const b = path[i];
    const seg = lengths[i] - lengths[i - 1];
    const t = seg === 0 ? 0 : (d - lengths[i - 1]) / seg;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  return Array.from({ length: n }, (_, k) => {
    const s = n === 1 ? 0 : (total * k) / (n - 1);
    const feet = at(s);
    // Looking ahead; at the end, along the last stretch (from 2 m back).
    const [from, to] = s + 2 <= total || total === 0 ? [feet, at(s + 2)] : [at(total - 2), at(total)];
    const { yaw, pitch } = lookAt(from, to);
    return { feet, yaw, pitch: pitch * 0.5 };
  });
}

/** A round length for a scale bar or grid, about `target` meters: 1, 2 or 5 times a power of ten. */
export function niceLength(target: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(target, 1e-6))));
  const m = target / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/**
 * Re-checked shots (`view: "shots"`): one row per shot, the image as taken and the view now side by side, each row
 * at its shot's aspect, `size` wide (all rows shrunk together if they'd be taller than `size`).
 */
export function pairLayout(aspects: number[], size: number): { width: number; height: number; rows: { before: Cell; now: Cell }[] } {
  const total = aspects.reduce((h, a) => h + size / 2 / a, 0);
  const scale = total > size ? size / total : 1;
  const w = Math.floor((size / 2) * scale);
  let y = 0;
  const rows = aspects.map((a) => {
    const h = Math.max(1, Math.round(w / a));
    const row = { before: { x: 0, y, width: w, height: h }, now: { x: w, y, width: w, height: h } };
    y += h;
    return row;
  });
  return { width: w * 2, height: y, rows };
}

/** A model sheet: `n` 4:3 cells in a near-square grid, `size` on the long edge. */
export function gridLayout(n: number, size: number): { width: number; height: number; cells: Cell[] } {
  const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 0.9))));
  const rows = Math.ceil(n / cols);
  let w = size / cols;
  let h = (w * 3) / 4;
  if (h * rows > size) {
    h = size / rows;
    w = (h * 4) / 3;
  }
  const cw = Math.floor(w);
  const ch = Math.floor(h);
  return { width: cw * cols, height: ch * rows, cells: Array.from({ length: n }, (_, i) => ({ x: (i % cols) * cw, y: Math.floor(i / cols) * ch, width: cw, height: ch })) };
}

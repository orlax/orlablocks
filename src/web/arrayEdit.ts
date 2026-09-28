import { arrayItems, circleAngles } from "../shared/arrays";
import { round2, shapeAxes, type Point, type Point3 } from "../shared/geometry";
import { MIN_ARRAY_SPACING, SNAP, type ArrayNode } from "../shared/scene.types";
import { worldToScreen, type CameraState, type Size } from "./camera";

/**
 * An array's edit mode in the view (plan 10 §7), pure: its item dots (every item, skipped ones hollow), its layout's
 * handles (a circle's or scatter circle's center and radius, a grid's center and spacing corner), what a handle drag
 * does to the layout, and skipping. A path's points and a scatter's area are edited as points, like a line's.
 */

/** An item's dot: where its pivot is, and whether it's skipped. */
export type ItemDot = { index: number; x: number; y: number; z: number; skipped: boolean };

/** Every item's dot, the skipped ones included (where they'd be). */
export function itemDots(array: ArrayNode): ItemDot[] {
  const skip = new Set(array.skip ?? []);
  return arrayItems({ ...array, skip: undefined }).map((i) => ({ index: i.index, x: i.x, y: i.y, z: i.z, skipped: skip.has(i.index) }));
}

export type ArrayPart = "center" | "radius" | "spacing";
export type ArrayHandle = Point3 & { part: ArrayPart };

/**
 * The layout's handles: a circle's center and a radius handle on it at `start`; a scatter circle's center and one
 * on it at its east; a grid's center and one at its far corner item (last column, last row), whose drag sets the
 * spacing. A path or a scatter area has none (its points are the handles).
 */
export function arrayHandles(array: ArrayNode): ArrayHandle[] {
  const l = array.layout;
  if (l.type === "circle") {
    const a = (circleAngles(l).start * Math.PI) / 180;
    return [
      { part: "center", x: l.x, y: l.y, z: l.z },
      { part: "radius", x: l.x + Math.cos(a) * l.radius, y: l.y, z: l.z - Math.sin(a) * l.radius },
    ];
  }
  if (l.type === "scatter" && !l.area) {
    const [x, z, r] = [l.x ?? 0, l.z ?? 0, l.radius ?? 0];
    return [
      { part: "center", x, y: l.y, z },
      { part: "radius", x: x + r, y: l.y, z },
    ];
  }
  if (l.type === "grid") {
    const { ex, ez } = shapeAxes({ rotation: l.rotation ?? 0 });
    const u = ((l.columns - 1) / 2) * l.spacing.x + (l.stagger && l.rows > 1 && (l.rows - 1) % 2 === 1 ? l.spacing.x / 2 : 0);
    const v = ((l.rows - 1) / 2) * l.spacing.z;
    const handles: ArrayHandle[] = [{ part: "center", x: l.x, y: l.y, z: l.z }];
    if (l.columns > 1 || l.rows > 1) handles.push({ part: "spacing", x: l.x + u * ex.x + v * ez.x, y: l.y, z: l.z + u * ex.z + v * ez.z });
    return handles;
  }
  return [];
}

/** How close (px) a press must be to a handle or a dot to grab it. */
export const ARRAY_HIT_PX = 9;

/** The handle under the cursor (handles first, they're drawn on top), or null. */
export function hitArrayHandle(cam: CameraState, size: Size, sx: number, sy: number, handles: ArrayHandle[]): ArrayPart | null {
  return nearest(cam, size, sx, sy, handles)?.part ?? null;
}

/** The item dot under the cursor, or null. */
export function hitItemDot(cam: CameraState, size: Size, sx: number, sy: number, dots: ItemDot[]): number | null {
  return nearest(cam, size, sx, sy, dots)?.index ?? null;
}

function nearest<T extends Point3>(cam: CameraState, size: Size, sx: number, sy: number, points: T[]): T | null {
  let best: { p: T; d: number } | null = null;
  for (const p of points) {
    const s = worldToScreen(cam, size, p);
    if (!s) continue;
    const d = Math.hypot(s.sx - sx, s.sy - sy);
    if (d <= ARRAY_HIT_PX && (!best || d < best.d)) best = { p, d };
  }
  return best?.p ?? null;
}

/** A center snaps to a shape's center within this many meters, else to the 0.5 m grid. */
export const CENTER_SNAP = 0.75;

/**
 * What dragging a handle to ground point `to` does to the layout (fields to merge into it) and the label to show.
 * - center: moves the layout's center (a circle's, a scatter circle's, a grid's), snapped to the nearest of
 *   `centers` within CENTER_SNAP, else to the 0.5 m grid (unless `free`);
 * - radius: the distance from the center (0.05 m steps; 0.25 m unless `free`), or with `alt` a circle's start
 *   instead (the angle to the cursor, 5° steps);
 * - spacing: a grid's spacing along its own axes, from where its far corner item is dragged (equal on both with `alt`).
 */
export function dragArrayHandle(
  array: ArrayNode,
  part: ArrayPart,
  to: Point,
  { alt = false, free = false, centers = [] }: { alt?: boolean; free?: boolean; centers?: Point[] } = {},
): { patch: Record<string, unknown>; label: string } | null {
  const l = array.layout;
  const step = (n: number, s: number) => round2(free ? Math.round(n / 0.05) * 0.05 : Math.round(n / s) * s);
  if (part === "center") {
    const near = centers.reduce<{ p: Point; d: number } | null>((best, c) => {
      const d = Math.hypot(c.x - to.x, c.z - to.z);
      return d <= CENTER_SNAP && (!best || d < best.d) ? { p: c, d } : best;
    }, null);
    const at = near && !free ? { x: round2(near.p.x), z: round2(near.p.z) } : { x: step(to.x, SNAP), z: step(to.z, SNAP) };
    return { patch: at, label: `center ${at.x}, ${at.z}${near && !free ? " · on a shape's center" : ""}` };
  }
  if (part === "radius" && (l.type === "circle" || l.type === "scatter")) {
    const [cx, cz] = [l.x ?? 0, l.z ?? 0];
    if (alt && l.type === "circle") {
      const deg = (Math.atan2(-(to.z - cz), to.x - cx) * 180) / Math.PI;
      const start = round2((((Math.round(deg / 5) * 5) % 360) + 360) % 360);
      return { patch: { start }, label: `start ${start}°` };
    }
    const radius = Math.max(0.05, step(Math.hypot(to.x - cx, to.z - cz), 0.25));
    return { patch: { radius }, label: `r ${radius} m` };
  }
  if (part === "spacing" && l.type === "grid") {
    const { ex, ez } = shapeAxes({ rotation: l.rotation ?? 0 });
    const [dx, dz] = [to.x - l.x, to.z - l.z];
    const [u, v] = [dx * ex.x + dz * ex.z, dx * ez.x + dz * ez.z];
    const stagger = l.stagger && l.rows > 1 && (l.rows - 1) % 2 === 1 ? 0.5 : 0;
    let sx = l.columns > 1 || stagger ? Math.max(MIN_ARRAY_SPACING, step((2 * u) / (l.columns - 1 + 2 * stagger), 0.25)) : l.spacing.x;
    let sz = l.rows > 1 ? Math.max(MIN_ARRAY_SPACING, step((2 * v) / (l.rows - 1), 0.25)) : l.spacing.z;
    if (alt) sx = sz = Math.max(l.columns > 1 ? sx : 0, l.rows > 1 ? sz : 0);
    return { patch: { spacing: { ...l.spacing, x: sx, z: sz } }, label: `spacing ${sx} × ${sz} m` };
  }
  return null;
}

/**
 * The skip list after toggling items: the selected items that show are skipped, the selected skipped ones come back.
 * Sorted, each once.
 */
export function toggleSkips(array: ArrayNode, indices: number[]): number[] {
  const skip = new Set(array.skip ?? []);
  for (const i of indices) {
    if (skip.has(i)) skip.delete(i);
    else skip.add(i);
  }
  return [...skip].sort((a, b) => a - b);
}

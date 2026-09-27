import { HEIGHT_SNAP, MIN_HEIGHT, SNAP, type Shape, type ShapePatch } from "../shared/scene.types";
import {
  anchorOf,
  boundsOf,
  footprintBounds,
  fromShapeLocal,
  handleFrame,
  isFootprinted,
  moveShape,
  normalizeDeg,
  resizeShape,
  rotateAround,
  rotationOf,
  round2,
  sameValue,
  shapeAxes,
  toShapeLocal,
  type Bounds,
} from "../shared/geometry";
import { paramOnLine, screenToPlane, worldToScreen, type CameraState, type Size, type Vec3 } from "./camera";

/**
 * Pure math for the transform gizmo: where its handles are, which one the cursor is on, and what a drag does.
 * Everything works on "the selection" (one or more boxes), so multi-selection needs no rewrite.
 */

type Sign = -1 | 0 | 1;
/** A footprint scale handle on the top face, by its side in the box's local frame: `scale:1:-1` is the +x, -z corner. */
export type ScalePart = `scale:${Sign}:${Sign}`;
export type GizmoPart = "x" | "y" | "z" | "height" | "rotate" | ScalePart;
export type DragPart = GizmoPart | "body";

/** The gizmo keeps a roughly constant size on screen: its world size grows with the camera distance. */
const SCALE_PER_METER_OF_DISTANCE = 0.018;
export const gizmoScale = (cam: CameraState) => cam.distance * SCALE_PER_METER_OF_DISTANCE;

/** Arrow shape in gizmo units: it starts a little away from the anchor (the height handle sits there). */
export const ARROW = { start: 0.55, length: 2.3, tip: 0.45 };
/** Size of the height handle (a small cube on the top center), in gizmo units. */
export const HEIGHT_HANDLE = 0.32;
/** Size of a scale handle, in gizmo units. */
export const SCALE_HANDLE = 0.24;
/** How close (px) the pointer must be to a handle to grab it. */
export const HANDLE_HIT_PX = 10;
/** The smallest width or depth scaling can leave. */
export const MIN_SIZE = 0.05;
/** The rotate handle: a ring this far (gizmo units) out from a top corner, and its radius. */
export const ROTATE_OFFSET = 0.75;
export const ROTATE_RADIUS = 0.3;
/** Rotation snap, degrees. */
export const ROTATE_SNAP = 15;

/** The 4 corners, then the 4 edge midpoints. */
export const SCALE_PARTS: ScalePart[] = [
  "scale:-1:-1",
  "scale:1:-1",
  "scale:1:1",
  "scale:-1:1",
  "scale:0:-1",
  "scale:1:0",
  "scale:0:1",
  "scale:-1:0",
];
export const isScalePart = (part: string): part is ScalePart => part.startsWith("scale:");
const signs = (part: ScalePart) => part.split(":").slice(1).map(Number) as [Sign, Sign];
/** When raising, the bottom snaps to box tops and the ground within this many meters. */
export const ELEVATION_SNAP_RANGE = 0.25;

export const AXES: Record<"x" | "y" | "z", Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

const snapTo = (n: number, step: number) => Math.round(n / step) * step;

/** Where a scale handle sits: on the top face's corner or edge midpoint. */
export function scaleHandlePoint(shape: Shape, part: ScalePart): Vec3 {
  const [sx, sz] = signs(part);
  const f = handleFrame(shape);
  const p = fromShapeLocal(f, { x: (sx * f.width) / 2, z: (sz * f.depth) / 2 });
  return { x: p.x, y: shape.y + shape.height, z: p.z };
}

/**
 * The resize cursor for a scale handle, from the direction it points on screen (center → handle), so it stays
 * right at any yaw and rotation.
 */
export function scaleCursor(cam: CameraState, size: Size, box: Shape, part: ScalePart): "ns" | "ew" | "nwse" | "nesw" {
  const f = handleFrame(box);
  const c = worldToScreen(cam, size, { x: f.x, y: box.y + box.height, z: f.z });
  const h = worldToScreen(cam, size, scaleHandlePoint(box, part));
  if (!c || !h) return "nwse";
  const deg = ((Math.atan2(h.sy - c.sy, h.sx - c.sx) * 180) / Math.PI + 180) % 180; // 0..180, screen y down
  return deg < 22.5 || deg >= 157.5 ? "ew" : deg < 67.5 ? "nwse" : deg < 112.5 ? "ns" : "nesw";
}

/**
 * Where the rotate handle sits: just outside a top corner, out along the diagonal. For a single box it's the box's
 * own (-x, -z) corner, so it turns with the box; for several it's the bounds' min corner. `inward` points back
 * toward the corner (the ring's gap faces it). `scale` is the gizmo scale.
 */
export function rotateHandlePlacement(boxes: Shape[], scale: number): { point: Vec3; inward: { x: number; z: number } } {
  const offset = ROTATE_OFFSET * scale;
  if (boxes.length === 1) {
    const box = boxes[0];
    const { ex, ez } = shapeAxes(handleFrame(box));
    const corner = scaleHandlePoint(box, "scale:-1:-1");
    const out = { x: -(ex.x + ez.x) / Math.SQRT2, z: -(ex.z + ez.z) / Math.SQRT2 };
    return { point: { x: corner.x + out.x * offset, y: corner.y, z: corner.z + out.z * offset }, inward: { x: -out.x, z: -out.z } };
  }
  const b = boundsOf(boxes);
  const d = offset / Math.SQRT2;
  return { point: { x: b.minX - d, y: b.maxY, z: b.minZ - d }, inward: { x: Math.SQRT1_2, z: Math.SQRT1_2 } };
}

/** The angle of a ground vector in degrees, counterclockwise seen from above (the rotation convention). */
const angleOf = (x: number, z: number) => (Math.atan2(-z, x) * 180) / Math.PI;

/** Where the gizmo sits: the top center of the bounds. */
export const gizmoAnchor = (b: Bounds): Vec3 => ({ x: (b.minX + b.maxX) / 2, y: b.maxY, z: (b.minZ + b.maxZ) / 2 });

const add = (p: Vec3, u: Vec3, s: number): Vec3 => ({ x: p.x + u.x * s, y: p.y + u.y * s, z: p.z + u.z * s });

/** Distance from (px, py) to the segment a–b, all in screen pixels. */
function segmentDistance(px: number, py: number, a: { sx: number; sy: number }, b: { sx: number; sy: number }) {
  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.sx) * dx + (py - a.sy) * dy) / len2));
  return Math.hypot(px - (a.sx + dx * t), py - (a.sy + dy * t));
}

/**
 * Which of `parts` is under the cursor, or null. The height handle wins over everything around it, otherwise the
 * nearest handle wins. Scale and rotate handles need the selected `boxes`.
 */
export function hitGizmo(
  cam: CameraState,
  size: Size,
  sx: number,
  sy: number,
  anchor: Vec3,
  parts: GizmoPart[],
  boxes: Shape[] = [],
): GizmoPart | null {
  const scale = gizmoScale(cam);
  if (parts.includes("height")) {
    const p = worldToScreen(cam, size, add(anchor, AXES.y, (HEIGHT_HANDLE / 2) * scale));
    if (p && Math.hypot(p.sx - sx, p.sy - sy) <= HANDLE_HIT_PX) return "height";
  }
  let best: { part: GizmoPart; d: number } | null = null;
  if (parts.includes("rotate") && boxes.length > 0) {
    // The ring is bigger than a point handle: anywhere within its radius (on screen) grabs it.
    const { point } = rotateHandlePlacement(boxes, scale);
    const c = worldToScreen(cam, size, point);
    const rim = worldToScreen(cam, size, add(point, AXES.y, ROTATE_RADIUS * scale));
    if (c && rim) {
      const d = Math.hypot(c.sx - sx, c.sy - sy);
      if (d <= Math.hypot(rim.sx - c.sx, rim.sy - c.sy) + HANDLE_HIT_PX / 2) best = { part: "rotate", d };
    }
  }
  const box = boxes.length === 1 ? boxes[0] : undefined;
  if (box) {
    for (const part of parts.filter(isScalePart)) {
      const p = worldToScreen(cam, size, scaleHandlePoint(box, part));
      const d = p ? Math.hypot(p.sx - sx, p.sy - sy) : Infinity;
      if (d <= HANDLE_HIT_PX && (!best || d < best.d)) best = { part, d };
    }
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (!parts.includes(axis)) continue;
    const a = worldToScreen(cam, size, add(anchor, AXES[axis], ARROW.start * scale));
    const b = worldToScreen(cam, size, add(anchor, AXES[axis], (ARROW.start + ARROW.length) * scale));
    if (!a || !b) continue;
    const d = segmentDistance(sx, sy, a, b);
    if (d <= HANDLE_HIT_PX && (!best || d < best.d)) best = { part: axis, d };
  }
  return best?.part ?? null;
}

/** What the bottom of a raised selection can snap to: the ground, and the tops of boxes under it. */
export function elevationTargets(moving: Bounds, others: Shape[]): number[] {
  const targets = [0];
  for (const box of others) {
    const f = footprintBounds(box);
    const overlaps = f.minX < moving.maxX && f.maxX > moving.minX && f.minZ < moving.maxZ && f.maxZ > moving.minZ;
    if (overlaps) targets.push(round2(box.y + box.height));
  }
  return targets;
}

/** The nearest target within ELEVATION_SNAP_RANGE, else the nearest 0.05 m step. `snap` false leaves it free. */
export function snapElevation(raw: number, targets: number[], snap: boolean): number {
  if (!snap) return round2(raw);
  let best: number | null = null;
  for (const t of targets) {
    if (Math.abs(t - raw) <= ELEVATION_SNAP_RANGE && (best === null || Math.abs(t - raw) < Math.abs(best - raw))) best = t;
  }
  return round2(best ?? snapTo(raw, HEIGHT_SNAP));
}

/**
 * A drag in progress, as captured on pointer-down. `origin` is the dragged boxes as they were, and `bounds`
 * their bounds. `grab` is the grabbed world point for a body drag (it stays under the cursor), and the starting
 * position along the handle's line for the others.
 */
export type GizmoDrag = { part: DragPart; origin: Shape[]; bounds: Bounds; grab: Vec3 | number };

export type DragModifiers = { shift: boolean; alt: boolean; snap: boolean };

/**
 * Starts a drag on a handle: remembers where along its line the cursor is, or for a scale handle how far the
 * cursor is from the handle (in the box's frame, on the top face's plane), so the handle doesn't jump.
 */
export function startHandleDrag(cam: CameraState, size: Size, sx: number, sy: number, part: GizmoPart, origin: Shape[]): GizmoDrag {
  const bounds = boundsOf(origin);
  if (part === "rotate") {
    // The cursor's angle around the pivot (the selection's center), on the plane of its top.
    const p = screenToPlane(cam, size, sx, sy, bounds.maxY);
    const pivot = gizmoAnchor(bounds);
    return { part, origin, bounds, grab: angleOf(p.x - pivot.x, p.z - pivot.z) };
  }
  if (isScalePart(part)) {
    const shape = origin[0];
    const f = handleFrame(shape);
    const [hx, hz] = signs(part);
    const l = toShapeLocal(f, screenToPlane(cam, size, sx, sy, shape.y + shape.height));
    return { part, origin, bounds, grab: { x: l.x - (hx * f.width) / 2, y: 0, z: l.z - (hz * f.depth) / 2 } };
  }
  const axis = part === "height" ? AXES.y : AXES[part];
  return { part, origin, bounds, grab: paramOnLine(cam, size, sx, sy, gizmoAnchor(bounds), axis) };
}

/** Starts a body drag at the point where the cursor hit a box. */
export const startBodyDrag = (origin: Shape[], grab: Vec3): GizmoDrag => ({ part: "body", origin, bounds: boundsOf(origin), grab });

/**
 * The boxes' changes for the cursor at (sx, sy), plus the live label. `others` are the boxes not being dragged
 * (for elevation snapping). Patches hold only the fields the drag changes.
 */
export function dragUpdate(
  drag: GizmoDrag,
  cam: CameraState,
  size: Size,
  sx: number,
  sy: number,
  mods: DragModifiers,
  others: Shape[],
): { patches: Record<string, ShapePatch>; label: string } {
  const { part, origin, bounds } = drag;
  const anchor = gizmoAnchor(bounds);
  const patches: Record<string, ShapePatch> = {};

  if (isScalePart(part)) return scaleUpdate(drag, part, cam, size, sx, sy, mods);

  if (part === "rotate") {
    const p = screenToPlane(cam, size, sx, sy, bounds.maxY);
    let delta = normalizeDeg(angleOf(p.x - anchor.x, p.z - anchor.z) - (drag.grab as number));
    if (delta > 180) delta -= 360;
    // One box or cylinder snaps to whole 15° angles; several (or a free-form, which has no angle) snap the change.
    const single = origin.length === 1 && isFootprinted(origin[0]) ? origin[0] : null;
    if (mods.snap) {
      delta = single ? snapTo(single.rotation + delta, ROTATE_SNAP) - single.rotation : snapTo(delta, ROTATE_SNAP);
    }
    Object.assign(patches, rotateAround(origin, anchor, delta));
    const label = single ? `${patches[single.id].rotation}°` : `${delta >= 0 ? "+" : ""}${round2(delta)}°`;
    return { patches, label };
  }

  if (part === "height") {
    const box = origin[0];
    const s = paramOnLine(cam, size, sx, sy, anchor, AXES.y);
    const raw = box.height + s - (drag.grab as number);
    const height = round2(Math.max(MIN_HEIGHT, mods.snap ? snapTo(raw, HEIGHT_SNAP) : raw));
    patches[box.id] = { height };
    return { patches, label: `h ${height.toFixed(2)} m` };
  }

  if (part === "y") {
    const s = paramOnLine(cam, size, sx, sy, anchor, AXES.y);
    const bottom = snapElevation(bounds.minY + s - (drag.grab as number), elevationTargets(bounds, others), mods.snap);
    const dy = bottom - bounds.minY;
    for (const box of origin) patches[box.id] = moveShape(box, 0, dy, 0);
    return { patches, label: `y ${bottom.toFixed(2)} m` };
  }

  let dx = 0;
  let dz = 0;
  if (part === "body") {
    const grab = drag.grab as Vec3;
    const p = screenToPlane(cam, size, sx, sy, grab.y);
    dx = p.x - grab.x;
    dz = p.z - grab.z;
    if (mods.shift) {
      if (Math.abs(dx) >= Math.abs(dz)) dz = 0;
      else dx = 0;
    }
  } else {
    const d = paramOnLine(cam, size, sx, sy, anchor, AXES[part]) - (drag.grab as number);
    if (part === "x") dx = d;
    else dz = d;
  }
  if (mods.snap) {
    dx = snapTo(dx, SNAP);
    dz = snapTo(dz, SNAP);
  }
  for (const box of origin) patches[box.id] = moveShape(box, dx, 0, dz);
  return { patches, label: `x ${(anchor.x + dx).toFixed(2)} · z ${(anchor.z + dz).toFixed(2)}` };
}

/**
 * A new size along one axis, snapped as a change from the original (`step` per side, so boxes on the grid stay
 * on it) and never below MIN_SIZE (the smallest size on the snap lattice, when snapping).
 */
function snapSize(raw: number, original: number, step: number, snap: boolean): number {
  if (!snap) return Math.max(MIN_SIZE, raw);
  const v = original + snapTo(raw - original, step);
  return v >= MIN_SIZE ? v : original - Math.floor((original - MIN_SIZE) / step) * step;
}

/**
 * A scale handle drag, in the box's frame on the top face. The opposite side stays fixed (`Alt`: the center
 * does). `Shift` keeps the aspect ratio: a corner follows whichever side grows more, and an edge scales the other
 * side around the center.
 */
function scaleUpdate(
  drag: GizmoDrag,
  part: ScalePart,
  cam: CameraState,
  size: Size,
  sx: number,
  sy: number,
  mods: DragModifiers,
): { patches: Record<string, ShapePatch>; label: string } {
  const shape = drag.origin[0];
  // The math runs on the handle frame: a box's own rectangle, a free-form's bounds.
  const box = handleFrame(shape);
  const grab = drag.grab as Vec3;
  const [hx, hz] = signs(part);
  const l = toShapeLocal(box, screenToPlane(cam, size, sx, sy, shape.y + shape.height));
  // Where the dragged handle should be, in the box's frame.
  const tx = l.x - grab.x;
  const tz = l.z - grab.z;
  const step = mods.alt ? 2 * SNAP : SNAP;
  const raw = (sign: Sign, target: number, original: number) =>
    sign === 0 ? original : mods.alt ? 2 * sign * target : sign * target + original / 2;

  let width = raw(hx, tx, box.width);
  let depth = raw(hz, tz, box.depth);
  if (mods.shift) {
    // The side that drives the scale: the handle's axis for an edge, the one that grew more for a corner.
    const byWidth = hz === 0 || (hx !== 0 && width / box.width >= depth / box.depth);
    const driven = byWidth ? snapSize(width, box.width, step, mods.snap) : snapSize(depth, box.depth, step, mods.snap);
    let f = byWidth ? driven / box.width : driven / box.depth;
    f = Math.max(f, MIN_SIZE / box.width, MIN_SIZE / box.depth);
    width = box.width * f;
    depth = box.depth * f;
  } else {
    width = hx === 0 ? box.width : snapSize(width, box.width, step, mods.snap);
    depth = hz === 0 ? box.depth : snapSize(depth, box.depth, step, mods.snap);
  }
  width = round2(width);
  depth = round2(depth);

  // The fixed side stays put, so the center moves by half the change (not at all from the center).
  const shift = (sign: Sign, next: number, original: number) => (mods.alt || sign === 0 ? 0 : (sign * (next - original)) / 2);
  const c = fromShapeLocal(box, { x: shift(hx, width, box.width), z: shift(hz, depth, box.depth) });
  const to = isFootprinted(shape) ? { x: round2(c.x), z: round2(c.z), width, depth } : { x: c.x, z: c.z, width, depth };
  return {
    patches: { [shape.id]: resizeShape(shape, box, to) },
    label: `${width.toFixed(2)} × ${depth.toFixed(2)} m`,
  };
}

/** Only the patches that actually change something, as `update_nodes` changes. */
export function effectiveChanges(origin: Shape[], patches: Record<string, ShapePatch>): ({ id: string } & ShapePatch)[] {
  return origin.flatMap((box) => {
    const patch = patches[box.id];
    if (!patch) return [];
    const changed = (Object.keys(patch) as (keyof ShapePatch)[]).some((k) => !sameValue(patch[k], (box as ShapePatch)[k]));
    return changed ? [{ id: box.id, ...patch }] : [];
  });
}

/** The drags that `Alt` turns into a copy: the move drags (body, x/z arrows, y arrow). Scale keeps `Alt` = from the center. */
export const canCopy = (part: DragPart) => part === "body" || part === "x" || part === "y" || part === "z";

/** How far a move drag has taken the shapes (world axes, 2 decimals), from the first shape's patch. */
export function dragOffset(origin: Shape[], patches: Record<string, ShapePatch>): { dx: number; dy: number; dz: number } {
  const shape = origin[0];
  const a = anchorOf(shape);
  const b = anchorOf({ ...shape, ...patches[shape.id] } as Shape);
  return { dx: round2(b.x - a.x), dy: round2(b.y - a.y), dz: round2(b.z - a.z) };
}

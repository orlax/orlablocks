import { HEIGHT_SNAP, MIN_HEIGHT, SNAP, type Box, type BoxPatch } from "../shared/scene.types";
import { paramOnLine, screenToPlane, worldToScreen, type CameraState, type Size, type Vec3 } from "./camera";

/**
 * Pure math for the transform gizmo: where its handles are, which one the cursor is on, and what a drag does.
 * Everything works on "the selection" (one or more boxes), so multi-selection needs no rewrite.
 */

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
export type GizmoPart = "x" | "y" | "z" | "height";
export type DragPart = GizmoPart | "body";

/** The gizmo keeps a roughly constant size on screen: its world size grows with the camera distance. */
const SCALE_PER_METER_OF_DISTANCE = 0.018;
export const gizmoScale = (cam: CameraState) => cam.distance * SCALE_PER_METER_OF_DISTANCE;

/** Arrow shape in gizmo units: it starts a little away from the anchor (the height handle sits there). */
export const ARROW = { start: 0.55, length: 2.3, tip: 0.45 };
/** Size of the height handle (a small cube on the top center), in gizmo units. */
export const HEIGHT_HANDLE = 0.32;
/** How close (px) the pointer must be to a handle to grab it. */
export const HANDLE_HIT_PX = 10;
/** When raising, the bottom snaps to box tops and the ground within this many meters. */
export const ELEVATION_SNAP_RANGE = 0.25;

export const AXES: Record<"x" | "y" | "z", Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const snapTo = (n: number, step: number) => Math.round(n / step) * step;

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
export function selectionBounds(boxes: Box[]): Bounds {
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

/** Which of `parts` is under the cursor, or null. The height handle wins over the arrows around it. */
export function hitGizmo(cam: CameraState, size: Size, sx: number, sy: number, anchor: Vec3, parts: GizmoPart[]): GizmoPart | null {
  const scale = gizmoScale(cam);
  if (parts.includes("height")) {
    const p = worldToScreen(cam, size, add(anchor, AXES.y, (HEIGHT_HANDLE / 2) * scale));
    if (p && Math.hypot(p.sx - sx, p.sy - sy) <= HANDLE_HIT_PX) return "height";
  }
  let best: { part: GizmoPart; d: number } | null = null;
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
export function elevationTargets(moving: Bounds, others: Box[]): number[] {
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
export type GizmoDrag = { part: DragPart; origin: Box[]; bounds: Bounds; grab: Vec3 | number };

export type DragModifiers = { shift: boolean; snap: boolean };

/** Starts a drag on a handle: remembers where along its line the cursor is. */
export function startHandleDrag(cam: CameraState, size: Size, sx: number, sy: number, part: GizmoPart, origin: Box[]): GizmoDrag {
  const bounds = selectionBounds(origin);
  const axis = part === "height" ? AXES.y : AXES[part];
  return { part, origin, bounds, grab: paramOnLine(cam, size, sx, sy, gizmoAnchor(bounds), axis) };
}

/** Starts a body drag at the point where the cursor hit a box. */
export const startBodyDrag = (origin: Box[], grab: Vec3): GizmoDrag => ({ part: "body", origin, bounds: selectionBounds(origin), grab });

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
  others: Box[],
): { patches: Record<string, BoxPatch>; label: string } {
  const { part, origin, bounds } = drag;
  const anchor = gizmoAnchor(bounds);
  const patches: Record<string, BoxPatch> = {};

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
    for (const box of origin) patches[box.id] = { y: round2(box.y + dy) };
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
  for (const box of origin) patches[box.id] = { x: round2(box.x + dx), z: round2(box.z + dz) };
  return { patches, label: `x ${(anchor.x + dx).toFixed(2)} · z ${(anchor.z + dz).toFixed(2)}` };
}

/** Only the patches that actually change something, as `update_nodes` changes. */
export function effectiveChanges(origin: Box[], patches: Record<string, BoxPatch>): ({ id: string } & BoxPatch)[] {
  return origin.flatMap((box) => {
    const patch = patches[box.id];
    if (!patch) return [];
    const changed = (Object.keys(patch) as (keyof BoxPatch)[]).some((k) => patch[k] !== box[k]);
    return changed ? [{ id: box.id, ...patch }] : [];
  });
}

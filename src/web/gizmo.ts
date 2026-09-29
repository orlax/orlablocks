import { DEFAULT_WALL, HEIGHT_SNAP, MAX_SCALE, MIN_HEIGHT, MIN_WALL, SNAP, type ClosedShape, type Shape, type ShapePatch } from "../shared/scene.types";
import {
  anchorOf,
  boundsOf,
  centroid,
  footprintBounds,
  fromShapeLocal,
  handleFrame,
  isClosed,
  isFootprinted,
  isTilted,
  localFootprint,
  moveShape,
  normalizeDeg,
  pointInPolygon,
  resizeShape,
  rotateAround,
  round2,
  sameValue,
  selectionFrame,
  shapeAxes,
  toLocal3,
  toShapeLocal,
  toWorld3,
  transformShape,
  wallOf,
  verticalRange,
  type Bounds,
  type Frame,
  type Point3,
} from "../shared/geometry";
import { paramOnLine, screenRay, screenToPlane, worldToScreen, type CameraState, type Size, type Vec3 } from "./camera";

/**
 * Pure math for the transform gizmo: where its handles are, which one the cursor is on, and what a drag does.
 * Everything works on "the selection" (one or more boxes), so multi-selection needs no rewrite.
 */

type Sign = -1 | 0 | 1;
/** A footprint scale handle on the top face, by its side in the box's local frame: `scale:1:-1` is the +x, -z corner. */
export type ScalePart = `scale:${Sign}:${Sign}`;
/** `pitch` and `roll` are the tilt rings of a single box or cylinder volume. */
export type TiltPart = "pitch" | "roll";
/** `wall` is a single room's wall thickness knob, `taper` and `bevel` a single volume's or hole's profile knobs. */
export type ProfilePart = "wall" | "taper" | "bevel";
/** `uniform` is the uniform scale handle (14.3): any selection, about the bottom center of its bounds. */
export type GizmoPart = "x" | "y" | "z" | "height" | "rotate" | "uniform" | TiltPart | ScalePart | ProfilePart;
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
/** The tilt rings' radius, in gizmo units, around the shape's center. */
export const TILT_RADIUS = 1.5;
/** A profile knob's radius (wall, taper, bevel), in gizmo units. */
export const PROFILE_HANDLE = 0.14;
/** Wall, taper and bevel snap: 0.05 m for a wall, 0.05 for a fraction. */
export const PROFILE_SNAP = 0.05;

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
export const isProfilePart = (part: string): part is ProfilePart => part === "wall" || part === "taper" || part === "bevel";
const signs = (part: ScalePart) => part.split(":").slice(1).map(Number) as [Sign, Sign];
/** When raising, the bottom snaps to box tops and the ground within this many meters. */
export const ELEVATION_SNAP_RANGE = 0.25;

export const AXES: Record<"x" | "y" | "z", Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

const snapTo = (n: number, step: number) => Math.round(n / step) * step;
/** A shape's top: a closed shape's, or a line's highest point. */
const topOf = (shape: Shape) => verticalRange(shape)[1];

/**
 * Where a scale handle sits: on the top face's corner or edge midpoint, of the shape's handle frame (or `f`). A
 * tilted shape's sit on its own tilted top face.
 */
export function scaleHandlePoint(shape: Shape, part: ScalePart, f: Frame = handleFrame(shape)): Vec3 {
  const [sx, sz] = signs(part);
  if (isTilted(shape) && isFootprinted(shape)) return toWorld3(shape, { x: (sx * shape.width) / 2, y: shape.height, z: (sz * shape.depth) / 2 });
  const p = fromShapeLocal(f, { x: (sx * f.width) / 2, z: (sz * f.depth) / 2 });
  return { x: p.x, y: topOf(shape), z: p.z };
}

/** Where the height handle sits: on the gizmo's anchor, or for a tilted shape on the center of its own top face. */
export const heightHandlePoint = (shape: Shape | undefined, anchor: Vec3): Vec3 =>
  shape && isTilted(shape) && isFootprinted(shape) ? toWorld3(shape, { x: 0, y: shape.height, z: 0 }) : anchor;

/** A shape's own axis (x, y or z, as tilted and turned) in the world, as a unit vector. */
export function shapeAxis(shape: ClosedShape, axis: "x" | "y" | "z"): Vec3 {
  const o = toWorld3(shape, { x: 0, y: 0, z: 0 });
  const e = toWorld3(shape, { x: axis === "x" ? 1 : 0, y: axis === "y" ? 1 : 0, z: axis === "z" ? 1 : 0 });
  return unit({ x: e.x - o.x, y: e.y - o.y, z: e.z - o.z });
}

/**
 * Where the cursor's ray meets the plane at height `y` in a closed shape's own frame (tilted with it), in that
 * frame; null when the plane is seen edge-on or lies behind the camera.
 */
export function cursorInShape(cam: CameraState, size: Size, sx: number, sy: number, shape: ClosedShape, y: number): Point3 | null {
  const { origin, dir } = screenRay(cam, size, sx, sy);
  const o = toLocal3(shape, origin);
  const e = toLocal3(shape, { x: origin.x + dir.x, y: origin.y + dir.y, z: origin.z + dir.z });
  const d = { x: e.x - o.x, y: e.y - o.y, z: e.z - o.z };
  if (Math.abs(d.y) < 1e-4) return null;
  const t = (y - o.y) / d.y;
  return t > 0 ? { x: o.x + d.x * t, y, z: o.z + d.z * t } : null;
}

type Ground = { x: number; z: number };

/**
 * The lines the profile knobs sit on, in the shape's own frame (x/z on its footprint):
 * - `center`: what a taper shrinks toward (a box's or cylinder's center, a free-form's centroid);
 * - `taper` and `bevel`: a point on the outline each, so the two knobs never meet. A box's or cylinder's are where
 *   the outline crosses the line from its center toward (+width / 2, +depth / 4) and the opposite way: between an
 *   edge's midpoint and a corner, away from the scale handles. A free-form's are its longest edge's midpoint and
 *   the edge midpoint farthest from it;
 * - `wall`: a point on the outline and the direction into the room there (a box's or cylinder's local +x);
 * - `half`: half the smallest extent, which bounds the bevel's radius and the walls.
 */
export function profileSpokes(shape: ClosedShape): { center: Ground; taper: Ground; bevel: Ground; wall: { at: Ground; inward: Ground }; half: number } {
  const poly = localFootprint(shape);
  if (isFootprinted(shape)) {
    const hw = shape.width / 2;
    const out = (sign: number) => rayExit(poly, { x: sign * hw, z: (sign * shape.depth) / 4 });
    return { center: { x: 0, z: 0 }, taper: out(1), bevel: out(-1), wall: { at: { x: hw, z: 0 }, inward: { x: -1, z: 0 } }, half: Math.min(shape.width, shape.depth) / 2 };
  }
  const mid = (i: number) => {
    const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
    return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  };
  const len = (i: number) => Math.hypot(poly[(i + 1) % poly.length].x - poly[i].x, poly[(i + 1) % poly.length].z - poly[i].z);
  let longest = 0;
  for (let i = 1; i < poly.length; i++) if (len(i) > len(longest)) longest = i;
  const m = mid(longest);
  let far = longest;
  for (let i = 0; i < poly.length; i++) if (Math.hypot(mid(i).x - m.x, mid(i).z - m.z) > Math.hypot(mid(far).x - m.x, mid(far).z - m.z)) far = i;
  const [a, b] = [poly[longest], poly[(longest + 1) % poly.length]];
  const l = len(longest) || 1;
  let inward = { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  if (!pointInPolygon(poly, { x: m.x + inward.x * 1e-3, z: m.z + inward.z * 1e-3 })) inward = { x: -inward.x, z: -inward.z };
  const xs = poly.map((p) => p.x);
  const zs = poly.map((p) => p.z);
  const half = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2;
  return { center: centroid(poly), taper: m, bevel: mid(far), wall: { at: m, inward }, half };
}

/** Where a ray from the origin along `dir` leaves a convex outline around the origin (the farthest crossing). */
function rayExit(poly: Ground[], dir: Ground): Ground {
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
    const e = { x: b.x - a.x, z: b.z - a.z };
    const den = dir.x * e.z - dir.z * e.x;
    if (Math.abs(den) < 1e-12) continue;
    const t = (a.x * e.z - a.z * e.x) / den;
    const u = (a.x * dir.z - a.z * dir.x) / den;
    if (t > best && u >= -1e-9 && u <= 1 + 1e-9) best = t;
  }
  return { x: dir.x * best, z: dir.z * best };
}

/** How much a volume's outline is scaled at height y by its taper (1 at the bottom, 1 − taper at the top). */
const taperScale = (shape: ClosedShape, y: number) => 1 - ((shape.taper ?? 0) * y) / shape.height;
/** The largest radius a volume's bevel can have: bevel 1. */
export const maxBevelRadius = (shape: ClosedShape) => Math.min(shape.height, taperScale(shape, shape.height) * profileSpokes(shape).half);
/** The thickest wall a room can have and keep an inside. */
export const maxWall = (shape: ClosedShape) => Math.max(MIN_WALL, round2(profileSpokes(shape).half - 0.05));

/**
 * Where a profile knob sits, in the shape's own frame:
 * - the taper knob on the top, where the side would meet it without a bevel (at the center when it's a point);
 * - the bevel knob on the side, where its rounding starts (at the top edge when there's none);
 * - the wall knob on the wall's inner face, halfway up.
 */
export function profileKnob(shape: ClosedShape, part: ProfilePart): Point3 {
  const s = profileSpokes(shape);
  const h = shape.height;
  const along = (p: Ground, k: number, y: number) => ({ x: s.center.x + (p.x - s.center.x) * k, y, z: s.center.z + (p.z - s.center.z) * k });
  if (part === "taper") return along(s.taper, taperScale(shape, h), h);
  if (part === "bevel") {
    const y = h - (shape.bevel ?? 0) * maxBevelRadius(shape);
    return along(s.bevel, taperScale(shape, y), y);
  }
  const w = wallOf(shape);
  return { x: s.wall.at.x + s.wall.inward.x * w, y: h / 2, z: s.wall.at.z + s.wall.inward.z * w };
}

/** A profile knob in the world. */
export const profileKnobPoint = (shape: ClosedShape, part: ProfilePart): Vec3 => toWorld3(shape, profileKnob(shape, part));

/** The profile knobs a single shape has: the wall's for a room, taper's and bevel's for a volume or hole (no bevel once the top is a point). */
export function profileParts(shape: Shape): ProfilePart[] {
  if (!isClosed(shape)) return [];
  if (shape.kind === "room") return ["wall"];
  return maxBevelRadius(shape) > 1e-6 ? ["taper", "bevel"] : ["taper"];
}

/**
 * The resize cursor for a scale handle, from the direction it points on screen (center → handle), so it stays
 * right at any yaw and rotation.
 */
export function scaleCursor(
  cam: CameraState,
  size: Size,
  box: Shape,
  part: ScalePart,
  f: Frame = handleFrame(box),
): "ns" | "ew" | "nwse" | "nesw" {
  const c = worldToScreen(cam, size, { x: f.x, y: topOf(box), z: f.z });
  const h = worldToScreen(cam, size, scaleHandlePoint(box, part, f));
  if (!c || !h) return "nwse";
  const deg = ((Math.atan2(h.sy - c.sy, h.sx - c.sx) * 180) / Math.PI + 180) % 180; // 0..180, screen y down
  return deg < 22.5 || deg >= 157.5 ? "ew" : deg < 67.5 ? "nwse" : deg < 112.5 ? "ns" : "nesw";
}

/**
 * Where the rotate handle sits: just outside the (-x, -z) top corner of the selection frame, out along the diagonal.
 * For a single box that's the box's own corner, so it turns with the box, and for anything else the frame turns
 * as the selection is turned (see `selectionFrame`). `inward` points back toward the corner (the ring's gap faces
 * it). `scale` is the gizmo scale.
 */
export function rotateHandlePlacement(
  boxes: Shape[],
  scale: number,
  frame: Frame = selectionFrame(boxes),
): { point: Vec3; inward: { x: number; z: number } } {
  const offset = ROTATE_OFFSET * scale;
  const { ex, ez } = shapeAxes(frame);
  const corner = fromShapeLocal(frame, { x: -frame.width / 2, z: -frame.depth / 2 });
  const out = { x: -(ex.x + ez.x) / Math.SQRT2, z: -(ex.z + ez.z) / Math.SQRT2 };
  const y = boundsOf(boxes).maxY;
  return { point: { x: corner.x + out.x * offset, y, z: corner.z + out.z * offset }, inward: { x: -out.x, z: -out.z } };
}

/** The smallest factor a uniform scale drag goes to (a tenth). */
const MIN_SCALE_DRAG = 0.1;

/** The uniform scale handle's size (a cube), in gizmo units, and how it snaps: 0.05 steps, 0.25 with Shift (14.3). */
export const UNIFORM_HANDLE = 0.3;
export const UNIFORM_SNAP = 0.05;
export const UNIFORM_SNAP_SHIFT = 0.25;

/**
 * Where the uniform scale handle sits: just outside the top corner opposite the rotate handle (the frame's +x, +z
 * corner), at the top of the bounds.
 */
export function uniformHandlePoint(boxes: Shape[], scale: number, frame: Frame = selectionFrame(boxes)): Vec3 {
  const offset = ROTATE_OFFSET * scale;
  const { ex, ez } = shapeAxes(frame);
  const corner = fromShapeLocal(frame, { x: frame.width / 2, z: frame.depth / 2 });
  const out = { x: (ex.x + ez.x) / Math.SQRT2, z: (ex.z + ez.z) / Math.SQRT2 };
  return { x: corner.x + out.x * offset, y: boundsOf(boxes).maxY, z: corner.z + out.z * offset };
}

/** What a uniform scale drag scales about: the bottom center of the selection's bounds (as transform_nodes). */
export const uniformPivot = (b: Bounds) => ({ x: round2((b.minX + b.maxX) / 2), y: round2(b.minY), z: round2((b.minZ + b.maxZ) / 2) });

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/**
 * A tilt ring of a box or cylinder: a circle around its center, square to the axis it turns around. `pitch` turns
 * around the shape's own x axis as turned by its rotation (it stays level); `roll` around its own z axis as tilted
 * by its pitch. `u` and `v` span the ring's plane, with v = axis × u, so a right-handed turn goes from u toward v.
 */
export function tiltRing(shape: Shape, part: TiltPart): { center: Vec3; axis: Vec3; u: Vec3; v: Vec3 } {
  if (!isFootprinted(shape)) throw new Error("only boxes and cylinders tilt");
  const center = toWorld3(shape, { x: 0, y: shape.height / 2, z: 0 });
  let axis: Vec3;
  if (part === "pitch") {
    const { ex } = shapeAxes(shape);
    axis = { x: ex.x, y: 0, z: ex.z };
  } else {
    const tip = toWorld3(shape, { x: 0, y: shape.height / 2, z: 1 });
    axis = unit({ x: tip.x - center.x, y: tip.y - center.y, z: tip.z - center.z });
  }
  // Any direction square to the axis: from up, or from x when the axis is (nearly) vertical.
  const seed = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = unit(cross(cross(axis, seed), axis));
  return { center, axis, u, v: cross(axis, u) };
}

/** Points around a tilt ring, in the world, for drawing it and for hit testing it on screen. */
export function tiltRingPoints(ring: ReturnType<typeof tiltRing>, scale: number, n = 48): Vec3[] {
  const r = TILT_RADIUS * scale;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const [c, s] = [Math.cos(a) * r, Math.sin(a) * r];
    return { x: ring.center.x + ring.u.x * c + ring.v.x * s, y: ring.center.y + ring.u.y * c + ring.v.y * s, z: ring.center.z + ring.u.z * c + ring.v.z * s };
  });
}

/**
 * The cursor's angle around a tilt ring's axis, in degrees (from u toward v): where the cursor's ray meets the
 * ring's plane. When the plane is seen edge-on, the cursor's offset on screen is read in the plane's projected axes
 * instead.
 */
function ringAngle(cam: CameraState, size: Size, sx: number, sy: number, ring: ReturnType<typeof tiltRing>): number {
  const { origin: o, dir: d } = screenRay(cam, size, sx, sy);
  const facing = dot(d, ring.axis);
  if (Math.abs(facing) > 0.15) {
    const t = dot({ x: ring.center.x - o.x, y: ring.center.y - o.y, z: ring.center.z - o.z }, ring.axis) / facing;
    const p = { x: o.x + d.x * t - ring.center.x, y: o.y + d.y * t - ring.center.y, z: o.z + d.z * t - ring.center.z };
    return (Math.atan2(dot(p, ring.v), dot(p, ring.u)) * 180) / Math.PI;
  }
  const c = worldToScreen(cam, size, ring.center);
  const cu = worldToScreen(cam, size, add(ring.center, ring.u, 1));
  const cv = worldToScreen(cam, size, add(ring.center, ring.v, 1));
  if (!c || !cu || !cv) return 0;
  // Solve cursor − c = a·U + b·V on screen.
  const [ux, uy, vx, vy] = [cu.sx - c.sx, cu.sy - c.sy, cv.sx - c.sx, cv.sy - c.sy];
  const [px, py] = [sx - c.sx, sy - c.sy];
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-9) return 0;
  return (Math.atan2((ux * py - uy * px) / det, (px * vy - py * vx) / det) * 180) / Math.PI;
}

/**
 * An angle as a tilt is sent: -180..180 (180 rather than -180), 2 decimals. Level is 0, never undefined: a patch
 * travels as JSON, which drops undefined keys, so `{ roll: undefined }` would reach the server empty and leave the
 * old tilt in place. The server stores 0 as none.
 */
export function tiltValue(deg: number): number {
  const a = round2(normalizeDeg(deg + 180) - 180);
  return a === 0 ? 0 : a === -180 ? 180 : a;
}

/** The angle of a ground vector in degrees, counterclockwise seen from above (the rotation convention). */
const angleOf = (x: number, z: number) => (Math.atan2(-z, x) * 180) / Math.PI;

/** Where the gizmo sits: the selection frame's center (the bounds' by default), at the top of the bounds. */
export const gizmoAnchor = (b: Bounds, frame?: Frame): Vec3 =>
  frame ? { x: frame.x, y: b.maxY, z: frame.z } : { x: (b.minX + b.maxX) / 2, y: b.maxY, z: (b.minZ + b.maxZ) / 2 };

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
 * nearest handle wins. Scale and rotate handles need the selected `boxes` (and sit on `frame`, their selection
 * frame).
 */
export function hitGizmo(
  cam: CameraState,
  size: Size,
  sx: number,
  sy: number,
  anchor: Vec3,
  parts: GizmoPart[],
  boxes: Shape[] = [],
  frame: Frame | undefined = boxes.length > 0 ? selectionFrame(boxes) : undefined,
): GizmoPart | null {
  const scale = gizmoScale(cam);
  const box = boxes.length === 1 ? boxes[0] : undefined;
  if (parts.includes("height")) {
    const up = box && isClosed(box) && isTilted(box) ? shapeAxis(box, "y") : AXES.y;
    const p = worldToScreen(cam, size, add(heightHandlePoint(box, anchor), up, (HEIGHT_HANDLE / 2) * scale));
    if (p && Math.hypot(p.sx - sx, p.sy - sy) <= HANDLE_HIT_PX) return "height";
  }
  let best: { part: GizmoPart; d: number } | null = null;
  if (parts.includes("rotate") && boxes.length > 0) {
    // The ring is bigger than a point handle: anywhere within its radius (on screen) grabs it.
    const { point } = rotateHandlePlacement(boxes, scale, frame);
    const c = worldToScreen(cam, size, point);
    const rim = worldToScreen(cam, size, add(point, AXES.y, ROTATE_RADIUS * scale));
    if (c && rim) {
      const d = Math.hypot(c.sx - sx, c.sy - sy);
      if (d <= Math.hypot(rim.sx - c.sx, rim.sy - c.sy) + HANDLE_HIT_PX / 2) best = { part: "rotate", d };
    }
  }
  if (parts.includes("uniform") && boxes.length > 0) {
    const p = worldToScreen(cam, size, uniformHandlePoint(boxes, scale, frame));
    const d = p ? Math.hypot(p.sx - sx, p.sy - sy) : Infinity;
    if (d <= HANDLE_HIT_PX + 2 && (!best || d < best.d)) best = { part: "uniform", d };
  }
  if (box) {
    for (const part of ["pitch", "roll"] as const) {
      if (!parts.includes(part)) continue;
      const screen = tiltRingPoints(tiltRing(box, part), scale).map((p) => worldToScreen(cam, size, p));
      for (let i = 0; i < screen.length; i++) {
        const [a, b] = [screen[i], screen[(i + 1) % screen.length]];
        if (!a || !b) continue;
        const d = segmentDistance(sx, sy, a, b);
        if (d <= HANDLE_HIT_PX && (!best || d < best.d)) best = { part, d };
      }
    }
    for (const part of parts.filter(isScalePart)) {
      const p = worldToScreen(cam, size, scaleHandlePoint(box, part, frame));
      const d = p ? Math.hypot(p.sx - sx, p.sy - sy) : Infinity;
      if (d <= HANDLE_HIT_PX && (!best || d < best.d)) best = { part, d };
    }
    // The profile knobs are small and sit near the scale handles: they win when the cursor is as close to them.
    for (const part of parts.filter(isProfilePart)) {
      if (!isClosed(box)) continue;
      const p = worldToScreen(cam, size, profileKnobPoint(box, part));
      const d = p ? Math.hypot(p.sx - sx, p.sy - sy) : Infinity;
      if (d <= HANDLE_HIT_PX && (!best || d <= best.d)) best = { part, d };
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

/** What the bottom of a raised selection can snap to: the ground, and the tops of the shapes under it (not holes). */
export function elevationTargets(moving: Bounds, others: Shape[]): number[] {
  const targets = [0];
  for (const box of others) {
    // Nothing stands on a line or a hole.
    if (box.type === "line" || box.type === "note" || box.type === "instance" || box.type === "array" || box.kind === "hole") continue;
    const f = footprintBounds(box);
    const overlaps = f.minX < moving.maxX && f.maxX > moving.minX && f.minZ < moving.maxZ && f.maxZ > moving.minZ;
    if (overlaps) targets.push(round2(topOf(box)));
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
 * A drag in progress, as captured on pointer-down. `origin` is the dragged boxes as they were, `bounds` their
 * bounds and `frame` their selection frame (the gizmo's center and turn). `grab` is the grabbed world point for a
 * body drag (it stays under the cursor), and the starting position along the handle's line for the others.
 */
export type GizmoDrag = { part: DragPart; origin: Shape[]; bounds: Bounds; frame: Frame; grab: Vec3 | number; line?: { origin: Vec3; axis: Vec3 } };

export type DragModifiers = { shift: boolean; alt: boolean; snap: boolean };

/**
 * Starts a drag on a handle: remembers where along its line the cursor is, or for a scale handle how far the
 * cursor is from the handle (in the box's frame, on the top face's plane), so the handle doesn't jump.
 */
export function startHandleDrag(
  cam: CameraState,
  size: Size,
  sx: number,
  sy: number,
  part: GizmoPart,
  origin: Shape[],
  frame: Frame = selectionFrame(origin),
): GizmoDrag {
  const bounds = boundsOf(origin);
  if (part === "pitch" || part === "roll") {
    return { part, origin, bounds, frame, grab: ringAngle(cam, size, sx, sy, tiltRing(origin[0], part)) };
  }
  if (part === "uniform") {
    // How far the cursor is from the pivot, on the ground plane under it: the factor is the ratio to this.
    const pivot = uniformPivot(bounds);
    const p = screenToPlane(cam, size, sx, sy, bounds.maxY);
    return { part, origin, bounds, frame, grab: Math.max(1e-3, Math.hypot(p.x - pivot.x, p.z - pivot.z)) };
  }
  if (part === "rotate") {
    // The cursor's angle around the pivot (the selection frame's center), on the plane of its top.
    const p = screenToPlane(cam, size, sx, sy, bounds.maxY);
    const pivot = gizmoAnchor(bounds, frame);
    return { part, origin, bounds, frame, grab: angleOf(p.x - pivot.x, p.z - pivot.z) };
  }
  if (isScalePart(part)) {
    const shape = origin[0];
    const [hx, hz] = signs(part);
    const l = topLocal(cam, size, sx, sy, shape, frame) ?? { x: (hx * frame.width) / 2, z: (hz * frame.depth) / 2 };
    return { part, origin, bounds, frame, grab: { x: l.x - (hx * frame.width) / 2, y: 0, z: l.z - (hz * frame.depth) / 2 } };
  }
  const shape = origin[0];
  if (isProfilePart(part) && isClosed(shape)) {
    const knob = profileKnob(shape, part);
    if (part === "bevel") {
      // Along the shape's own vertical through the knob: the grab is the knob's height minus the cursor's there.
      const line = { origin: toWorld3(shape, knob), axis: shapeAxis(shape, "y") };
      return { part, origin, bounds, frame, line, grab: paramOnLine(cam, size, sx, sy, line.origin, line.axis) };
    }
    // On the plane of the knob: how far the cursor is from it along its line (the taper's spoke, the wall's normal).
    const at = cursorInShape(cam, size, sx, sy, shape, knob.y);
    return { part, origin, bounds, frame, grab: at ? profileAlong(shape, part, at) - profileAlong(shape, part, knob) : 0 };
  }
  if (part === "height" && isClosed(shape) && isTilted(shape)) {
    const line = { origin: heightHandlePoint(shape, gizmoAnchor(bounds, frame)), axis: shapeAxis(shape, "y") };
    return { part, origin, bounds, frame, line, grab: paramOnLine(cam, size, sx, sy, line.origin, line.axis) };
  }
  const axis = part === "height" ? AXES.y : AXES[part as "x" | "y" | "z"];
  return { part, origin, bounds, frame, grab: paramOnLine(cam, size, sx, sy, gizmoAnchor(bounds, frame), axis) };
}

/** Starts a body drag at the point where the cursor hit a box. */
export const startBodyDrag = (origin: Shape[], grab: Vec3, frame: Frame = selectionFrame(origin)): GizmoDrag => ({
  part: "body",
  origin,
  bounds: boundsOf(origin),
  frame,
  grab,
});

/**
 * The boxes' changes for the cursor at (sx, sy), plus the live label. `others` are the boxes not being dragged
 * (for elevation snapping). Patches hold only the fields the drag changes. A rotate drag also gives `turn`, the
 * selection frame's new angle.
 */
export function dragUpdate(
  drag: GizmoDrag,
  cam: CameraState,
  size: Size,
  sx: number,
  sy: number,
  mods: DragModifiers,
  others: Shape[],
): { patches: Record<string, ShapePatch>; label: string; turn?: number; scale?: number } {
  const { part, origin, bounds, frame } = drag;
  const anchor = gizmoAnchor(bounds, frame);
  const patches: Record<string, ShapePatch> = {};

  if (isScalePart(part)) return scaleUpdate(drag, part, cam, size, sx, sy, mods);
  if (part === "uniform") {
    const pivot = uniformPivot(bounds);
    const p = screenToPlane(cam, size, sx, sy, bounds.maxY);
    const raw = Math.hypot(p.x - pivot.x, p.z - pivot.z) / (drag.grab as number);
    const step = mods.shift ? UNIFORM_SNAP_SHIFT : UNIFORM_SNAP;
    const factor = round2(Math.min(MAX_SCALE, Math.max(MIN_SCALE_DRAG, mods.snap ? Math.max(step, snapTo(raw, step)) : raw)));
    for (const s of origin) patches[s.id] = transformShape(s, { pivot, scale: factor });
    return { patches, label: `×${factor.toFixed(2)}`, scale: factor };
  }
  if (isProfilePart(part)) return profileUpdate(drag, part, cam, size, sx, sy, mods);

  if (part === "rotate") {
    const p = screenToPlane(cam, size, sx, sy, bounds.maxY);
    let delta = normalizeDeg(angleOf(p.x - anchor.x, p.z - anchor.z) - (drag.grab as number));
    if (delta > 180) delta -= 360;
    // The frame's angle (a single box's own rotation, or how far this selection has been turned) snaps to whole
    // 15° angles, and the label shows it.
    if (mods.snap) delta = snapTo(frame.rotation + delta, ROTATE_SNAP) - frame.rotation;
    Object.assign(patches, rotateAround(origin, anchor, delta));
    const turn = round2(normalizeDeg(frame.rotation + delta)) % 360;
    return { patches, label: `${turn}°`, turn };
  }

  if (part === "pitch" || part === "roll") {
    const box = origin[0];
    if (!isFootprinted(box)) return { patches, label: "" };
    let delta = normalizeDeg(ringAngle(cam, size, sx, sy, tiltRing(box, part)) - (drag.grab as number));
    if (delta > 180) delta -= 360;
    const before = box[part] ?? 0;
    const raw = before + delta;
    const next = tiltValue(mods.snap ? snapTo(raw, ROTATE_SNAP) : raw);
    patches[box.id] = { [part]: next };
    return { patches, label: `${part} ${next}°` };
  }

  if (part === "height") {
    const box = origin[0];
    if (!isClosed(box)) return { patches, label: "" };
    const line = drag.line ?? { origin: anchor, axis: AXES.y };
    const s = paramOnLine(cam, size, sx, sy, line.origin, line.axis);
    const raw = box.height + s - (drag.grab as number);
    const height = round2(Math.max(MIN_HEIGHT, mods.snap ? snapTo(raw, HEIGHT_SNAP) : raw));
    patches[box.id] = { height };
    if (isTilted(box)) {
      // The bottom stays put: the tilt's pivot (the center) moves half the change up the shape's own axis.
      const c = toWorld3(box, { x: 0, y: height / 2, z: 0 });
      patches[box.id] = { height, x: round2(c.x), z: round2(c.z), y: round2(c.y - height / 2) };
    }
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
    const d = paramOnLine(cam, size, sx, sy, anchor, AXES[part as "x" | "z"]) - (drag.grab as number);
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
  // The math runs on the selection frame: a box's own rectangle, a free-form's bounds (turned as it was turned).
  const box = drag.frame;
  const grab = drag.grab as Vec3;
  const [hx, hz] = signs(part);
  const l = topLocal(cam, size, sx, sy, shape, box);
  if (!l) return { patches: {}, label: "" };
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
  const label = `${width.toFixed(2)} × ${depth.toFixed(2)} m`;
  const offset = { x: shift(hx, width, box.width), z: shift(hz, depth, box.depth) };
  if (isClosed(shape) && isTilted(shape)) {
    // The fixed side stays put in the world: the center (the tilt's pivot) moves along the shape's tilted axes.
    const c = toWorld3(shape, { ...offset, y: shape.height / 2 });
    return { patches: { [shape.id]: { x: round2(c.x), z: round2(c.z), y: round2(c.y - shape.height / 2), width, depth } }, label };
  }
  const c = fromShapeLocal(box, offset);
  const to = isFootprinted(shape) ? { x: round2(c.x), z: round2(c.z), width, depth } : { x: c.x, z: c.z, width, depth };
  return { patches: { [shape.id]: resizeShape(shape, box, to) }, label };
}

/**
 * The cursor on a shape's top face, in its handle frame: on the plane of its top (a tilted shape's own tilted
 * top, in its own frame). Null when that plane can't be hit (seen edge-on).
 */
function topLocal(cam: CameraState, size: Size, sx: number, sy: number, shape: Shape, frame: Frame): { x: number; z: number } | null {
  if (isClosed(shape) && isTilted(shape)) return cursorInShape(cam, size, sx, sy, shape, shape.height);
  return toShapeLocal(frame, screenToPlane(cam, size, sx, sy, topOf(shape)));
}

/**
 * How far along its line a point on a profile knob's plane is, in the shape's own frame: for the taper, the
 * fraction of the way from the center out to the outline along the taper's spoke (1 − taper at the knob); for the
 * wall, the distance into the room from the outline along the wall's inward direction (the thickness at the knob).
 */
function profileAlong(shape: ClosedShape, part: "wall" | "taper", p: { x: number; z: number }): number {
  const s = profileSpokes(shape);
  if (part === "wall") return (p.x - s.wall.at.x) * s.wall.inward.x + (p.z - s.wall.at.z) * s.wall.inward.z;
  const d = { x: s.taper.x - s.center.x, z: s.taper.z - s.center.z };
  const l2 = d.x * d.x + d.z * d.z || 1;
  return ((p.x - s.center.x) * d.x + (p.z - s.center.z) * d.z) / l2;
}

/**
 * A profile knob drag. The taper knob slides along its spoke on the top (at the center it's a point), the bevel
 * knob down the side (the rounding's radius, as a fraction of the largest it can be), the wall knob across the wall
 * (its thickness, MIN_WALL up to what leaves an inside). All snap to 0.05 (`Cmd/Ctrl`: free).
 */
function profileUpdate(
  drag: GizmoDrag,
  part: ProfilePart,
  cam: CameraState,
  size: Size,
  sx: number,
  sy: number,
  mods: DragModifiers,
): { patches: Record<string, ShapePatch>; label: string } {
  const shape = drag.origin[0];
  if (!isClosed(shape)) return { patches: {}, label: "" };
  const snap = (v: number) => (mods.snap ? snapTo(v, PROFILE_SNAP) : v);
  if (part === "bevel") {
    const line = drag.line!;
    const drop = shape.height - profileKnob(shape, "bevel").y - (paramOnLine(cam, size, sx, sy, line.origin, line.axis) - (drag.grab as number));
    const max = maxBevelRadius(shape);
    const bevel = round2(Math.min(1, Math.max(0, snap(max > 0 ? drop / max : 0))));
    return { patches: { [shape.id]: { bevel: kept(bevel, shape.bevel, 0) } }, label: `bevel ${bevel.toFixed(2)}` };
  }
  const knob = profileKnob(shape, part);
  const at = cursorInShape(cam, size, sx, sy, shape, knob.y);
  if (!at) return { patches: {}, label: "" };
  const v = profileAlong(shape, part, at) - (drag.grab as number);
  if (part === "taper") {
    const taper = round2(Math.min(1, Math.max(0, snap(1 - v))));
    return { patches: { [shape.id]: { taper: kept(taper, shape.taper, 0) } }, label: `taper ${taper.toFixed(2)}` };
  }
  const wall = round2(Math.min(maxWall(shape), Math.max(MIN_WALL, snap(v))));
  return { patches: { [shape.id]: { wall: kept(wall, shape.wall, DEFAULT_WALL) } }, label: `wall ${wall.toFixed(2)} m` };
}

/**
 * A profile value to send: the shape's own stored value when it's the same as the new one (so a drag back to where
 * it started changes nothing, even when the stored value is "none"), else the new value (0 levels a taper or a
 * bevel: never undefined, which JSON would drop).
 */
const kept = (next: number, stored: number | undefined, none: number) => (next === (stored ?? none) ? stored : next);

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

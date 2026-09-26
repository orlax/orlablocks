import type { View } from "../shared/scene.types";

/**
 * Pure camera math for the editor's 3D view. No three.js here, so it's unit-testable.
 *
 * A perspective camera with a narrow field of view (a long lens, so perspective stays mild) orbits the focus
 * point (a point on the ground, y = 0) at a fixed pitch, rotating only by yaw. At yaw 0 it sits on the +z side
 * looking toward -z, so +x points right and +z points down the screen. Zoom moves the camera toward or away
 * from the focus point along the view direction, so it always pivots on the screen center.
 */

export type CameraState = {
  focus: { x: number; z: number };
  yaw: number; // degrees, 0..360
  distance: number; // meters from the camera to the focus point
};

export type Size = { width: number; height: number };
export type Vec3 = { x: number; y: number; z: number };
export type GroundPoint = { x: number; z: number };

export const PITCH_DEG = 35;
/** Vertical field of view. Narrow on purpose: less perspective distortion. Must stay below 2 × PITCH_DEG. */
export const FOV_DEG = 30;
export const MIN_DISTANCE = 8;
export const MAX_DISTANCE = 600;
export const YAW_SPEED_DEG = 90; // per second while A/D or ←/→ is held

/** About 20 px per meter at the focus point in an 800 px tall window, like the old 2D editor. */
export const DEFAULT_CAMERA: CameraState = { focus: { x: 0, z: 0 }, yaw: 45, distance: 75 };

const rad = (deg: number) => (deg * Math.PI) / 180;
const round2 = (n: number) => Math.round(n * 100) / 100;
const TAN_HALF_FOV = Math.tan(rad(FOV_DEG) / 2);

export const normalizeYaw = (deg: number) => ((deg % 360) + 360) % 360;
export const clampDistance = (d: number) => Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, d));

/** Unit vectors of the camera: `forward` looks at the focus, `right` and `up` span the screen. */
export function basis(yaw: number) {
  const y = rad(yaw);
  const p = rad(PITCH_DEG);
  const forward: Vec3 = { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: -Math.cos(y) * Math.cos(p) };
  const right: Vec3 = { x: Math.cos(y), y: 0, z: -Math.sin(y) };
  const up: Vec3 = { x: -Math.sin(p) * Math.sin(y), y: Math.cos(p), z: -Math.sin(p) * Math.cos(y) };
  return { forward, right, up };
}

export function cameraPosition(cam: CameraState): Vec3 {
  const { forward } = basis(cam.yaw);
  return {
    x: cam.focus.x - forward.x * cam.distance,
    y: -forward.y * cam.distance,
    z: cam.focus.z - forward.z * cam.distance,
  };
}

/** Screen pixels per meter at the focus point. Things nearer the camera look bigger, farther ones smaller. */
export function pxPerMeterAtFocus(cam: CameraState, size: Size): number {
  return size.height / 2 / (cam.distance * TAN_HALF_FOV);
}

/** The ray from the camera through a screen position (CSS px from the viewport's top-left). `dir` isn't normalized. */
export function screenRay(cam: CameraState, size: Size, sx: number, sy: number): { origin: Vec3; dir: Vec3 } {
  const { forward, right, up } = basis(cam.yaw);
  const ndcX = (sx / size.width) * 2 - 1;
  const ndcY = 1 - (sy / size.height) * 2;
  const a = ndcX * TAN_HALF_FOV * (size.width / size.height);
  const b = ndcY * TAN_HALF_FOV;
  return {
    origin: cameraPosition(cam),
    dir: {
      x: forward.x + right.x * a + up.x * b,
      y: forward.y + right.y * a + up.y * b,
      z: forward.z + right.z * a + up.z * b,
    },
  };
}

/** The ground point under a screen position (CSS px from the viewport's top-left). */
export function screenToGround(cam: CameraState, size: Size, sx: number, sy: number): GroundPoint {
  const { origin, dir } = screenRay(cam, size, sx, sy);
  // Every ray points down as long as FOV_DEG / 2 < PITCH_DEG, so it always meets the ground.
  const t = -origin.y / dir.y;
  return { x: origin.x + dir.x * t, z: origin.z + dir.z * t };
}

/** Where a world point lands on screen (CSS px), or null if it's behind the camera. */
export function worldToScreen(cam: CameraState, size: Size, p: Vec3): { sx: number; sy: number } | null {
  const { forward, right, up } = basis(cam.yaw);
  const o = cameraPosition(cam);
  const v = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
  const depth = v.x * forward.x + v.y * forward.y + v.z * forward.z;
  if (depth <= 0) return null;
  const ndcX = (v.x * right.x + v.y * right.y + v.z * right.z) / (depth * TAN_HALF_FOV * (size.width / size.height));
  const ndcY = (v.x * up.x + v.y * up.y + v.z * up.z) / (depth * TAN_HALF_FOV);
  return { sx: ((ndcX + 1) / 2) * size.width, sy: ((1 - ndcY) / 2) * size.height };
}

/**
 * The height on the vertical line through ground point (x, z) closest to the ray under the cursor.
 * This is how the height gizmo follows the cursor at any yaw.
 */
export function heightOnVertical(cam: CameraState, size: Size, sx: number, sy: number, x: number, z: number): number {
  const { origin, dir } = screenRay(cam, size, sx, sy);
  // Closest points between the ray origin + t·dir and the line (x, s, z): minimize over t and s.
  const w = { x: origin.x - x, y: origin.y, z: origin.z - z };
  const a = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
  const b = dir.y; // dir · (0, 1, 0)
  const d = w.x * dir.x + w.y * dir.y + w.z * dir.z;
  const e = w.y; // w · (0, 1, 0)
  const denom = a - b * b; // > 0: the ray is never vertical at our pitch
  return (a * e - b * d) / denom; // s at the closest point, i.e. the height on the vertical line
}

/** Moves the focus so that `grabbed` (a ground point) ends up under the screen position. */
export function panTo(cam: CameraState, size: Size, grabbed: GroundPoint, sx: number, sy: number): CameraState {
  const under = screenToGround(cam, size, sx, sy);
  return { ...cam, focus: { x: cam.focus.x + grabbed.x - under.x, z: cam.focus.z + grabbed.z - under.z } };
}

/** Wheel zoom toward the focus point. `deltaY` > 0 zooms out. Trackpad pinches (ctrlKey) send small deltas. */
export function zoomBy(cam: CameraState, deltaY: number, pinch = false): CameraState {
  const factor = Math.exp(deltaY * (pinch ? 0.01 : 0.0015));
  return { ...cam, distance: clampDistance(cam.distance * factor) };
}

export function rotateBy(cam: CameraState, deltaDeg: number): CameraState {
  return { ...cam, yaw: normalizeYaw(cam.yaw + deltaDeg) };
}

/** The ground points under the four screen corners. */
export function visibleGround(cam: CameraState, size: Size): GroundPoint[] {
  return [
    screenToGround(cam, size, 0, 0),
    screenToGround(cam, size, size.width, 0),
    screenToGround(cam, size, 0, size.height),
    screenToGround(cam, size, size.width, size.height),
  ];
}

/** What the editor shows, as reported to the server: focus, yaw and the axis-aligned box around the visible ground. */
export function viewOf(cam: CameraState, size: Size): View {
  const corners = visibleGround(cam, size);
  const xs = corners.map((c) => c.x);
  const zs = corners.map((c) => c.z);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  return {
    focus: { x: round2(cam.focus.x), z: round2(cam.focus.z) },
    yaw: round2(cam.yaw),
    bounds: {
      x: round2(minX),
      z: round2(minZ),
      width: round2(Math.max(...xs) - minX),
      depth: round2(Math.max(...zs) - minZ),
    },
  };
}

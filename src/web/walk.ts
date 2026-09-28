import type { PlayerCamera, WalkPreset } from "../shared/scene.types";

/**
 * The Walk tool's pure math (plan 09 §5): a pose moved by the keys and the mouse, the camera for each preset,
 * floor-follow, and the frame guide. No three.js here, so it's unit-tested.
 *
 * Directions follow the editor camera: `yaw` 0 looks north (-z), and it grows counterclockwise seen from above, so
 * turning right lowers it. `pitch` is up, in degrees.
 */

export type Vec3 = { x: number; y: number; z: number };
/** Where the walker stands (the feet), and where it looks. */
export type Pose = { feet: Vec3; yaw: number; pitch: number };
/** The movement keys held. */
export type MoveKeys = { forward: boolean; back: boolean; left: boolean; right: boolean; up: boolean; down: boolean; fast: boolean };
export const NO_KEYS: MoveKeys = { forward: false, back: false, left: false, right: false, up: false, down: false, fast: false };

/** The highest floor stepped onto: stairs are climbed, anything taller is walked through at the floor's height. */
export const STEP_HEIGHT = 0.45;
export const PITCH_LIMIT = 85;
/** Mouse look, in degrees per pixel of movement. */
export const LOOK_DEG_PER_PX = 0.12;
/** `Shift`'s speed-up. */
export const FAST = 3;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 20;
/** How fast the eye follows a new floor: stepping up quickly, dropping a bit slower (seconds, roughly). */
const RISE_S = 0.1;
const FALL_S = 0.25;

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const normalizeYaw = (d: number) => ((d % 360) + 360) % 360;

/** The unit vector the pose looks along. */
export function lookDir(yaw: number, pitch: number): Vec3 {
  const y = rad(yaw);
  const p = rad(pitch);
  return { x: -Math.sin(y) * Math.cos(p), y: Math.sin(p), z: -Math.cos(y) * Math.cos(p) };
}

/** Level unit vectors: ahead (the look direction flattened) and to the right. */
function flat(yaw: number) {
  const y = rad(yaw);
  return { ahead: { x: -Math.sin(y), z: -Math.cos(y) }, right: { x: Math.cos(y), z: -Math.sin(y) } };
}

/** Mouse look: moving right turns right, moving up looks up (pixels, as the pointer lock reports them). */
export function look(pose: Pose, dx: number, dy: number): Pose {
  return { ...pose, yaw: normalizeYaw(pose.yaw - dx * LOOK_DEG_PER_PX), pitch: clamp(pose.pitch - dy * LOOK_DEG_PER_PX, -PITCH_LIMIT, PITCH_LIMIT) };
}

/**
 * The pose after `dt` seconds with `keys` held: `WASD` along the ground (never up or down, whatever the pitch, and
 * no faster diagonally), `E` / `Q` straight up and down, and `Shift` 3 × as fast.
 */
export function move(pose: Pose, keys: MoveKeys, speed: number, dt: number): Pose {
  const { ahead, right } = flat(pose.yaw);
  let fx = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  let rx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const len = Math.hypot(fx, rx);
  if (len > 1) {
    fx /= len;
    rx /= len;
  }
  const up = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  const d = speed * (keys.fast ? FAST : 1) * dt;
  if (d === 0 || (fx === 0 && rx === 0 && up === 0)) return pose;
  return {
    ...pose,
    feet: {
      x: pose.feet.x + (ahead.x * fx + right.x * rx) * d,
      y: pose.feet.y + up * d,
      z: pose.feet.z + (ahead.z * fx + right.z * rx) * d,
    },
  };
}

/** The eye: `eyeHeight` above the feet. */
export const eyeOf = (pose: Pose, eyeHeight: number): Vec3 => ({ x: pose.feet.x, y: pose.feet.y + eyeHeight, z: pose.feet.z });

/** A third-person camera's boom: behind the eye, above it and to its right. */
export type Boom = { distance: number; height: number; shoulder: number };

/**
 * Where the camera is and what it looks at. First person: the eye, looking along the pose. Third person: `boom`
 * back from the eye along the look, up and to the right, looking the same way (over the shoulder).
 */
export function walkCamera(pose: Pose, eyeHeight: number, preset: WalkPreset, boom: Boom): { position: Vec3; target: Vec3 } {
  const eye = eyeOf(pose, eyeHeight);
  const dir = lookDir(pose.yaw, pose.pitch);
  const { right } = flat(pose.yaw);
  const position =
    preset === "first"
      ? eye
      : {
          x: eye.x - dir.x * boom.distance + right.x * boom.shoulder,
          y: eye.y - dir.y * boom.distance + boom.height,
          z: eye.z - dir.z * boom.distance + right.z * boom.shoulder,
        };
  return { position, target: { x: position.x + dir.x, y: position.y + dir.y, z: position.z + dir.z } };
}

/** The player camera's field of view and boom for a preset. */
export function presetOf(player: PlayerCamera, preset: WalkPreset): { fov: number; boom: Boom } {
  return preset === "first"
    ? { fov: player.first.fov, boom: { distance: 0, height: 0, shoulder: 0 } }
    : { fov: player.third.fov, boom: { distance: player.third.distance, height: player.third.height, shoulder: player.third.shoulder } };
}

/** A face the downward ray crossed: its height, and how much it faces up (its normal's y: 1 = level, 0 = a wall). */
export type FloorHit = { y: number; up: number };

/**
 * The floor under the feet: the highest face that faces up (more than a steep slope) and is at most a step above the
 * feet, or the ground if the feet are over it. Null when there's nothing to stand on (under the ground, off every
 * floor): the feet stay where they are.
 */
export function floorUnder(hits: FloorHit[], feetY: number): number | null {
  const top = feetY + STEP_HEIGHT;
  let floor: number | null = top >= 0 ? 0 : null;
  for (const h of hits) if (h.up > 0.3 && h.y <= top + 1e-6 && (floor === null || h.y > floor)) floor = h.y;
  return floor;
}

/** The feet eased toward the floor over `dt` seconds: up quickly (a step), down a little slower (a drop). */
export function settle(y: number, floor: number, dt: number): number {
  const k = Math.min(1, dt / (floor > y ? RISE_S : FALL_S));
  const next = y + (floor - y) * k;
  return Math.abs(floor - next) < 0.005 ? floor : next;
}

/** The speed after a wheel turn (down = slower), within the limits. */
export const wheelSpeed = (speed: number, deltaY: number) => clamp(speed * Math.exp(-deltaY * 0.002), MIN_SPEED, MAX_SPEED);

/** The frame guide: the aspect ratio shots are cropped to, shown on screen as a frame. */
export type FrameGuide = "none" | "16:9" | "4:3" | "1:1" | "21:9";
export const FRAME_GUIDES: FrameGuide[] = ["16:9", "4:3", "1:1", "21:9", "none"];
const FRAME_ASPECT: Record<FrameGuide, number | null> = { none: null, "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1, "21:9": 21 / 9 };

/** The frame in a view of `width` × `height`: the largest rectangle of the guide's aspect, centered (all of it for none). */
export function frameRect(width: number, height: number, guide: FrameGuide): { x: number; y: number; width: number; height: number } {
  const aspect = FRAME_ASPECT[guide];
  if (!aspect || width <= 0 || height <= 0) return { x: 0, y: 0, width, height };
  const w = Math.min(width, height * aspect);
  const h = w / aspect;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

/** A vertical field of view (what three.js takes) from a horizontal one across a frame of `aspect`. */
export const verticalFov = (hfov: number, aspect: number) => deg(2 * Math.atan(Math.tan(rad(hfov) / 2) / aspect));

/**
 * The view's vertical field of view, so that the frame spans the player's horizontal one: the frame is what the game
 * shows, and a wider window sees more around it.
 */
export function viewVerticalFov(hfov: number, frame: { width: number; height: number }, viewHeight: number): number {
  const frameV = rad(verticalFov(hfov, frame.width / frame.height));
  return deg(2 * Math.atan(Math.tan(frameV / 2) * (viewHeight / frame.height)));
}

/** A shot's size: the frame's aspect with its long edge at `longEdge` pixels. */
export function shotSize(frame: { width: number; height: number }, longEdge: number): { width: number; height: number } {
  const scale = longEdge / Math.max(frame.width, frame.height);
  return { width: Math.max(1, Math.round(frame.width * scale)), height: Math.max(1, Math.round(frame.height * scale)) };
}

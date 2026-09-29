/**
 * 3D rotations for tilting anything (plan 14 §7): 3 × 3 matrices, pure. Every turn in the scene is right-handed, in
 * degrees: `rotation` (yaw) around +y (counterclockwise seen from above), `pitch` around +x and `roll` around +z, as
 * `toWorld3` applies them.
 *
 * A box, a cylinder or an instance is oriented as R = Ry(yaw) · Rx(pitch) · Rz(roll) (Euler "YXZ": roll first, yaw
 * last, so turning it only adds to its yaw). A free-form or an array has no yaw of its own (its points or layout
 * carry the turn), so its tilt is R = Rx(pitch) · Rz(roll), and a turn inside it is baked into its points: a tilt
 * composed onto one is split as Rx · Rz · Ry (Euler "XZY"), the Ry part turning its points or layout.
 */

export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Vec3 = { x: number; y: number; z: number };

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Right-handed turns around the world axes, in degrees. */
export function rotX(d: number): Mat3 {
  const [c, s] = [Math.cos(rad(d)), Math.sin(rad(d))];
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(d: number): Mat3 {
  const [c, s] = [Math.cos(rad(d)), Math.sin(rad(d))];
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(d: number): Mat3 {
  const [c, s] = [Math.cos(rad(d)), Math.sin(rad(d))];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** a · b. */
export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

/** m applied to a vector. */
export function apply(m: Mat3, v: Vec3): Vec3 {
  return { x: m[0] * v.x + m[1] * v.y + m[2] * v.z, y: m[3] * v.x + m[4] * v.y + m[5] * v.z, z: m[6] * v.x + m[7] * v.y + m[8] * v.z };
}

/** A point turned by m about a pivot. */
export const orbit3 = (m: Mat3, pivot: Vec3, p: Vec3): Vec3 => {
  const r = apply(m, { x: p.x - pivot.x, y: p.y - pivot.y, z: p.z - pivot.z });
  return { x: pivot.x + r.x, y: pivot.y + r.y, z: pivot.z + r.z };
};

/** A box's, cylinder's or instance's orientation: Ry(yaw) · Rx(pitch) · Rz(roll). */
export const orientationYXZ = (yaw: number, pitch: number, roll: number): Mat3 => mul(rotY(yaw), mul(rotX(pitch), rotZ(roll)));

/** A free-form's or array's tilt: Rx(pitch) · Rz(roll). */
export const tiltXZ = (pitch: number, roll: number): Mat3 => mul(rotX(pitch), rotZ(roll));

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/** m as yaw, pitch and roll with m = Ry(yaw) · Rx(pitch) · Rz(roll) (pitch in -90..90). */
export function toYXZ(m: Mat3): { yaw: number; pitch: number; roll: number } {
  const [m11, , m13, m21, m22, m23, m31, , m33] = m;
  const pitch = deg(Math.asin(-clamp1(m23)));
  if (Math.abs(m23) < 0.9999999) return { yaw: deg(Math.atan2(m13, m33)), pitch, roll: deg(Math.atan2(m21, m22)) };
  // Straight up or down: the roll folds into the yaw.
  return { yaw: deg(Math.atan2(-m31, m11)), pitch, roll: 0 };
}

/** m as pitch, roll and a turn with m = Rx(pitch) · Rz(roll) · Ry(turn) (roll in -90..90). */
export function toXZY(m: Mat3): { pitch: number; roll: number; turn: number } {
  const [m11, m12, m13, , m22, m23, , m32, m33] = m;
  const roll = Math.asin(-clamp1(m12));
  if (Math.abs(m12) < 0.9999999) return { pitch: deg(Math.atan2(m32, m22)), roll: deg(roll), turn: deg(Math.atan2(m13, m11)) };
  return { pitch: deg(Math.atan2(-m23, m33)), roll: deg(roll), turn: 0 };
}

/** The rotation of a tilt given as pitch and roll around the WORLD's x and z axes (roll first). */
export const worldTilt = (pitch: number, roll: number): Mat3 => mul(rotX(pitch), rotZ(roll));

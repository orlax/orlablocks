import type { Box, BoxPatch } from "./scene.types";

/**
 * Pure box geometry shared by the server (group moves and rotations) and the editor (picking, the gizmo).
 * Ground coordinates are x/z; rotation is counterclockwise seen from above (a right-handed turn about +y).
 */

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

/** 2 decimals, and never -0. */
export const round2 = (n: number) => Math.round(n * 100) / 100 + 0;
export const normalizeDeg = (deg: number) => ((deg % 360) + 360) % 360;

/** The box's local axes on the ground, in world x/z: `ex` along its width, `ez` along its depth. */
export function boxAxes(box: Box) {
  const a = (box.rotation * Math.PI) / 180;
  return { ex: { x: Math.cos(a), z: -Math.sin(a) }, ez: { x: Math.sin(a), z: Math.cos(a) } };
}

/** A world ground point in the box's frame (origin at its center, axes along width and depth). */
export function toBoxLocal(box: Box, p: { x: number; z: number }) {
  const { ex, ez } = boxAxes(box);
  const dx = p.x - box.x;
  const dz = p.z - box.z;
  return { x: dx * ex.x + dz * ex.z, z: dx * ez.x + dz * ez.z };
}

/** A point in the box's frame back in world x/z. */
export function fromBoxLocal(box: Box, l: { x: number; z: number }) {
  const { ex, ez } = boxAxes(box);
  return { x: box.x + l.x * ex.x + l.z * ez.x, z: box.z + l.x * ex.z + l.z * ez.z };
}

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
export function boundsOf(boxes: Box[]): Bounds {
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

/**
 * Turns boxes by `degrees` around the vertical axis through `pivot`: each center orbits the pivot and the angle is
 * added to each rotation. Returns the patches.
 */
export function rotateAround(boxes: Box[], pivot: { x: number; z: number }, degrees: number): Record<string, BoxPatch> {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const patches: Record<string, BoxPatch> = {};
  for (const box of boxes) {
    const dx = box.x - pivot.x;
    const dz = box.z - pivot.z;
    patches[box.id] = {
      x: round2(pivot.x + dx * cos + dz * sin),
      z: round2(pivot.z - dx * sin + dz * cos),
      rotation: round2(normalizeDeg(box.rotation + degrees)) % 360,
    };
  }
  return patches;
}

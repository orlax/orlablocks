import { ownerOf } from "../shared/entities";
import { boundsOf, isSolid } from "../shared/geometry";
import { isHole } from "../shared/holes";
import type { ClosedShape, Shape, ShapeColor, Solid } from "../shared/scene.types";
import { meshFrame, shapeGeometryKey } from "./geometryWork";

export const STATIC_CELL = 48;
export const STATIC_CAPACITY = 24;
export type StaticBatch = { id: string; signature: string; color: ShapeColor; shapes: Solid[] };

const membership = new WeakMap<Solid, { cell: string | null; signature: string }>();
function staticMember(shape: Solid) {
  let entry = membership.get(shape);
  if (!entry) {
    const b = boundsOf([shape]);
    const cell = b.maxX - b.minX <= STATIC_CELL && b.maxZ - b.minZ <= STATIC_CELL
      ? `${Math.floor((b.minX + b.maxX) / 2 / STATIC_CELL)}:${Math.floor((b.minZ + b.maxZ) / 2 / STATIC_CELL)}`
      : null;
    entry = { cell, signature: JSON.stringify([shape.id, meshFrame(shape), shapeGeometryKey(shape)]) };
    membership.set(shape, entry);
  }
  return entry;
}

/** Groups unchanged geometry by material and space. Individual shapes still own picking and live previews. */
export function splitStaticBatches(
  shapes: Shape[],
  cuts: Map<string, ClosedShape[]>,
  modifiers: Set<string>,
  dynamic: Set<string>,
): { individual: Shape[]; batches: StaticBatch[] } {
  const groups = new Map<string, Solid[]>();
  for (const shape of shapes) {
    if (!isSolid(shape) || isHole(shape) || cuts.has(shape.id)) continue;
    const owner = ownerOf(shape.id);
    if (dynamic.has(shape.id) || dynamic.has(owner) || modifiers.has(shape.id) || modifiers.has(owner)) continue;
    const { cell } = staticMember(shape);
    if (cell === null) continue;
    const key = `${cell}:${shape.color}`;
    const group = groups.get(key);
    if (group) group.push(shape);
    else groups.set(key, [shape]);
  }
  const taken = new Set<string>();
  const batches: StaticBatch[] = [];
  for (const [key, group] of groups) {
    // Keep buffer rebuild and transfer size local to one cell and at most one short group of solids.
    for (let i = 0; i < group.length; i += STATIC_CAPACITY) {
      const chunk = group.slice(i, i + STATIC_CAPACITY);
      if (chunk.length < 2) continue;
      for (const shape of chunk) taken.add(shape.id);
      batches.push({
        id: `${key}:${i / STATIC_CAPACITY}`,
        signature: JSON.stringify([key, chunk.map((shape) => staticMember(shape).signature)]),
        color: chunk[0].color,
        shapes: chunk,
      });
    }
  }
  return { individual: taken.size ? shapes.filter((s) => !taken.has(s.id)) : shapes, batches };
}

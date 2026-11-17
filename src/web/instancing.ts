import { arrayItems, type ArrayItem } from "../shared/arrays";
import { definitionOf, ownerOf } from "../shared/entities";
import { isFootprinted, isSolid, round2 } from "../shared/geometry";
import { cutsFloor, isHole } from "../shared/holes";
import { cutterGeometryKey } from "../shared/csg";
import type { ArrayNode, Box, ClosedShape, Cylinder, Instance, Shape } from "../shared/scene.types";

/**
 * Which array items the view draws instanced (plan 10 §8), pure: see `InstancedArrays.tsx` for the drawing.
 */

/** Items of one entity in one array, drawn instanced. */
export type InstancedGroup = { key: string; array: string; entity: string; items: ArrayItem[]; scale?: number };

export type PlacementBatch = { key: string; part: Box | Cylinder; cuts?: ClosedShape[]; placements: (Box | Cylinder)[] };

function relativeCoordinate(value: number, origin: number) {
  const relative = value - origin;
  const rounded = round2(relative);
  return Math.abs(rounded - relative) < 1e-9 ? rounded : relative;
}

/**
 * Batch compatible parts using the actual expanded geometry dimensions and transforms.
 * Share internal cuts only when their relative geometry and the floor rule agree.
 * External cuts and complex outlines keep their individual geometry.
 */
export function splitPlacements(boxes: Shape[], instances: Instance[], cuts: Map<string, ClosedShape[]>, modifiers: Set<string>) {
  if (!instances.length) return { boxes, batches: [] };
  const owners = new Map(instances.map((node) => [node.id, node]));
  const byOwner = new Map<string, Shape[]>();
  for (const shape of boxes) {
    const owner = ownerOf(shape.id);
    if (!owners.has(owner) || !isSolid(shape) || isHole(shape)) continue;
    const parts = byOwner.get(owner) ?? [];
    if (!byOwner.has(owner)) byOwner.set(owner, parts);
    parts.push(shape);
  }

  const partCounts = new Map<string, number>();
  const candidates = new Map<string, PlacementBatch>();
  for (const [owner, parts] of byOwner) {
    const entity = owners.get(owner)!.entity;
    let count = partCounts.get(entity);
    if (count === undefined) {
      count = definitionOf(entity)?.filter((n) => n.type !== "group" && isSolid(n) && !isHole(n) && !n.hidden).length ?? 0;
      partCounts.set(entity, count);
    }
    if (parts.length !== count) continue;
    for (const shape of parts) {
      if ((shape.type !== "box" && shape.type !== "cylinder") || modifiers.has(shape.id) || modifiers.has(owner)) continue;
      const actualCuts = cuts.get(shape.id);
      const part = { ...shape, x: 0, y: 0, z: 0, ...(actualCuts?.length ? {} : { rotation: 0, pitch: 0, roll: 0 }) };
      let localCuts: ClosedShape[] | undefined;
      if (actualCuts?.length) {
        const own = actualCuts.filter((hole): hole is Box | Cylinder => hole.id.startsWith(`${owner}/`) && isFootprinted(hole));
        if (own.length !== actualCuts.length) continue;
        const local = own.map((hole) => ({
          ...hole, x: relativeCoordinate(hole.x, shape.x), y: relativeCoordinate(hole.y, shape.y), z: relativeCoordinate(hole.z, shape.z),
        }));
        if (shape.kind === "room" && own.some((hole, i) => cutsFloor(hole, shape) !== cutsFloor(local[i], part))) continue;
        localCuts = local;
      }
      // Center the first 128 m cell on the origin; distant repetitions retain independent culling bounds.
      const key = JSON.stringify([
        entity, shape.id.slice(owner.length + 1), Math.floor((shape.x + 64) / 128), Math.floor((shape.z + 64) / 128),
        shape.type, shape.kind, shape.width, shape.depth, shape.height, shape.wall, shape.floor,
        shape.color, shape.bevel, shape.taper, shape.type === "cylinder" ? [shape.sides, shape.arc] : null,
        localCuts ? [part.rotation, part.pitch, part.roll, cutterGeometryKey(localCuts)] : null,
      ]);
      const batch = candidates.get(key);
      if (batch) batch.placements.push(shape);
      else candidates.set(key, { key, part, cuts: localCuts, placements: [shape] });
    }
  }
  const batches = [...candidates.values()].filter((batch) => batch.placements.length > 1);
  const taken = new Set(batches.flatMap((batch) => batch.placements.map((s) => s.id)));
  return { boxes: taken.size ? boxes.filter((shape) => !taken.has(shape.id)) : boxes, batches };
}

/**
 * Splits what's drawn: the shapes to draw one by one, and the array items to draw instanced (their shapes left out
 * of the first). An item is instanced when its entity exists, all its shapes are drawn, and every hole that cuts one
 * of them is its own (from its entity's definition).
 */
export function splitInstanced(boxes: Shape[], arrays: ArrayNode[], cuts: Map<string, ClosedShape[]>): { boxes: Shape[]; groups: InstancedGroup[] } {
  if (arrays.length === 0) return { boxes, groups: [] };
  // Each drawn shape by its item (`array_3/7/box_2` → `array_3/7`).
  const byItem = new Map<string, Shape[]>();
  for (const b of boxes) {
    const second = b.id.indexOf("/", b.id.indexOf("/") + 1);
    if (!b.id.startsWith("array_") || second < 0) continue;
    const key = b.id.slice(0, second);
    byItem.set(key, [...(byItem.get(key) ?? []), b]);
  }
  const taken = new Set<string>();
  const groups = new Map<string, InstancedGroup>();
  for (const array of arrays) {
    for (const item of arrayItems(array)) {
      const def = definitionOf(item.entity);
      const key = `${array.id}/${item.index}`;
      const shapes = byItem.get(key) ?? [];
      const solids = shapes.filter((s) => !isHole(s));
      const own = `${key}/`;
      if (!def || solids.length === 0 || solids.length !== def.filter((n) => n.type !== "group" && isSolid(n) && !isHole(n)).length) continue;
      if (solids.some((s) => (cuts.get(s.id) ?? []).some((h) => !h.id.startsWith(own)))) continue;
      solids.forEach((s) => taken.add(s.id));
      const gk = `${array.id}:${item.entity}`;
      if (!groups.has(gk)) groups.set(gk, { key: gk, array: array.id, entity: item.entity, items: [], ...(array.scale ? { scale: array.scale } : {}) });
      groups.get(gk)!.items.push(item);
    }
  }
  return { boxes: boxes.filter((b) => !taken.has(b.id)), groups: [...groups.values()] };
}


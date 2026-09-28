import { arrayItems, type ArrayItem } from "../shared/arrays";
import { definitionOf } from "../shared/entities";
import { isSolid } from "../shared/geometry";
import { isHole } from "../shared/holes";
import type { ArrayNode, ClosedShape, Shape } from "../shared/scene.types";

/**
 * Which array items the view draws instanced (plan 10 §8), pure: see `InstancedArrays.tsx` for the drawing.
 */

/** Items of one entity in one array, drawn instanced. */
export type InstancedGroup = { key: string; array: string; entity: string; items: ArrayItem[] };

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
      if (!groups.has(gk)) groups.set(gk, { key: gk, array: array.id, entity: item.entity, items: [] });
      groups.get(gk)!.items.push(item);
    }
  }
  return { boxes: boxes.filter((b) => !taken.has(b.id)), groups: [...groups.values()] };
}


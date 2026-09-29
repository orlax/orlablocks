import { boundsOf, round2 } from "../shared/geometry";
import { arrayLayout, type ArrayItem } from "../shared/arrays";
import { arrayItemInstance, instanceShapes } from "../shared/entities";
import { surfaceAt } from "../shared/surfaces";
import type { ArrayLayout, ArrayNode, SceneNode } from "../shared/scene.types";
import { countsText, isGroup, isShape, shapesUnder, subtreeIds } from "../shared/tree";
import { boundsFor, entitiesOf, type AgentBounds } from "./outline";

/**
 * What the edit tools return (plan 13 §4): a **compact result**, one line per node saying what changed without
 * repeating it: its id, type, kind, name, parent and bounds, with a count instead of points, and for an array where
 * its items are. The agent rarely needs its own input back; `verbose: true` on a tool returns the nodes in full.
 */

/** The most item lines an array's compact line lists; get_scene { root } on the array lists them all. */
export const MAX_ITEM_LINES = 40;

/** How high an item's walking surface is over its pivot (13.4), else the top of its shapes; its y when it has none. */
function itemTop(array: ArrayNode, item: ArrayItem): number {
  const inst = arrayItemInstance(array, item.index);
  const shapes = inst ? instanceShapes(inst) : [];
  return shapes.length > 0 ? round2(surfaceAt(shapes, item.x, item.z) ?? boundsOf(shapes).maxY) : item.y;
}

/**
 * An **item line**: where an array's item stands (its pivot), how high its walking surface is, and its turn, e.g.
 * `array_5/3 → 12.1, 4.5, -8 · top 5 · 90°`.
 */
export function itemLine(array: ArrayNode, item: ArrayItem): string {
  return `${array.id}/${item.index} → ${item.x}, ${item.y}, ${item.z} · top ${itemTop(array, item)} · ${item.rotation}°`;
}

/** An array's item lines: all of them, or the first `max` with a line saying how to read the rest. */
export function itemLines(array: ArrayNode, max = Infinity): string[] {
  const items = arrayLayout(array).items;
  const lines = items.slice(0, max).map((item) => itemLine(array, item));
  if (items.length > max) lines.push(`… ${items.length - max} more: get_scene { root: "${array.id}" }`);
  return lines;
}

/** A layout without its points (a path's or a scatter area's become counts): a following one never echoes its target. */
function layoutSummary(layout: ArrayLayout): Record<string, unknown> {
  const summary: Record<string, unknown> = { ...layout };
  if (layout.type === "path") summary.points = layout.points.length;
  if (layout.type === "scatter" && layout.area) summary.area = layout.area.length;
  return summary;
}

export type CompactNode = {
  id: string;
  type: SceneNode["type"];
  kind?: string;
  name?: string;
  parent?: string;
  bounds?: AgentBounds;
  [field: string]: unknown;
};

/** One node's compact line, from the scene as it is after the step. */
export function compactNode(nodes: SceneNode[], n: SceneNode): CompactNode {
  const base: CompactNode = {
    id: n.id,
    type: n.type,
    ...(isShape(n) && "kind" in n ? { kind: n.kind } : {}),
    ...(n.name !== undefined ? { name: n.name } : {}),
    ...(n.parent !== undefined ? { parent: n.parent } : {}),
  };
  if (isGroup(n)) {
    const inside = subtreeIds(nodes, n.id);
    inside.delete(n.id);
    const shapes = shapesUnder(nodes, [n.id]);
    return {
      ...base,
      ...(n.description ? { description: n.description } : {}),
      ...(shapes.length > 0 ? { bounds: boundsFor(shapes) } : {}),
      contains: countsText(nodes.filter((d) => inside.has(d.id))),
    };
  }
  const bounds = boundsFor([n]);
  switch (n.type) {
    case "line":
      return { ...base, bounds, points: n.points.length, ...(n.through ? { through: { stops: n.through.stops.length, style: n.through.style } } : {}) };
    case "freeform":
    case "ramp":
      return { ...base, bounds, points: n.points.length };
    case "note":
      return { ...base, text: n.text.length > 120 ? `${n.text.slice(0, 120)}…` : n.text, status: n.status, ...(n.label ? { label: n.label } : {}), bounds };
    case "instance":
      return { ...base, entity: n.entity, x: n.x, y: n.y, z: n.z, rotation: n.rotation ?? 0, ...(n.on ? { on: n.on.id } : {}), bounds };
    case "array": {
      const items = arrayLayout(n).items.length;
      return {
        ...base,
        entities: entitiesOf(n),
        layout: layoutSummary(n.layout),
        ...(n.skip && n.skip.length > 0 ? { skip: n.skip } : {}),
        ...(n.on ? { on: n.on.id } : {}),
        items,
        bounds,
        at: itemLines(n, MAX_ITEM_LINES),
      };
    }
    default:
      return { ...base, bounds };
  }
}

/** The compact lines of the given nodes (by ID, from the scene after the step), in the order given. */
export function compactNodes(nodes: SceneNode[], ids: string[]): CompactNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return ids.flatMap((id) => {
    const n = byId.get(id);
    return n ? [compactNode(nodes, n)] : [];
  });
}

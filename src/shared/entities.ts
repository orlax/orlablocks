import { arrayItems } from "./arrays";
import { moveShape, rotateShape, scaleShape, tiltShape } from "./geometry";
import { orientationYXZ } from "./rotation3";
import type { ArrayNode, Group, Instance, SceneNode, Shape } from "./scene.types";

/**
 * Entities (plan 08 §7): the open project's definitions, and instances expanded into world shapes. A definition is
 * a small scene: nodes around a pivot at the origin (its bottom center). An instance shows them turned by its
 * `rotation` around the pivot, then moved to its `x, y, z`.
 *
 * The definitions are a registry, set once per project by the server and by the editor (each has one project open),
 * so the pure geometry (bounds, frames, snapping) can see an instance's shapes without every caller passing them.
 *
 * Expanded, an instance is a virtual group with the instance's ID and place in the tree, holding its shapes with
 * namespaced IDs (`instance_4/box_2`): rendering, picking, the marquee and holes run on that, so for holes an
 * instance is a group. The namespaced IDs are never edited; `ownerOf` maps one back to its instance.
 *
 * An array (plan 10 §4) expands into its items, each an instance expanded the same way (`array_3/7`, its shapes
 * `array_3/7/box_2`), in the array's own place in the tree: the array adds no level, so for holes its items are
 * instances placed where the array is.
 */

let definitions = new Map<string, SceneNode[]>();
let cache = new WeakMap<Instance, SceneNode[]>();
let arrayCache = new WeakMap<ArrayNode, SceneNode[]>();

/** Replaces every definition (a project opened, or one changed). */
export function setDefinitions(defs: Record<string, SceneNode[]>): void {
  definitions = new Map(Object.entries(defs));
  cache = new WeakMap();
  arrayCache = new WeakMap();
}

/** Adds or replaces one definition. */
export function setDefinition(id: string, nodes: SceneNode[]): void {
  definitions.set(id, nodes);
  cache = new WeakMap();
  arrayCache = new WeakMap();
}

export const definitionOf = (id: string): SceneNode[] | undefined => definitions.get(id);
export const allDefinitions = (): Record<string, SceneNode[]> => Object.fromEntries(definitions);

/** The instance or array a namespaced ID belongs to (`instance_4/box_2` → `instance_4`, `array_3/7/box_2` → `array_3`), or the ID itself. */
export const ownerOf = (id: string) => {
  const i = id.indexOf("/");
  return i < 0 ? id : id.slice(0, i);
};
export const isVirtual = (id: string) => id.includes("/");

/** What an instance of a missing entity shows: a small red block, so it can still be seen, picked and removed. */
const MISSING_SIZE = 1;

/**
 * An instance as a virtual group (its ID, parent and name) followed by its definition's nodes in world space, with
 * namespaced IDs; top-level definition nodes are in the virtual group. Cached per instance object.
 */
export function expandInstance(inst: Instance): SceneNode[] {
  const hit = cache.get(inst);
  if (hit) return hit;
  const group: Group = {
    id: inst.id,
    type: "group",
    ...(inst.name !== undefined ? { name: inst.name } : {}),
    ...(inst.parent !== undefined ? { parent: inst.parent } : {}),
    createdBy: inst.createdBy,
  };
  const def = definitions.get(inst.entity);
  const ns = (id: string) => `${inst.id}/${id}`;
  const nodes: SceneNode[] = def
    ? def.map((n) => {
        const parent = n.parent !== undefined ? ns(n.parent) : inst.id;
        if (n.type === "group") return { ...n, id: ns(n.id), parent };
        // Scaled about the pivot (14.3), turned around it, then moved to the instance's place.
        const scaled = inst.scale && inst.scale !== 1 ? ({ ...n, ...scaleShape(n, inst.scale, { x: 0, y: 0, z: 0 }) } as Shape) : n;
        // A tilted instance (14.4) turns its shapes by its whole orientation around the pivot.
        const tilted = !!(inst.pitch || inst.roll);
        const turned = tilted
          ? ({ ...scaled, ...tiltShape(scaled, orientationYXZ(inst.rotation, inst.pitch ?? 0, inst.roll ?? 0), { x: 0, y: 0, z: 0 }) } as Shape)
          : inst.rotation
            ? ({ ...scaled, ...rotateShape(scaled, { x: 0, z: 0 }, inst.rotation) } as Shape)
            : scaled;
        const placed = { ...turned, ...moveShape(turned, inst.x, inst.y, inst.z) } as Shape;
        return { ...placed, id: ns(n.id), parent };
      })
    : [
        {
          id: ns("missing"),
          type: "box",
          parent: inst.id,
          name: `missing entity ${inst.entity}`,
          kind: "volume",
          x: inst.x,
          z: inst.z,
          y: inst.y,
          width: MISSING_SIZE * (inst.scale ?? 1),
          depth: MISSING_SIZE * (inst.scale ?? 1),
          height: MISSING_SIZE * (inst.scale ?? 1),
          rotation: inst.rotation,
          color: "red",
          createdBy: inst.createdBy,
        },
      ];
  const expanded = [group, ...nodes];
  cache.set(inst, expanded);
  return expanded;
}

/** An instance's shapes in world space (no groups). */
export const instanceShapes = (inst: Instance): Shape[] => expandInstance(inst).filter((n): n is Shape => n.type !== "group");

/** The item of an array with this index, as an instance (`array_3/7`), or undefined if it has none (skipped). */
export function arrayItemInstance(array: ArrayNode, index: number): Instance | undefined {
  const item = arrayItems(array).find((i) => i.index === index);
  return item && itemInstance(array, item);
}

const itemInstance = (array: ArrayNode, item: ReturnType<typeof arrayItems>[number]): Instance => ({
  id: `${array.id}/${item.index}`,
  type: "instance",
  entity: item.entity,
  ...(array.parent !== undefined ? { parent: array.parent } : {}),
  x: item.x,
  y: item.y,
  z: item.z,
  rotation: item.rotation,
  ...(item.pitch ? { pitch: item.pitch } : {}),
  ...(item.roll ? { roll: item.roll } : {}),
  ...(array.scale && array.scale !== 1 ? { scale: array.scale } : {}),
  createdBy: array.createdBy,
});

/** An array's items as instances expanded (each a virtual group and its shapes), in the array's place. Cached per array object. */
export function expandArray(array: ArrayNode): SceneNode[] {
  const hit = arrayCache.get(array);
  if (hit) return hit;
  const expanded = arrayItems(array).flatMap((item) => expandInstance(itemInstance(array, item)));
  arrayCache.set(array, expanded);
  return expanded;
}

/** An array's shapes in world space (no groups). */
export const arrayShapes = (array: ArrayNode): Shape[] => expandArray(array).filter((n): n is Shape => n.type !== "group");

/** The nodes with every instance and array replaced by virtual groups and shapes (for rendering, picking and holes). */
export const expandNodes = (nodes: SceneNode[]): SceneNode[] =>
  nodes.flatMap((n) => (n.type === "instance" ? expandInstance(n) : n.type === "array" ? expandArray(n) : [n]));

/** Shapes with every instance and array replaced by its own shapes (no groups). */
export const expandShapes = (shapes: Shape[]): Shape[] =>
  shapes.flatMap((s) => (s.type === "instance" ? instanceShapes(s) : s.type === "array" ? arrayShapes(s) : [s]));

import { moveShape, rotateShape } from "./geometry";
import type { Group, Instance, SceneNode, Shape } from "./scene.types";

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
 */

let definitions = new Map<string, SceneNode[]>();
let cache = new WeakMap<Instance, SceneNode[]>();

/** Replaces every definition (a project opened, or one changed). */
export function setDefinitions(defs: Record<string, SceneNode[]>): void {
  definitions = new Map(Object.entries(defs));
  cache = new WeakMap();
}

/** Adds or replaces one definition. */
export function setDefinition(id: string, nodes: SceneNode[]): void {
  definitions.set(id, nodes);
  cache = new WeakMap();
}

export const definitionOf = (id: string): SceneNode[] | undefined => definitions.get(id);
export const allDefinitions = (): Record<string, SceneNode[]> => Object.fromEntries(definitions);

/** The instance a namespaced ID belongs to (`instance_4/box_2` → `instance_4`), or the ID itself. */
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
        const turned = inst.rotation ? ({ ...n, ...rotateShape(n, { x: 0, z: 0 }, inst.rotation) } as Shape) : n;
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
          width: MISSING_SIZE,
          depth: MISSING_SIZE,
          height: MISSING_SIZE,
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

/** The nodes with every instance replaced by its virtual group and shapes (for rendering, picking and holes). */
export const expandNodes = (nodes: SceneNode[]): SceneNode[] => nodes.flatMap((n) => (n.type === "instance" ? expandInstance(n) : [n]));

/** Shapes with every instance replaced by its own shapes (no groups). */
export const expandShapes = (shapes: Shape[]): Shape[] => shapes.flatMap((s) => (s.type === "instance" ? instanceShapes(s) : [s]));

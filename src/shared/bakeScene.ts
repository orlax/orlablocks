import { arrayItems } from "./arrays";
import { bakeShape, drawMesh, uvElevation, uvOffset, type Baked } from "./bake";
import { subtract } from "./csg";
import { definitionOf, expandNodes, inEntityRoot, itemInstance } from "./entities";
import { isSolid, toLocal3 } from "./geometry";
import { cutsFloor, cutters, isHole } from "./holes";
import { hitMesh, shapeMesh, type Mesh } from "./mesh";
import { apply, orientationYXZ, type Mat3 } from "./rotation3";
import type { ClosedShape, Instance, SceneNode, Solid } from "./scene.types";
import { hiddenIds, isShape } from "./tree";

/**
 * A whole scene baked for the export (15.1): each of its own shapes as drawn (holes cut), each entity it uses once
 * around its pivot (cut by its own holes, as in Edit entity mode), and, for an instance or array item that the
 * scene cuts differently (a scene hole through it, or its own hole cutting less), that shape again in its
 * definition's frame with its real cuts: a **variant**. Holes are baked uncut, for Unity's gizmo. A hidden hole cuts
 * nothing, as in the editor.
 */
export type SceneBake = {
  /** The scene's own shapes (not an instance's), by ID. */
  shapes: Map<string, Baked>;
  /** Entity ID → its definition's shapes, around its pivot, by the definition's shape ID. */
  entities: Map<string, Map<string, Baked>>;
  /** Instance or item ID (`instance_4`, `array_3/7`) → the definition's shape ID → its cut, in the definition's frame. */
  variants: Map<string, Map<string, Baked>>;
  /** The scene's shapes that holes cut, and each entity's shapes its own holes cut. */
  cut: Set<string>;
  entityCut: Map<string, Set<string>>;
};

/** Where an instance's pivot frame sits: world = at + R · (scale · local). */
type Placement = { at: { x: number; y: number; z: number }; r: Mat3; scale: number };

const placementOf = (inst: Instance): Placement => ({
  at: { x: inst.x, y: inst.y, z: inst.z },
  r: orientationYXZ(inst.rotation, inst.pitch ?? 0, inst.roll ?? 0),
  scale: inst.scale ?? 1,
});

/** A world point in an instance's pivot frame (the definition's space). */
function toEntity(p: Placement, w: { x: number; y: number; z: number }) {
  const d = { x: w.x - p.at.x, y: w.y - p.at.y, z: w.z - p.at.z };
  const [a, b, c, d2, e, f, g, h, i] = p.r;
  // R is a rotation: its inverse is its transpose.
  const l = apply([a, d2, g, b, e, h, c, f, i], d);
  return { x: l.x / p.scale, y: l.y / p.scale, z: l.z / p.scale };
}

/** A hole's world solid in `shape`'s own frame, where `shape` is a definition's shape placed by `p`. */
function holeInDefinitionFrame(shape: Solid, p: Placement, hole: ClosedShape): Mesh | null {
  const m = hitMesh(hole);
  if (!m) return null;
  const positions: number[] = [];
  for (let k = 0; k < m.positions.length; k += 3) {
    const l = toLocal3(shape, toEntity(p, { x: m.positions[k], y: m.positions[k + 1], z: m.positions[k + 2] }));
    positions.push(l.x, l.y, l.z);
  }
  return { positions, indices: m.indices };
}

/** A definition's shape cut by world holes (`placed` is it in the world, for the floor rule), baked in its own frame. */
function bakeVariant(shape: Solid, placed: Solid, p: Placement, cuts: ClosedShape[]): Baked {
  const parts = shapeMesh(shape);
  const holes = cuts.map((h) => ({ hole: h, mesh: holeInDefinitionFrame(shape, p, h) })).filter((h): h is { hole: ClosedShape; mesh: Mesh } => h.mesh !== null);
  const floorHoles = shape.type === "ramp" || placed.type === "ramp" ? [] : holes.filter((h) => cutsFloor(h.hole, placed as ClosedShape)).map((h) => h.mesh);
  const body = parts.body && subtract(parts.body, holes.map((h) => h.mesh));
  const floor = parts.floor && (floorHoles.length > 0 ? subtract(parts.floor, floorHoles) : parts.floor);
  const [ox, oz] = uvOffset(shape);
  const oy = uvElevation(shape);
  return { body: body && drawMesh(body, ox, oy, oz, true), floor: floor && drawMesh(floor, ox, oy, oz, false) };
}

const solidsOf = (nodes: SceneNode[]) => nodes.filter(isShape).filter(isSolid);
const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function bakeScene(nodes: SceneNode[]): SceneBake {
  const hidden = hiddenIds(nodes);
  const cutting = expandNodes(nodes.filter((n) => !(isHole(n) && hidden.has(n.id))));
  const cuts = cutters(cutting);
  const byId = new Map(cutting.map((n) => [n.id, n]));
  const cutsOf = (id: string) => cuts.get(id) ?? [];

  const shapes = new Map<string, Baked>();
  for (const s of solidsOf(nodes)) shapes.set(s.id, bakeShape(s, isHole(s) ? undefined : cutsOf(s.id)));

  // Each entity once, cut as its instances are when nothing else reaches them.
  const entities = new Map<string, Map<string, Baked>>();
  const ownCuts = new Map<string, Map<string, ClosedShape[]>>();
  const entityCut = new Map<string, Set<string>>();
  const entityIds = new Set(nodes.flatMap((n) => (n.type === "instance" ? [n.entity] : n.type === "array" ? arrayItems(n).map((i) => i.entity) : [])));
  for (const id of entityIds) {
    const def = definitionOf(id);
    if (!def) continue;
    const defCuts = cutters(inEntityRoot(def));
    ownCuts.set(id, defCuts);
    entities.set(id, new Map(solidsOf(def).map((s) => [s.id, bakeShape(s, isHole(s) ? undefined : defCuts.get(s.id))])));
    entityCut.set(id, new Set(defCuts.keys()));
  }

  // Instances and items whose real cuts differ from their entity's own.
  const variants = new Map<string, Map<string, Baked>>();
  const placedInstances = nodes.flatMap((n): Instance[] => (n.type === "instance" ? [n] : n.type === "array" ? arrayItems(n).map((i) => itemInstance(n, i)) : []));
  for (const inst of placedInstances) {
    const def = definitionOf(inst.entity);
    if (!def) continue;
    const own = ownCuts.get(inst.entity)!;
    const p = placementOf(inst);
    const prefix = `${inst.id}/`;
    let found: Map<string, Baked> | undefined;
    for (const s of solidsOf(def)) {
      if (isHole(s)) continue;
      const real = cutsOf(prefix + s.id);
      const expected = (own.get(s.id) ?? []).map((h) => prefix + h.id);
      if (sameIds(real.map((h) => h.id), expected)) continue;
      const placed = byId.get(prefix + s.id);
      if (!placed || !isShape(placed) || !isSolid(placed)) continue;
      found ??= new Map();
      found.set(s.id, bakeVariant(s, placed, p, real));
    }
    if (found) variants.set(inst.id, found);
  }
  const cut = new Set(solidsOf(nodes).filter((s) => !isHole(s) && cutsOf(s.id).length > 0).map((s) => s.id));
  return { shapes, entities, variants, cut, entityCut };
}

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { invalidate } from "@react-three/fiber";
import * as THREE from "three";
import type { ArrayItem } from "../shared/arrays";
import { definitionOf, expandInstance } from "../shared/entities";
import { isSolid } from "../shared/geometry";
import { cutters, isHole } from "../shared/holes";
import type { ClosedShape, Solid } from "../shared/scene.types";
import type { InstancedGroup } from "./instancing";
import { colorMaterials, getShared, shapeMatrix, useShapeGeometry } from "./ShapeMesh";

/**
 * Instanced arrays (plan 10 §8): every item of one entity has the same geometry, placed differently, so the view
 * draws each part of that entity once per array, as an InstancedMesh with a matrix per item, and all the items'
 * edges as one merged set of line segments: a few draw calls for hundreds of items. An item cut by a hole from
 * outside its entity (a door through one merlon) differs from the rest, so it's drawn shape by shape as before, and
 * so are the entities' holes (the ghosts) and items of a missing entity.
 */

/**
 * One entity's items in one array: its definition's solid parts (not its holes), each cut by the entity's own holes,
 * drawn instanced at every item.
 */
export function InstancedEntity({ group, highlight }: { group: InstancedGroup; highlight?: "hover" | "selected" }) {
  const def = definitionOf(group.entity);
  // The entity at the origin, and which of its holes cut which of its parts (as in every instance).
  const { parts, cuts } = useMemo(() => {
    const at = expandInstance({ id: `instanced:${group.entity}`, type: "instance", entity: group.entity, x: 0, y: 0, z: 0, rotation: 0, createdBy: "human" });
    const solids = at.filter((n): n is Solid => n.type !== "group" && isSolid(n) && !isHole(n));
    return { parts: solids, cuts: cutters(at) };
  }, [def, group.entity]);
  return (
    <>
      {parts.map((p) => (
        <InstancedPart key={p.id} part={p} cuts={cuts.get(p.id)} items={group.items} highlight={highlight} />
      ))}
    </>
  );
}

/**
 * What each instanced mesh was last placed with (so a mesh is placed again only when it's new, or its matrices or
 * its geometry changed: its bounds depend on both).
 */
const placed = new WeakMap<THREE.InstancedMesh, { matrices: THREE.Matrix4[]; geometry: THREE.BufferGeometry }>();

/** An item's place: moved to its pivot and turned around it (as an instance's shapes are, see `expandInstance`). */
const itemMatrix = (item: ArrayItem) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(item.x, item.y, item.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (item.rotation * Math.PI) / 180),
    new THREE.Vector3(1, 1, 1),
  );

/** One part of an entity at every item: its body and a room's floor instanced, its edges merged into one set. */
function InstancedPart({ part, cuts, items, highlight }: { part: Solid; cuts?: ClosedShape[]; items: ArrayItem[]; highlight?: "hover" | "selected" }) {
  const { solid, floor, edges } = useShapeGeometry(part, cuts);
  const itemsKey = JSON.stringify(items.map((i) => [i.x, i.y, i.z, i.rotation]));
  const matrices = useMemo(() => {
    const local = shapeMatrix(part);
    return items.map((i) => itemMatrix(i).multiply(local));
  }, [itemsKey, part]);
  // Every item's edges in world space, as one set of segments.
  const lines = useMemo(() => {
    if (!edges) return null;
    const src = edges.getAttribute("position");
    const out = new Float32Array(src.count * 3 * matrices.length);
    const v = new THREE.Vector3();
    matrices.forEach((m, k) => {
      for (let i = 0; i < src.count; i++) {
        v.fromBufferAttribute(src, i).applyMatrix4(m);
        out.set([v.x, v.y, v.z], (k * src.count + i) * 3);
      }
    });
    return new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(out, 3));
  }, [edges, matrices]);
  useEffect(() => () => lines?.dispose(), [lines]);

  const body = useRef<THREE.InstancedMesh>(null);
  const floorMesh = useRef<THREE.InstancedMesh>(null);
  // After every render: a mesh that's new (react-three-fiber rebuilds one when its args change) or has other
  // matrices than these gets them, or its instances would all sit at the origin (drawn inside whatever is there,
  // with only the merged edges showing where the items are).
  useLayoutEffect(() => {
    let changed = false;
    for (const mesh of [body.current, floorMesh.current]) {
      const was = mesh && placed.get(mesh);
      if (!mesh || (was && was.matrices === matrices && was.geometry === mesh.geometry)) continue;
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      // Culling and picking use the instances' own bounds.
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
      placed.set(mesh, { matrices, geometry: mesh.geometry });
      changed = true;
    }
    if (changed) invalidate();
  });

  const s = getShared();
  const c = colorMaterials(part.color);
  const sel = highlight === "selected";
  const hover = highlight === "hover";
  const bodyMaterial = sel ? c.bodySelected : hover ? c.bodyHover : c.body;
  const floorMaterial = sel ? c.floorSelected : hover ? c.floorHover : c.floor;
  const edgeMaterial = sel ? s.edgeSelected : hover ? s.edgeHover : s.edge;
  const n = matrices.length;
  return (
    <>
      {solid && (
        // Only the count is an argument (it's fixed when the mesh is made, so a new count is a new mesh): geometry and
        // material are props, so a highlight or a rebuilt geometry doesn't make a new mesh.
        <instancedMesh key={`body:${n}`} ref={body} args={[undefined, undefined, n]} geometry={solid} material={bodyMaterial} castShadow receiveShadow userData={{ walkable: true }} />
      )}
      {floor && (
        <instancedMesh key={`floor:${n}`} ref={floorMesh} args={[undefined, undefined, n]} geometry={floor} material={floorMaterial} receiveShadow userData={{ walkable: true }} />
      )}
      {lines && <lineSegments geometry={lines} material={edgeMaterial} renderOrder={1} />}
    </>
  );
}

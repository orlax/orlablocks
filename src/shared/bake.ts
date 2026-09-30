import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cutParts, manifoldLoaded } from "./csg";
import { isFootprinted } from "./geometry";
import type { Mesh } from "./mesh";
import type { ClosedShape, Solid } from "./scene.types";

/**
 * The bake (15.1): a closed shape or ramp as the editor draws it, as plain arrays: its body and a room's floor, in
 * its own frame (see `shapeFrame`) from its bottom, minus the holes that cut it, with flat faces unshared, UVs
 * tiled every meter along its edges and creased normals. The editor wraps it in three.js geometry
 * (`useShapeGeometry`); the export writes it (15.2).
 */

/** Triangles, three vertices each (not indexed): positions and normals xyz, UVs uv. */
export type DrawMesh = { positions: Float32Array; normals: Float32Array; uvs: Float32Array };

/** A shape as drawn: its body (a volume's solid, a room's walls) and a room's floor slab, either possibly empty. */
export type Baked = { body: DrawMesh | null; floor: DrawMesh | null };

/**
 * Curved walls are many flat facets: faces that meet at less than this angle share their normals, so a round
 * tower or a curved cave wall lights as round, while a box's (or a hexagon's) corners stay sharp.
 */
const CREASE = (30 * Math.PI) / 180;

/**
 * The UV offset: the frame's world position for an unrotated shape (its tiles line up with the ground grid and
 * with other shapes), its half size for a rotated one (tiles start at a corner). A free-form's frame is the
 * world's, so its tiles always line up with the grid.
 */
export function uvOffset(shape: Solid): [number, number] {
  if (!isFootprinted(shape)) return [0, 0];
  return shape.rotation === 0 ? [shape.x, shape.z] : [shape.width / 2, shape.depth / 2];
}

/**
 * Shape-aligned UVs (1 unit = 1 m), picked per face from its dominant normal axis in the shape's own frame, so
 * tiles follow its edges. `ox, oy, oz` offsets them (see `uvOffset`).
 */
function applyBoxUVs(geometry: THREE.BufferGeometry, ox: number, oy: number, oz: number) {
  const pos = geometry.getAttribute("position");
  const nrm = geometry.getAttribute("normal");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + ox;
    const y = pos.getY(i) + oy;
    const z = pos.getZ(i) + oz;
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const [u, v] = ny >= nx && ny >= nz ? [x, z] : nx >= nz ? [z, y] : [x, y];
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** A shared mesh as three.js geometry, unshared per face (so each face gets its own flat normal, for the UVs). */
function toGeometry(mesh: Mesh) {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
  indexed.setIndex(mesh.indices);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  return geometry;
}

const arrays = (g: THREE.BufferGeometry): DrawMesh => ({
  positions: g.getAttribute("position").array as Float32Array,
  normals: g.getAttribute("normal").array as Float32Array,
  uvs: g.getAttribute("uv").array as Float32Array,
});

/**
 * One part as drawn: unshared, tiled with the UV offset `ox, oz` and the shape's elevation `oy` (UVs pick their
 * plane from the flat normals, so they come first), then with creased normals for a body (`crease`), flat for a
 * floor slab.
 */
export function drawMesh(mesh: Mesh, ox: number, oy: number, oz: number, crease: boolean): DrawMesh {
  const g = applyBoxUVs(toGeometry(mesh), ox, oy, oz);
  return arrays(crease ? toCreasedNormals(g, CREASE) : g);
}

/** A shape's elevation for its UVs: a ramp's mesh is in world coordinates (its frame is the world's, at height 0). */
export const uvElevation = (shape: Solid) => (shape.type === "ramp" ? 0 : shape.y);

const bakes = new WeakMap<Solid, { cutKey: string; baked: Baked }>();

/**
 * A closed shape or ramp, baked: its parts minus `cuts`, as drawn. Cached per shape object and its cuts, so a scene
 * baked again after a step bakes only what the step changed.
 */
export function bakeShape(shape: Solid, cuts?: ClosedShape[]): Baked {
  const cutKey = cuts && cuts.length > 0 && manifoldLoaded() ? JSON.stringify(cuts) : "";
  const hit = bakes.get(shape);
  if (hit && hit.cutKey === cutKey) return hit.baked;
  const parts = cutParts(shape, cuts);
  const [ox, oz] = uvOffset(shape);
  const oy = uvElevation(shape);
  const baked = {
    body: parts.body && drawMesh(parts.body, ox, oy, oz, true),
    floor: parts.floor && drawMesh(parts.floor, ox, oy, oz, false),
  };
  bakes.set(shape, { cutKey, baked });
  return baked;
}

/** A baked part as three.js geometry (position, normal, uv), for drawing. */
export function toBufferGeometry(m: DrawMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(m.uvs, 2));
  return g;
}

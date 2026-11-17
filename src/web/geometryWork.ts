import * as THREE from "three";
import { bakeShape, toBufferGeometry, uvOffset, type DrawMesh } from "../shared/bake";
import { cutterGeometryKey } from "../shared/csg";
import { isTilted, shapeFrame } from "../shared/geometry";
import type { ClosedShape, Solid } from "../shared/scene.types";

export type PreparedGeometry = { body: DrawMesh | null; floor: DrawMesh | null; edges: Float32Array | null };
export type GeometryJob = { kind: "shape"; shape: Solid; cuts?: ClosedShape[] } | { kind: "batch"; shapes: Solid[] };
export type GeometryRequest = { id: number; job: GeometryJob };
export type GeometryReply = { id: number; result: PreparedGeometry } | { id: number; error: string };

export function meshFrame(shape: Solid) {
  if (shape.type === "ramp") return { frame: { x: 0, z: 0, rotation: 0 }, y: 0, height: 0, tilt: [0, 0] };
  return { frame: shapeFrame(shape), y: shape.y, height: shape.height, tilt: [shape.pitch ?? 0, shape.roll ?? 0] };
}

/** GPU placement of the geometry in the solid's local frame. */
export function shapeMatrix(shape: Solid): THREE.Matrix4 {
  const { frame, y, height, tilt } = meshFrame(shape);
  const deg = Math.PI / 180;
  const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt[0] * deg, frame.rotation * deg, tilt[1] * deg, "YXZ"));
  return new THREE.Matrix4()
    .compose(new THREE.Vector3(frame.x, y + height / 2, frame.z), turn, new THREE.Vector3(1, 1, 1))
    .multiply(new THREE.Matrix4().makeTranslation(0, -height / 2, 0));
}

/** Geometry depends on authored inputs, without sampling outlines or generating meshes on the UI thread. */
export function shapeGeometryKey(shape: Solid, cuts?: ClosedShape[]): string {
  if (shape.type === "ramp") {
    return JSON.stringify([shape.type, shape.points, shape.width, shape.step, shape.base, cuts && cutterGeometryKey(cuts)]);
  }
  const outline = shape.type === "freeform"
    ? [shape.points, isTilted(shape)]
    : [shape.width, shape.depth, shape.type === "cylinder" ? [shape.sides, shape.arc] : null];
  return JSON.stringify([
    shape.type, shape.kind, outline, shape.height, shape.y, uvOffset(shape),
    shape.kind === "room" ? [shape.wall, shape.floor] : [shape.taper, shape.bevel],
    cuts?.length ? [cutterGeometryKey(cuts), shapeFrame(shape), shape.pitch, shape.roll] : null,
  ]);
}

function shapeGeometry(shape: Solid, cuts?: ClosedShape[], strict = false): PreparedGeometry {
  const { body, floor } = bakeShape(shape, cuts, strict);
  if (!body) return { body, floor, edges: null };
  const geometry = toBufferGeometry(body);
  const edges = new THREE.EdgesGeometry(geometry, 15);
  const positions = edges.getAttribute("position").array as Float32Array;
  edges.dispose();
  geometry.dispose();
  return { body, floor, edges: positions };
}

function mergePositions(values: Float32Array, destination: Float32Array, offset: number, matrix: THREE.Matrix4) {
  const vertex = new THREE.Vector3();
  for (let i = 0; i < values.length; i += 3) {
    vertex.fromArray(values, i).applyMatrix4(matrix).toArray(destination, offset + i);
  }
}

function mergeParts(parts: PreparedGeometry[], matrices: THREE.Matrix4[], key: "body" | "floor"): DrawMesh | null {
  const length = parts.reduce((sum, part) => sum + (part[key]?.positions.length ?? 0), 0);
  if (!length) return null;
  const positions = new Float32Array(length);
  const normals = new Float32Array(length);
  const uvs = new Float32Array(length / 3 * 2);
  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let offset = 0;
  parts.forEach((part, index) => {
    const source = part[key];
    if (!source) return;
    const matrix = matrices[index];
    mergePositions(source.positions, positions, offset, matrix);
    normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < source.normals.length; i += 3) {
      normal.fromArray(source.normals, i).applyNormalMatrix(normalMatrix).toArray(normals, offset + i);
    }
    uvs.set(source.uvs, offset / 3 * 2);
    offset += source.positions.length;
  });
  return { positions, normals, uvs };
}

export function prepareGeometry(job: GeometryJob, strict = false): PreparedGeometry {
  if (job.kind === "shape") return shapeGeometry(job.shape, job.cuts, strict);
  const parts = job.shapes.map((shape) => shapeGeometry(shape));
  const matrices = job.shapes.map(shapeMatrix);
  const edges = new Float32Array(parts.reduce((sum, part) => sum + (part.edges?.length ?? 0), 0));
  let offset = 0;
  parts.forEach((part, i) => {
    if (!part.edges) return;
    mergePositions(part.edges, edges, offset, matrices[i]);
    offset += part.edges.length;
  });
  return { body: mergeParts(parts, matrices, "body"), floor: mergeParts(parts, matrices, "floor"), edges: edges.length ? edges : null };
}

export function geometryArrays({ body, floor, edges }: PreparedGeometry): Float32Array[] {
  return [body?.positions, body?.normals, body?.uvs, floor?.positions, floor?.normals, floor?.uvs, edges]
    .filter((value): value is Float32Array => !!value);
}

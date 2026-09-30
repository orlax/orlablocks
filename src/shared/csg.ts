import type { ManifoldToplevel } from "manifold-3d";
import { toLocal3 } from "./geometry";
import { cutsFloor } from "./holes";
import { hitMesh, shapeMesh, type Mesh, type ShapeParts } from "./mesh";
import type { ClosedShape, Solid } from "./scene.types";

/**
 * Holes, cut with manifold (a WebAssembly build of the Manifold library, whose booleans are exact on coplanar faces
 * and always give a closed mesh). The editor (`src/web/csg.ts`) and the server (`src/server/manifold.ts`) each load
 * the module and hand it over with `setManifold`; until then shapes come out uncut (15.1).
 */

let wasm: ManifoldToplevel | null = null;
let onError: (e: unknown) => void = () => {};

/** The loaded module, and where a failed cut is reported (the editor's error panel, the export's warnings). */
export function setManifold(m: ManifoldToplevel, report?: (e: unknown) => void): void {
  wasm = m;
  if (report) onError = report;
}

/** Whether the boolean library is loaded. */
export const manifoldLoaded = () => wasm !== null;

/** A hole's solid in `target`'s own frame (the frame `shapeMesh` builds the target in). */
export function holeInFrameOf(target: Solid, hole: ClosedShape): Mesh | null {
  const m = hitMesh(hole);
  if (!m) return null;
  const positions: number[] = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    const p = toLocal3(target, { x: m.positions[i], y: m.positions[i + 1], z: m.positions[i + 2] });
    positions.push(p.x, p.y, p.z);
  }
  return { positions, indices: m.indices };
}

/**
 * `mesh` minus every one of `holes` (all in the same frame). Null when nothing is left. If the library isn't loaded
 * or the cut fails (reported to the `setManifold` handler), the mesh comes back uncut.
 */
export function subtract(mesh: Mesh, holes: Mesh[]): Mesh | null {
  if (!wasm || holes.length === 0) return mesh;
  const { Manifold, Mesh: MMesh } = wasm;
  const made: { delete(): void }[] = [];
  const solid = (m: Mesh) => {
    const mm = new MMesh({ numProp: 3, vertProperties: new Float32Array(m.positions), triVerts: new Uint32Array(m.indices) });
    mm.merge();
    const s = new Manifold(mm);
    made.push(s);
    return s;
  };
  try {
    const body = solid(mesh);
    const cutters = holes.map(solid);
    const union = cutters.length === 1 ? cutters[0] : Manifold.union(cutters);
    if (union !== cutters[0]) made.push(union);
    const result = body.subtract(union);
    made.push(result);
    const out = result.getMesh();
    if (out.triVerts.length === 0) return null;
    const positions: number[] = [];
    for (let i = 0; i < out.numVert; i++) positions.push(out.vertProperties[i * out.numProp], out.vertProperties[i * out.numProp + 1], out.vertProperties[i * out.numProp + 2]);
    return { positions, indices: Array.from(out.triVerts) };
  } catch (e) {
    onError(e);
    return mesh;
  } finally {
    made.forEach((m) => m.delete());
  }
}

/**
 * A shape's parts (`shapeMesh`, in its own frame) minus the holes that cut it: the body by all of them, a room's
 * floor only by the holes that reach below it (`cutsFloor`). Uncut while the library isn't loaded.
 */
export function cutParts(shape: Solid, cuts: ClosedShape[] | undefined): ShapeParts {
  const p = shapeMesh(shape);
  if (!wasm || !cuts || cuts.length === 0) return p;
  const holes = cuts.map((h) => ({ hole: h, mesh: holeInFrameOf(shape, h) })).filter((h): h is { hole: ClosedShape; mesh: Mesh } => h.mesh !== null);
  const floorHoles = shape.type === "ramp" ? [] : holes.filter((h) => cutsFloor(h.hole, shape)).map((h) => h.mesh);
  return {
    body: p.body && subtract(p.body, holes.map((h) => h.mesh)),
    floor: p.floor && (floorHoles.length > 0 ? subtract(p.floor, floorHoles) : p.floor),
  };
}

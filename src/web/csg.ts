import { useEffect, useState } from "react";
import Module, { type ManifoldToplevel } from "manifold-3d";
import wasmUrl from "manifold-3d/manifold.wasm?url";
import { toLocal3 } from "../shared/geometry";
import { hitMesh, type Mesh } from "../shared/mesh";
import type { Solid } from "../shared/scene.types";
import { reportError } from "./errors";

/**
 * Holes, cut when drawing: a shape's mesh minus the union of the holes that cut it, with manifold (a WebAssembly
 * build of the Manifold library, whose booleans are exact on coplanar faces and always give a closed mesh). It
 * loads once, in the background; until it's ready shapes are drawn uncut.
 */

let wasm: ManifoldToplevel | null = null;
let loading: Promise<void> | null = null;
const waiting = new Set<() => void>();

function load(): Promise<void> {
  loading ??= Module({ locateFile: () => wasmUrl })
    .then((m) => {
      m.setup();
      wasm = m;
      waiting.forEach((f) => f());
      waiting.clear();
    })
    .catch((e) => reportError("view", e));
  return loading;
}

/** Whether the boolean library is ready; loads it on first use and re-renders the caller when it is. */
export function useManifold(): boolean {
  const [ready, setReady] = useState(wasm !== null);
  useEffect(() => {
    if (wasm) return;
    const done = () => setReady(true);
    waiting.add(done);
    void load();
    return () => void waiting.delete(done);
  }, []);
  return ready;
}

/** A hole's solid in `target`'s own frame (the frame `shapeMesh` builds the target in). */
export function holeInFrameOf(target: Solid, hole: Solid): Mesh | null {
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
 * `mesh` minus every one of `holes` (all in the same frame). Null when nothing is left. If the library isn't ready
 * or the cut fails (it reports why in the error panel), the mesh comes back uncut.
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
    reportError("view", e);
    return mesh;
  } finally {
    made.forEach((m) => m.delete());
  }
}

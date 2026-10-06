import { footprint, pointInPolygon, volumeRings } from "./geometry";
import { hitMesh, type Mesh } from "./mesh";
import type { Box, Cylinder, SceneNode, Terrain } from "./scene.types";
import { childrenOf, hiddenIds, subtreeIds } from "./tree";

export type TerrainSource = Box | Cylinder;
export type Heightfield = { heights: Float32Array; min: number; max: number; mesh: Mesh };

/** Same depth-first order as the fully expanded outliner, independent of collapsed UI state. */
export function terrainSources(terrain: Terrain, nodes: SceneNode[]): TerrainSource[] {
  const hidden = hiddenIds(nodes);
  const out: TerrainSource[] = [];
  const walk = (id: string) => {
    if (hidden.has(id)) return;
    for (const n of childrenOf(nodes, id)) {
      if (hidden.has(n.id)) continue;
      if (n.type === "group") walk(n.id);
      else if (n.type === "box" || n.type === "cylinder") out.push(n);
    }
  };
  if (terrain.source) walk(terrain.source);
  return out;
}

export function terrainInputIds(nodes: SceneNode[]): Set<string> {
  const ids = new Set<string>();
  for (const n of nodes) if (n.type === "terrain" && n.source) for (const id of subtreeIds(nodes, n.source)) ids.add(id);
  return ids;
}

/** Validate on the prospective scene, before any edit commits. */
export function terrainProblems(nodes: SceneNode[]): string[] {
  const errors: string[] = [];
  const owned = new Map<string, string>();
  for (const t of nodes) {
    if (t.type !== "terrain" || !t.source) continue;
    if (!nodes.some((n) => n.id === t.source && n.type === "group")) {
      errors.push(`${t.id}: source must name a group`);
      continue;
    }
    const ids = subtreeIds(nodes, t.source);
    for (const n of nodes) {
      if (!ids.has(n.id)) continue;
      if (owned.has(n.id)) errors.push(`${t.id}: source overlaps ${owned.get(n.id)}`);
      owned.set(n.id, t.id);
      if (n.type === "group" || n.type === "note" || n.type === "line") continue;
      if ((n.type !== "box" && n.type !== "cylinder") || n.kind !== "volume" || n.pitch || n.roll)
        errors.push(`${n.id}: terrain sources currently support untilted box and cylinder volumes only`);
    }
  }
  return errors;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
export function applyTerrainHeight(h: number, target: number, weight: number, operation: "raise" | "lower" | "set"): number {
  const delta = target - h;
  return h + weight * (operation === "raise" ? Math.max(0, delta) : operation === "lower" ? Math.min(0, delta) : delta);
}

const cache = new WeakMap<Terrain, { key: string; result: Heightfield }>();
/** Rasterize upper triangles once per modifier; footprint distance supplies its exterior fade. */
export function evaluateTerrain(t: Terrain, nodes: SceneNode[]): Heightfield {
  const sources = terrainSources(t, nodes);
  const key = JSON.stringify(sources);
  const cached = cache.get(t);
  if (cached?.key === key) return cached.result;
  const n = t.resolution, dx = t.width / (n - 1), dz = t.depth / (n - 1);
  const x0 = t.x - t.width / 2, z0 = t.z - t.depth / 2;
  const heights = new Float32Array(n * n).fill(t.y);
  for (const s of sources) {
    const mesh = hitMesh(s)!;
    const target = new Float64Array(n * n).fill(-Infinity);
    const p = mesh.positions;
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const a = mesh.indices[k] * 3, b = mesh.indices[k + 1] * 3, c = mesh.indices[k + 2] * 3;
      const den = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
      if (Math.abs(den) < 1e-12) continue;
      const loX = Math.max(0, Math.ceil((Math.min(p[a], p[b], p[c]) - x0) / dx - 1e-8));
      const hiX = Math.min(n - 1, Math.floor((Math.max(p[a], p[b], p[c]) - x0) / dx + 1e-8));
      const loZ = Math.max(0, Math.ceil((Math.min(p[a + 2], p[b + 2], p[c + 2]) - z0) / dz - 1e-8));
      const hiZ = Math.min(n - 1, Math.floor((Math.max(p[a + 2], p[b + 2], p[c + 2]) - z0) / dz + 1e-8));
      for (let z = loZ; z <= hiZ; z++) for (let x = loX; x <= hiX; x++) {
        const wx = x0 + x * dx, wz = z0 + z * dz;
        const u = ((p[b + 2] - p[c + 2]) * (wx - p[c]) + (p[c] - p[b]) * (wz - p[c + 2])) / den;
        const v = ((p[c + 2] - p[a + 2]) * (wx - p[c]) + (p[a] - p[c]) * (wz - p[c + 2])) / den;
        if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8)
          target[z * n + x] = Math.max(target[z * n + x], u * p[a + 1] + v * p[b + 1] + (1 - u - v) * p[c + 1]);
      }
    }
    const ring = footprint(s), fade = s.terrain?.fade ?? 0;
    // Untilting preserves a constant height along the outer boundary. A taper meets it at the base;
    // a prism/bevel has vertical sides up to the highest ring that still matches its footprint.
    const rings = volumeRings(s), base = rings[0].ring;
    let edgeY = s.y;
    for (const r of rings) if (r.ring.every((v, i) => Math.hypot(v.x - base[i].x, v.z - base[i].z) < 1e-8)) edgeY = s.y + r.y;
    const minX = Math.max(0, Math.ceil((mesh.min[0] - fade - x0) / dx));
    const maxX = Math.min(n - 1, Math.floor((mesh.max[0] + fade - x0) / dx));
    const minZ = Math.max(0, Math.ceil((mesh.min[2] - fade - z0) / dz));
    const maxZ = Math.min(n - 1, Math.floor((mesh.max[2] + fade - z0) / dz));
    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
      const i = z * n + x;
      let w = 1, h = target[i];
      if (!Number.isFinite(h)) {
        if (fade === 0) continue;
        const q = { x: x0 + x * dx, z: z0 + z * dz };
        if (pointInPolygon(ring, q)) continue;
        let distance = Infinity;
        for (let j = 0; j < ring.length; j++) {
          const a = ring[j], b = ring[(j + 1) % ring.length], ex = b.x - a.x, ez = b.z - a.z;
          const u = Math.max(0, Math.min(1, ((q.x - a.x) * ex + (q.z - a.z) * ez) / (ex * ex + ez * ez || 1)));
          distance = Math.min(distance, Math.hypot(q.x - a.x - u * ex, q.z - a.z - u * ez));
        }
        if (distance >= fade) continue;
        w = 1 - smooth(distance / fade); h = edgeY;
      }
      heights[i] = applyTerrainHeight(heights[i], h, w, s.terrain?.operation ?? "raise");
    }
  }
  let min = Infinity, max = -Infinity;
  const positions: number[] = [], indices: number[] = [];
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const h = heights[z * n + x]; min = Math.min(min, h); max = Math.max(max, h);
    positions.push(x0 + x * dx, h, z0 + z * dz);
    if (x < n - 1 && z < n - 1) { const i = z * n + x; indices.push(i, i + n, i + 1, i + 1, i + n, i + n + 1); }
  }
  const result = { heights, min, max, mesh: { positions, indices } };
  cache.set(t, { key, result });
  return result;
}

import { rayMeshFirst } from "./ray";
import { footprint, pointInPolygon, volumeRings, rampStations, offsetRings, boundsOf } from "./geometry";
import { hitMesh, type Mesh } from "./mesh";
import type { Box, Cylinder, Freeform, Ramp, SceneNode, Terrain, Shape } from "./scene.types";
import { childrenOf, hiddenIds, subtreeIds } from "./tree";

export type TerrainSource = Box | Cylinder | Freeform | Ramp;
/** Shared by validation, the Inspector and Make terrain. */
export function isTerrainSource(n: SceneNode): n is TerrainSource {
  return n.type === "ramp" ? n.step === undefined :
    (n.type === "box" || n.type === "cylinder" || n.type === "freeform") && n.kind === "volume" && !n.pitch && !n.roll;
}

/** The upper boundary; ramp edges retain their height along a rising/curved path. */
export function terrainBoundary(s: TerrainSource): { x: number; y: number; z: number }[] {
  if (s.type === "ramp") {
    const st = rampStations(s);
    return [...st.map((p) => ({ ...p.left, y: p.y })), ...[...st].reverse().map((p) => ({ ...p.right, y: p.y }))];
  }
  const rings = volumeRings(s), base = rings[0].ring;
  let y = s.y;
  for (const r of rings) if (r.ring.every((v, i) => Math.hypot(v.x - base[i].x, v.z - base[i].z) < 1e-8)) y = s.y + r.y;
  return footprint(s).map((p) => ({ ...p, y }));
}

/** A selected modifier's outer influence outline, using the existing polygon offset. */
export function terrainInfluence(s: TerrainSource): { x: number; z: number }[][] {
  const ring = terrainBoundary(s);
  return s.terrain?.fade ? offsetRings(ring, s.terrain.fade, false) : [ring];
}

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
      else if (isTerrainSource(n)) out.push(n);
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
      if (!isTerrainSource(n))
        errors.push(`${n.id}: terrain sources support untilted box, cylinder and free-form volumes and smooth ramps only (no rooms, holes, stairs, instances or arrays)`);
    }
  }
  return errors;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
export function applyTerrainHeight(h: number, target: number, weight: number, operation: "raise" | "lower" | "set"): number {
  const delta = target - h;
  return h + weight * (operation === "raise" ? Math.max(0, delta) : operation === "lower" ? Math.min(0, delta) : delta);
}

// A small content cache survives immutable node/color edits and never holds old projects indefinitely.
const CACHE_BYTES = 128 * 1024 * 1024;
const cache = new Map<string, { key: string; result: Heightfield; bytes: number }>();
let cachedBytes = 0;
const gridIndices = new Map<number, number[]>();
const sourceKey = (s: TerrainSource) => {
  const { id, name, parent, color, tags, locked, hidden, createdBy, ...geometry } = s;
  return geometry;
};

/** The same preview rule for meshes, picking and influence outlines. Canonical callers never opt into it. */
export const previewTerrain = (t: Terrain, active: boolean): Terrain => active && t.resolution > 129 ? { ...t, resolution: 129 } : t;

/** Rasterize only the affected rectangle per input; ordered operations remain identical to canonical evaluation. */
export function evaluateTerrain(t: Terrain, nodes: SceneNode[]): Heightfield {
  const sources = terrainSources(t, nodes);
  const key = JSON.stringify([t.x, t.y, t.z, t.width, t.depth, t.resolution, sources.map(sourceKey)]);
  const cached = cache.get(t.id);
  if (cached?.key === key) { cache.delete(t.id); cache.set(t.id, cached); return cached.result; }
  const n = t.resolution, dx = t.width / (n - 1), dz = t.depth / (n - 1);
  const x0 = t.x - t.width / 2, z0 = t.z - t.depth / 2;
  const heights = new Float32Array(n * n).fill(t.y);
  for (const s of sources) {
    const mesh = hitMesh(s);
    if (!mesh) continue;
    const ring = terrainBoundary(s), fade = s.terrain?.fade ?? 0;
    const minX = Math.max(0, Math.ceil((mesh.min[0] - fade - x0) / dx));
    const maxX = Math.min(n - 1, Math.floor((mesh.max[0] + fade - x0) / dx));
    const minZ = Math.max(0, Math.ceil((mesh.min[2] - fade - z0) / dz));
    const maxZ = Math.min(n - 1, Math.floor((mesh.max[2] + fade - z0) / dz));
    if (minX > maxX || minZ > maxZ) continue;
    const columns = maxX - minX + 1;
    const target = new Float64Array(columns * (maxZ - minZ + 1)).fill(-Infinity);
    const at = (x: number, z: number) => (z - minZ) * columns + x - minX;
    const p = mesh.positions;
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const a = mesh.indices[k] * 3, b = mesh.indices[k + 1] * 3, c = mesh.indices[k + 2] * 3;
      const den = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
      if (Math.abs(den) < 1e-12) continue;
      const loX = Math.max(minX, Math.ceil((Math.min(p[a], p[b], p[c]) - x0) / dx - 1e-8));
      const hiX = Math.min(maxX, Math.floor((Math.max(p[a], p[b], p[c]) - x0) / dx + 1e-8));
      const loZ = Math.max(minZ, Math.ceil((Math.min(p[a + 2], p[b + 2], p[c + 2]) - z0) / dz - 1e-8));
      const hiZ = Math.min(maxZ, Math.floor((Math.max(p[a + 2], p[b + 2], p[c + 2]) - z0) / dz + 1e-8));
      for (let z = loZ; z <= hiZ; z++) for (let x = loX; x <= hiX; x++) {
        const wx = x0 + x * dx, wz = z0 + z * dz;
        const u = ((p[b + 2] - p[c + 2]) * (wx - p[c]) + (p[c] - p[b]) * (wz - p[c + 2])) / den;
        const v = ((p[c + 2] - p[a + 2]) * (wx - p[c]) + (p[a] - p[c]) * (wz - p[c + 2])) / den;
        if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8)
          target[at(x, z)] = Math.max(target[at(x, z)], u * p[a + 1] + v * p[b + 1] + (1 - u - v) * p[c + 1]);
      }
    }
    for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
      const i = z * n + x;
      let w = 1, h = target[at(x, z)];
      if (!Number.isFinite(h)) {
        if (fade === 0) continue;
        const q = { x: x0 + x * dx, z: z0 + z * dz };
        if (pointInPolygon(ring, q)) continue;
        let distance = Infinity, edgeY = 0;
        for (let j = 0; j < ring.length; j++) {
          const a = ring[j], b = ring[(j + 1) % ring.length], ex = b.x - a.x, ez = b.z - a.z;
          const u = Math.max(0, Math.min(1, ((q.x - a.x) * ex + (q.z - a.z) * ez) / (ex * ex + ez * ez || 1)));
          const d = Math.hypot(q.x - a.x - u * ex, q.z - a.z - u * ez);
          if (d < distance) { distance = d; edgeY = a.y + u * (b.y - a.y); }
        }
        if (distance >= fade) continue;
        w = 1 - smooth(distance / fade); h = edgeY;
      }
      heights[i] = applyTerrainHeight(heights[i], h, w, s.terrain?.operation ?? "raise");
    }
  }
  let min = Infinity, max = -Infinity;
  const positions = new Array<number>(n * n * 3);
  let indices = gridIndices.get(n);
  if (!indices) {
    indices = new Array<number>((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) {
      const i = z * n + x;
      for (const v of [i, i + n, i + 1, i + 1, i + n, i + n + 1]) indices[k++] = v;
    }
    gridIndices.set(n, indices);
  }
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const i = z * n + x, h = heights[i]; min = Math.min(min, h); max = Math.max(max, h);
    positions[i * 3] = x0 + x * dx; positions[i * 3 + 1] = h; positions[i * 3 + 2] = z0 + z * dz;
  }
  const result = { heights, min, max, mesh: { positions, indices } };
  if (cached) { cachedBytes -= cached.bytes; cache.delete(t.id); }
  const bytes = heights.byteLength + positions.length * 8;
  while (cache.size && (cache.size >= 8 || cachedBytes + bytes > CACHE_BYTES)) {
    const [id, oldest] = cache.entries().next().value!;
    cache.delete(id); cachedBytes -= oldest.bytes;
  }
  cache.set(t.id, { key, result, bytes }); cachedBytes += bytes;
  return result;
}


/** Derived bounds for reads and render framing; ordinary geometry retains its existing bounds. */
export function boundsWithTerrain(shapes: Shape[], nodes: SceneNode[]) {
  const ordinary = shapes.filter((n) => n.type !== "terrain");
  let bounds = ordinary.length ? boundsOf(ordinary) : undefined;
  for (const n of shapes) if (n.type === "terrain") {
    const f = evaluateTerrain(n, nodes);
    const b = { minX: n.x - n.width / 2, maxX: n.x + n.width / 2, minZ: n.z - n.depth / 2, maxZ: n.z + n.depth / 2, minY: f.min, maxY: f.max };
    bounds = bounds ? { minX: Math.min(bounds.minX, b.minX), maxX: Math.max(bounds.maxX, b.maxX), minZ: Math.min(bounds.minZ, b.minZ), maxZ: Math.max(bounds.maxZ, b.maxZ), minY: Math.min(bounds.minY, b.minY), maxY: Math.max(bounds.maxY, b.maxY) } : b;
  }
  return bounds ?? boundsOf([]);
}

/** Small terrain metadata; height samples are never part of scene/MCP read results. */
export function terrainSummary(t: Terrain, nodes: SceneNode[]) {
  const f = evaluateTerrain(t, nodes);
  return { source: t.source, resolution: t.resolution, cellSpacing: { x: t.width / (t.resolution - 1), z: t.depth / (t.resolution - 1) }, elevation: [f.min, f.max] };
}

export const TERRAIN_QUERY_LIMIT = "Terrain-aware surface placement, Walk, sight, clearance, slices, enclosure and lint are deferred. These checks do not verify generated terrain; authoring inputs are not its collision proxy.";
export const terrainQueryWarnings = (nodes: SceneNode[]) => nodes.some((n) => n.type === "terrain") ? [TERRAIN_QUERY_LIMIT] : [];

/** Source settings, including defaults and their place in the operation stack; dormant settings stay readable. */
export function terrainReadFields(n: SceneNode, nodes: SceneNode[]) {
  if (!isTerrainSource(n)) return {};
  const owner = nodes.find((t) => t.type === "terrain" && t.source && subtreeIds(nodes, t.source).has(n.id));
  if (!owner && !n.terrain) return {};
  const order: string[] = [];
  if (owner?.type === "terrain" && owner.source) {
    const walk = (id: string) => { for (const child of childrenOf(nodes, id)) { if (child.type === "group") walk(child.id); else if (isTerrainSource(child)) order.push(child.id); } };
    walk(owner.source);
  }
  return { terrain: n.terrain ?? { operation: "raise" as const, fade: 0 }, ...(owner ? { terrainFor: owner.id, modifierOrder: order.indexOf(n.id) + 1 } : { terrainDormant: true }) };
}

/** Editor picking walks only the heightfield cells crossed by the ray, using the exact drawn triangles. */
export function rayTerrainFirst(ray: import("./ray").Ray, t: Terrain, field: Heightfield) {
  const n = t.resolution, dx = t.width / (n - 1), dz = t.depth / (n - 1);
  const x0 = t.x - t.width / 2, z0 = t.z - t.depth / 2;
  let enter = 0, exit = Infinity;
  const origin = [ray.origin.x, ray.origin.y, ray.origin.z], dir = [ray.dir.x, ray.dir.y, ray.dir.z];
  const min = [x0, field.min, z0], max = [x0 + t.width, field.max, z0 + t.depth];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(dir[k]) < 1e-12) { if (origin[k] < min[k] || origin[k] > max[k]) return null; continue; }
    const a = (min[k] - origin[k]) / dir[k], b = (max[k] - origin[k]) / dir[k];
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
  }
  if (enter > exit) return null;
  let x = Math.max(0, Math.min(n - 2, Math.floor((ray.origin.x + ray.dir.x * enter - x0) / dx)));
  let z = Math.max(0, Math.min(n - 2, Math.floor((ray.origin.z + ray.dir.z * enter - z0) / dz)));
  const sx = Math.sign(ray.dir.x), sz = Math.sign(ray.dir.z);
  const stepX = sx ? dx / Math.abs(ray.dir.x) : Infinity, stepZ = sz ? dz / Math.abs(ray.dir.z) : Infinity;
  let nextX = sx ? (x0 + (x + (sx > 0 ? 1 : 0)) * dx - ray.origin.x) / ray.dir.x : Infinity;
  let nextZ = sz ? (z0 + (z + (sz > 0 ? 1 : 0)) * dz - ray.origin.z) / ray.dir.z : Infinity;
  for (let count = 0; count < 2 * n && x >= 0 && z >= 0 && x < n - 1 && z < n - 1; count++) {
    const at = (z * (n - 1) + x) * 6;
    const hit = rayMeshFirst(ray, { positions: field.mesh.positions, indices: field.mesh.indices.slice(at, at + 6), min: [x0 + x * dx, field.min, z0 + z * dz], max: [x0 + (x + 1) * dx, field.max, z0 + (z + 1) * dz] });
    if (hit && hit.t >= enter - 1e-8 && hit.t <= exit + 1e-8) return hit;
    const next = Math.min(nextX, nextZ);
    if (!Number.isFinite(next) || next > exit + 1e-8) break;
    if (nextX <= nextZ) { x += sx; nextX += stepX; }
    else { z += sz; nextZ += stepZ; }
  }
  return null;
}

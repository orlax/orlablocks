import { expandNodes } from "./entities";
import { boundsOf, isSolid, localFootprint, pointInPolygon, round2, toLocal3, toWorld3 } from "./geometry";
import { cutters, isHole } from "./holes";
import { shapeMesh, type Mesh } from "./mesh";
import type { ClosedShape, SceneNode, Shape, Solid } from "./scene.types";
import { sightOwner } from "./sight";
import { hiddenIds } from "./tree";

/**
 * The enclosure check (plan 14 §10, `check_enclosure`): is the air around a point sealed in, up to a height? A flood
 * fill of the air on a voxel grid over the scene: a cell is solid when its center is inside a solid (and not in a hole
 * that cuts it). Each solid is read column by column with one vertical ray per column through its closed meshes (the
 * crossings pair up into solid spans), so the grid costs about as much as the meshes' triangles.
 *
 * When the air escapes (reaches the grid's side, beyond the scene's bounds, or the band's top with `openTop`), the
 * escape route is traced back and its narrowest point is the gap: its place, its height range, how wide it is and the
 * two solids on either side. The gap is then plugged and the fill run again, for the next one, up to MAX_GAPS.
 */

export const DEFAULT_CELL = 2;
export const MAX_CELLS = 2_000_000;
export const MAX_GAPS = 6;

export type EnclosureInput = {
  from: { x: number; y: number; z: number };
  /** The heights to seal over: [bottom, top]; by default from the lowest solid's bottom to the highest top. */
  band?: [number, number];
  cell?: number;
  /** Reaching the band's top counts as escaping (without: the top is a lid). */
  openTop?: boolean;
  /** Nodes left out (with what's in them). */
  ignore?: string[];
};

export type Gap = { at: { x: number; y: number; z: number }; y: [number, number]; width: number; between: string[] };
export type EnclosureResult =
  | { sealed: true; cell: number; band: [number, number]; air: { volume: number; bounds: { x: [number, number]; y: [number, number]; z: [number, number] } }; note?: string }
  | { sealed: false; cell: number; band: [number, number]; escapes: Gap[]; more?: boolean; note?: string };

/** A closed shape's or ramp's closed meshes in the world (a room's walls and its floor slab). */
function worldMeshes(shape: Solid): Mesh[] {
  const { body, floor } = shapeMesh(shape);
  return [body, floor].flatMap((m) => {
    if (!m) return [];
    if (shape.type === "ramp") return [m];
    const positions: number[] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      const w = toWorld3(shape, { x: m.positions[i], y: m.positions[i + 1], z: m.positions[i + 2] });
      positions.push(w.x, w.y, w.z);
    }
    return [{ positions, indices: m.indices }];
  });
}

function insideHole(hole: ClosedShape, p: { x: number; y: number; z: number }): boolean {
  const l = toLocal3(hole, p);
  if (l.y < -1e-6 || l.y > hole.height + 1e-6) return false;
  return pointInPolygon(localFootprint(hole), l);
}

export function checkEnclosure(nodes: SceneNode[], input: EnclosureInput): EnclosureResult {
  const expanded = expandNodes(nodes);
  const hidden = hiddenIds(expanded);
  const ignored = new Set(input.ignore ?? []);
  const leftOut = (id: string) => hidden.has(id) || ignored.has(id) || ignored.has(sightOwner(id)) || ignored.has(id.split("/")[0]);
  const visible = expanded.filter((n) => !leftOut(n.id));
  const solids = visible.filter((n): n is Solid => n.type !== "group" && isSolid(n as Shape) && !isHole(n));
  const cuts = cutters(visible);
  if (solids.length === 0) throw new Error("there are no solids to enclose anything");

  const b = boundsOf(solids);
  const band: [number, number] = input.band ?? [round2(Math.min(b.minY, input.from.y)), round2(b.maxY)];
  if (band[1] <= band[0]) throw new Error("band: its top must be above its bottom");
  // The cell: as asked, grown until the grid fits MAX_CELLS.
  const spanX = b.maxX - b.minX;
  const spanZ = b.maxZ - b.minZ;
  const spanY = band[1] - band[0];
  let cell = Math.max(0.25, input.cell ?? DEFAULT_CELL);
  const count = (c: number) => (Math.ceil(spanX / c) + 4) * (Math.ceil(spanZ / c) + 4) * Math.ceil(spanY / c);
  let note: string | undefined;
  while (count(cell) > MAX_CELLS) cell *= 1.25;
  cell = round2(cell);
  if (input.cell !== undefined && cell > input.cell) note = `the grid would have been too large at ${input.cell} m: it used ${cell} m cells`;
  // Two cells of margin around the solids: air that reaches it is outside.
  const x0 = b.minX - 2 * cell;
  const z0 = b.minZ - 2 * cell;
  const nx = Math.ceil(spanX / cell) + 4;
  const nz = Math.ceil(spanZ / cell) + 4;
  const ny = Math.max(1, Math.ceil(spanY / cell));
  const idx = (i: number, k: number, j: number) => (j * nz + k) * nx + i;
  const center = (i: number, k: number, j: number) => ({ x: x0 + (i + 0.5) * cell, y: band[0] + (j + 0.5) * cell, z: z0 + (k + 0.5) * cell });
  // 0 air, else 1 + the solid's index.
  const owner = new Int32Array(nx * nz * ny);

  // Each solid, column by column: a vertical ray through each column's center (nudged off edges) meets its meshes.
  const JX = 1.37e-4;
  const JZ = 2.11e-4;
  solids.forEach((s, si) => {
    const hits = new Map<number, number[]>();
    for (const m of worldMeshes(s)) {
      const p = m.positions;
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, c, d] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
        const minX = Math.min(p[a], p[c], p[d]);
        const maxX = Math.max(p[a], p[c], p[d]);
        const minZ = Math.min(p[a + 2], p[c + 2], p[d + 2]);
        const maxZ = Math.max(p[a + 2], p[c + 2], p[d + 2]);
        const i0 = Math.max(0, Math.ceil((minX - x0) / cell - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((maxX - x0) / cell - 0.5));
        const k0 = Math.max(0, Math.ceil((minZ - z0) / cell - 0.5));
        const k1 = Math.min(nz - 1, Math.floor((maxZ - z0) / cell - 0.5));
        for (let i = i0; i <= i1; i++) {
          for (let k = k0; k <= k1; k++) {
            const px = x0 + (i + 0.5) * cell + JX;
            const pz = z0 + (k + 0.5) * cell + JZ;
            // Barycentric in x/z.
            const v0x = p[c] - p[a], v0z = p[c + 2] - p[a + 2];
            const v1x = p[d] - p[a], v1z = p[d + 2] - p[a + 2];
            const v2x = px - p[a], v2z = pz - p[a + 2];
            const den = v0x * v1z - v1x * v0z;
            if (Math.abs(den) < 1e-12) continue;
            const u = (v2x * v1z - v1x * v2z) / den;
            const v = (v0x * v2z - v2x * v0z) / den;
            if (u < 0 || v < 0 || u + v > 1) continue;
            const y = p[a + 1] + u * (p[c + 1] - p[a + 1]) + v * (p[d + 1] - p[a + 1]);
            const col = k * nx + i;
            const list = hits.get(col);
            if (list) list.push(y);
            else hits.set(col, [y]);
          }
        }
      }
    }
    const holes = cuts.get(s.id) ?? [];
    for (const [col, ys] of hits) {
      ys.sort((p, q) => p - q);
      const i = col % nx;
      const k = Math.floor(col / nx);
      for (let h = 0; h + 1 < ys.length; h += 2) {
        const j0 = Math.max(0, Math.ceil((ys[h] - band[0]) / cell - 0.5));
        const j1 = Math.min(ny - 1, Math.floor((ys[h + 1] - band[0]) / cell - 0.5));
        for (let j = j0; j <= j1; j++) {
          if (holes.length > 0 && holes.some((hole) => insideHole(hole, center(i, k, j)))) continue;
          owner[idx(i, k, j)] = si + 1;
        }
      }
    }
  });

  const cellOf = (p: { x: number; y: number; z: number }) => ({
    i: Math.floor((p.x - x0) / cell),
    k: Math.floor((p.z - z0) / cell),
    j: Math.floor((p.y - band[0]) / cell),
  });
  const start = cellOf(input.from);
  if (start.i < 0 || start.i >= nx || start.k < 0 || start.k >= nz || start.j < 0 || start.j >= ny) {
    throw new Error(`from: ${input.from.x}, ${input.from.y}, ${input.from.z} is outside the scene or the band ${band[0]}–${band[1]}`);
  }
  if (owner[idx(start.i, start.k, start.j)]) {
    throw new Error(`from: that point is inside ${sightOwner(solids[owner[idx(start.i, start.k, start.j)] - 1].id)}; start in the air`);
  }

  const plugged = new Uint8Array(nx * nz * ny);
  const solidAt = (i: number, k: number, j: number) => owner[idx(i, k, j)] !== 0 || plugged[idx(i, k, j)] !== 0;
  const outside = (i: number, k: number, j: number) => i === 0 || k === 0 || i === nx - 1 || k === nz - 1 || (!!input.openTop && j === ny - 1);
  const STEPS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  /** The fill from the start: the cell it escaped at (and every cell's parent), or null when sealed. */
  const fill = () => {
    const parent = new Int32Array(nx * nz * ny).fill(-1);
    const s0 = idx(start.i, start.k, start.j);
    parent[s0] = s0;
    const queue = new Int32Array(nx * nz * ny);
    let [head, tail] = [0, 0];
    queue[tail++] = s0;
    let reached = 0;
    while (head < tail) {
      const cur = queue[head++];
      reached++;
      const i = cur % nx;
      const k = Math.floor(cur / nx) % nz;
      const j = Math.floor(cur / (nx * nz));
      if (outside(i, k, j)) return { escape: cur, parent, reached };
      for (const [di, dj, dk] of STEPS) {
        const [a, c, d] = [i + di, k + dk, j + dj];
        if (a < 0 || c < 0 || d < 0 || a >= nx || c >= nz || d >= ny) continue;
        const n = idx(a, c, d);
        if (parent[n] !== -1 || solidAt(a, c, d)) continue;
        parent[n] = cur;
        queue[tail++] = n;
      }
    }
    return { escape: -1, parent, reached, queue: queue.subarray(0, tail) };
  };

  /** How wide the air is at a cell across the narrowest of four ground directions, and what's on either side. */
  const widthAt = (i: number, k: number, j: number, limit: number) => {
    let best: { width: number; sides: number[] } | null = null;
    for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const scan = (sx: number, sz: number) => {
        for (let t = 1; t <= limit; t++) {
          const [a, c] = [i + sx * t, k + sz * t];
          if (a < 0 || c < 0 || a >= nx || c >= nz) return null;
          if (solidAt(a, c, j)) return { t, owner: owner[idx(a, c, j)] };
        }
        return null;
      };
      const p = scan(dx, dz);
      const q = scan(-dx, -dz);
      if (!p || !q) continue;
      const w = (p.t + q.t - 1) * (dx && dz ? Math.SQRT2 : 1);
      if (!best || w < best.width) best = { width: w, sides: [p.owner, q.owner] };
    }
    return best;
  };

  const gaps: Gap[] = [];
  let more = false;
  for (;;) {
    const run = fill();
    if (run.escape < 0) {
      if (gaps.length > 0) break;
      // Sealed: the air's volume and bounds.
      const cells = run.queue!;
      let [minI, maxI, minK, maxK, minJ, maxJ] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
      for (const c of cells) {
        const i = c % nx;
        const k = Math.floor(c / nx) % nz;
        const j = Math.floor(c / (nx * nz));
        [minI, maxI, minK, maxK, minJ, maxJ] = [Math.min(minI, i), Math.max(maxI, i), Math.min(minK, k), Math.max(maxK, k), Math.min(minJ, j), Math.max(maxJ, j)];
      }
      return {
        sealed: true,
        cell,
        band,
        air: {
          volume: Math.round(cells.length * cell ** 3),
          bounds: {
            x: [round2(x0 + minI * cell), round2(x0 + (maxI + 1) * cell)],
            y: [round2(band[0] + minJ * cell), round2(band[0] + (maxJ + 1) * cell)],
            z: [round2(z0 + minK * cell), round2(z0 + (maxK + 1) * cell)],
          },
        },
        ...(note ? { note } : {}),
      };
    }
    if (gaps.length >= MAX_GAPS) {
      more = true;
      break;
    }
    // The route out, from the start: its narrowest point is the gap.
    const route: number[] = [];
    for (let c = run.escape; ; c = run.parent[c]) {
      route.push(c);
      if (run.parent[c] === c) break;
    }
    route.reverse();
    const limit = Math.max(4, Math.ceil(40 / cell));
    let gap: { c: number; width: number; sides: number[] } | null = null;
    for (const c of route) {
      const i = c % nx;
      const k = Math.floor(c / nx) % nz;
      const j = Math.floor(c / (nx * nz));
      const w = widthAt(i, k, j, limit);
      if (w && (!gap || w.width < gap.width)) gap = { c, width: w.width, sides: w.sides };
    }
    // No pinch on the way out (wide open): the gap is where the route leaves the solids' bounds.
    const c = gap?.c ?? route.find((r) => {
      const p = center(r % nx, Math.floor(r / nx) % nz, 0);
      return p.x < b.minX || p.x > b.maxX || p.z < b.minZ || p.z > b.maxZ;
    }) ?? run.escape;
    const i = c % nx;
    const k = Math.floor(c / nx) % nz;
    const j = Math.floor(c / (nx * nz));
    // Its height range: the whole opening in that column, the air between the solids below and above it.
    let [lo, hi] = [j, j];
    while (lo > 0 && !solidAt(i, k, lo - 1)) lo--;
    while (hi < ny - 1 && !solidAt(i, k, hi + 1)) hi++;
    const at = center(i, k, j);
    const between = [...new Set((gap?.sides ?? []).filter((o) => o > 0).map((o) => sightOwner(solids[o - 1].id)))];
    gaps.push({
      at: { x: round2(at.x), y: round2(at.y), z: round2(at.z) },
      y: [round2(band[0] + lo * cell), round2(band[0] + (hi + 1) * cell)],
      width: round2((gap?.width ?? Infinity) * cell),
      between,
    });
    // Plug it (as wide as it is, over its height) and look for the next.
    const r = Math.ceil((gap?.width ?? 2) / 2) + 1;
    for (let a = i - r; a <= i + r; a++) {
      for (let d = k - r; d <= k + r; d++) {
        if (a < 0 || d < 0 || a >= nx || d >= nz) continue;
        for (let h = lo; h <= hi; h++) plugged[idx(a, d, h)] = 1;
      }
    }
  }
  // One gap between the same two solids is one gap, whatever heights it was found at.
  const merged: Gap[] = [];
  for (const g of gaps) {
    const same = merged.find((m) => m.between.join() === g.between.join() && g.between.length === 2 && Math.hypot(m.at.x - g.at.x, m.at.z - g.at.z) < Math.max(m.width, g.width, cell) * 2);
    if (same) same.y = [Math.min(same.y[0], g.y[0]), Math.max(same.y[1], g.y[1])];
    else merged.push(g);
  }
  return { sealed: false, cell, band, escapes: merged.map((g) => (Number.isFinite(g.width) ? g : { ...g, width: -1 })), ...(more ? { more: true } : {}), ...(note ? { note } : {}) };
}

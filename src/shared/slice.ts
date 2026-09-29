import { expandNodes } from "./entities";
import { isSolid, round2, toWorld3 } from "./geometry";
import { isHole } from "./holes";
import { shapeMesh, type Mesh } from "./mesh";
import type { ClosedShape, SceneNode, Shape, Solid } from "./scene.types";
import { sightOwner } from "./sight";
import { hiddenIds } from "./tree";

/**
 * Horizontal sections (plan 14 §10, `render_view` plan with `slice`): each solid cut by the plane at a height, as
 * outlines on the ground, and where two solids' outlines come close without touching: the gaps a level leaks
 * through at that height (a ring of peaks that overlaps at its base and not at 110 m). Pure, over the scene's
 * expanded shapes; holes are cut too, and drawn dashed.
 */

type P = { x: number; z: number };
export type SectionOutline = { owner: string; hole: boolean; loops: P[][] };
export type SliceGap = { between: [string, string]; width: number; at: P };
export type Section = { y: number; outlines: SectionOutline[]; gaps: SliceGap[] };

/** A solid's closed meshes in the world (as the enclosure check reads them). */
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

/** Where a mesh's triangles cross the plane at height y: segments on the ground. */
function cutMesh(m: Mesh, y: number): [P, P][] {
  const p = m.positions;
  const segs: [P, P][] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const v = [m.indices[t], m.indices[t + 1], m.indices[t + 2]].map((i) => ({ x: p[i * 3], y: p[i * 3 + 1] - y, z: p[i * 3 + 2] }));
    const pts: P[] = [];
    for (let e = 0; e < 3; e++) {
      const [a, b] = [v[e], v[(e + 1) % 3]];
      if ((a.y < 0) === (b.y < 0)) continue;
      const u = a.y / (a.y - b.y);
      pts.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
    }
    if (pts.length === 2) segs.push([pts[0], pts[1]]);
  }
  return segs;
}

/** Segments joined end to end into loops (or open runs). */
function chain(segs: [P, P][]): P[][] {
  const key = (q: P) => `${Math.round(q.x * 1e4)},${Math.round(q.z * 1e4)}`;
  const at = new Map<string, number[]>();
  segs.forEach(([a, b], i) => {
    for (const q of [a, b]) at.set(key(q), [...(at.get(key(q)) ?? []), i]);
  });
  const used = new Set<number>();
  const loops: P[][] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used.has(s)) continue;
    used.add(s);
    const loop = [segs[s][0], segs[s][1]];
    for (;;) {
      const end = loop[loop.length - 1];
      const next = (at.get(key(end)) ?? []).find((i) => !used.has(i));
      if (next === undefined) break;
      used.add(next);
      const [a, b] = segs[next];
      loop.push(key(a) === key(end) ? b : a);
    }
    loops.push(loop);
  }
  return loops;
}

const dist2 = (a: P, b: P) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
/** The closest points between two segments (on the ground), and their distance. */
function segDistance(a: P, b: P, c: P, d: P): { d: number; p: P; q: P } {
  const closest = (p: P, s0: P, s1: P) => {
    const dx = s1.x - s0.x, dz = s1.z - s0.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s0.x) * dx + (p.z - s0.z) * dz) / l2));
    return { x: s0.x + dx * t, z: s0.z + dz * t };
  };
  const cands = [
    { p: a, q: closest(a, c, d) },
    { p: b, q: closest(b, c, d) },
    { p: closest(c, a, b), q: c },
    { p: closest(d, a, b), q: d },
  ];
  let best = cands[0];
  for (const k of cands) if (dist2(k.p, k.q) < dist2(best.p, best.q)) best = k;
  return { d: Math.sqrt(dist2(best.p, best.q)), ...best };
}
const crosses = (a: P, b: P, c: P, d: P) => {
  const o = (p: P, q: P, r: P) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
};
function inside(loops: P[][], p: P): boolean {
  let n = 0;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [a, b] = [loop[i], loop[j]];
      if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) n++;
    }
  }
  return n % 2 === 1;
}

/** The sections of the visible solids (and holes) at height y, each outline by its owner (an item as array_3/7). */
export function sectionAt(nodes: SceneNode[], y: number, opts: { ignore?: string[]; hide?: string[]; gap?: number } = {}): Section {
  const expanded = expandNodes(nodes);
  const hidden = hiddenIds(expanded);
  const skip = new Set([...(opts.ignore ?? []), ...(opts.hide ?? [])]);
  const left = (id: string) => hidden.has(id) || skip.has(id) || skip.has(sightOwner(id)) || skip.has(id.split("/")[0]);
  const shapes = expanded.filter((n): n is Solid => n.type !== "group" && isSolid(n as Shape) && !left(n.id));
  const byOwner = new Map<string, { hole: boolean; segs: [P, P][] }>();
  const yy = y + 1e-6;
  for (const s of shapes) {
    const hole = isHole(s as ClosedShape);
    const owner = `${hole ? "hole:" : ""}${sightOwner(s.id)}`;
    const segs = worldMeshes(s).flatMap((m) => cutMesh(m, yy));
    if (segs.length === 0) continue;
    const entry = byOwner.get(owner) ?? { hole, segs: [] };
    entry.segs.push(...segs);
    byOwner.set(owner, entry);
  }
  const outlines: SectionOutline[] = [...byOwner].map(([owner, e]) => ({ owner: owner.replace(/^hole:/, ""), hole: e.hole, loops: chain(e.segs) }));
  return { y, outlines, gaps: gapsBetween(outlines.filter((o) => !o.hole), opts.gap ?? 2) };
}

/** Pairs of solids' outlines that come within `max` meters of each other without touching or overlapping. */
export function gapsBetween(outlines: SectionOutline[], max: number): SliceGap[] {
  const boxes = outlines.map((o) => {
    const pts = o.loops.flat();
    return { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minZ: Math.min(...pts.map((p) => p.z)), maxZ: Math.max(...pts.map((p) => p.z)) };
  });
  const gaps: SliceGap[] = [];
  for (let i = 0; i < outlines.length; i++) {
    for (let j = i + 1; j < outlines.length; j++) {
      const [A, B] = [boxes[i], boxes[j]];
      if (A.minX - max > B.maxX || B.minX - max > A.maxX || A.minZ - max > B.maxZ || B.minZ - max > A.maxZ) continue;
      const a = outlines[i].loops;
      const b = outlines[j].loops;
      // Touching or overlapping is sealed there.
      if (inside(a, b[0][0]) || inside(b, a[0][0])) continue;
      let best: { d: number; p: P; q: P } | null = null;
      let touch = false;
      for (const la of a) {
        for (let s = 0; s + 1 < la.length && !touch; s++) {
          for (const lb of b) {
            for (let t = 0; t + 1 < lb.length; t++) {
              if (crosses(la[s], la[s + 1], lb[t], lb[t + 1])) {
                touch = true;
                break;
              }
              const d = segDistance(la[s], la[s + 1], lb[t], lb[t + 1]);
              if (!best || d.d < best.d) best = d;
            }
            if (touch) break;
          }
        }
      }
      if (touch || !best || best.d > max || best.d < 1e-3) continue;
      gaps.push({ between: [outlines[i].owner, outlines[j].owner], width: round2(best.d), at: { x: round2((best.p.x + best.q.x) / 2), z: round2((best.p.z + best.q.z) / 2) } });
    }
  }
  return gaps.sort((p, q) => p.width - q.width);
}

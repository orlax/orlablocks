import { expandNodes } from "./entities";
import { boundsOf, isSolid, polyline, rampStations, round2 } from "./geometry";
import { isHole } from "./holes";
import { hitMesh, type BoundedMesh } from "./mesh";
import { rayMeshAll } from "./ray";
import type { SceneNode, Shape, Solid } from "./scene.types";
import { sightOwner } from "./sight";
import { hiddenIds } from "./tree";

/**
 * Measuring a path (plan 14 §11, `measure_path`): a line's, a through line's or a ramp's length, time at a speed,
 * slopes and climb rates, where they break the limits given, and the clearance to the solids around it, sampled
 * along it. The limits are per call (the game's facts as data are a later phase).
 */

type V = { x: number; y: number; z: number };
export type MeasureInput = {
  speed?: number;
  climbRate?: number;
  sinkRate?: number;
  maxSlope?: number;
  probe?: number;
  maxY?: number;
  ignore?: string[];
};
type Where = { along: number; at: V };
type Stretch = { from: Where; to: Where; worst: number };

const r2 = (p: V): V => ({ x: round2(p.x), y: round2(p.y), z: round2(p.z) });

/** Points every `step` meters along a 3D polyline, with the distance along at each. */
function resample(points: V[], step: number): { p: V; s: number }[] {
  const out: { p: V; s: number }[] = [{ p: points[0], s: 0 }];
  let s = 0;
  let carry = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    let t = step - carry;
    while (t <= len) {
      const u = t / len;
      out.push({ p: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }, s: s + t });
      t += step;
    }
    carry = (carry + len) % step;
    s += len;
  }
  if (out[out.length - 1].s < s - 1e-6) out.push({ p: points[points.length - 1], s });
  return out;
}

/** The distance from a point to a triangle. */
function pointTriangle(p: V, a: V, b: V, c: V): number {
  // Ericson, Real-Time Collision Detection 5.1.5: the closest point on the triangle.
  const sub = (u: V, v: V) => ({ x: u.x - v.x, y: u.y - v.y, z: u.z - v.z });
  const dot = (u: V, v: V) => u.x * v.x + u.y * v.y + u.z * v.z;
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (q: V) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at({ x: a.x + ab.x * v, y: a.y + ab.y * v, z: a.z + ab.z * v });
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at({ x: a.x + ac.x * w, y: a.y + ac.y * w, z: a.z + ac.z * w });
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at({ x: b.x + (c.x - b.x) * w, y: b.y + (c.y - b.y) * w, z: b.z + (c.z - b.z) * w });
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return at({ x: a.x + ab.x * v + ac.x * w, y: a.y + ab.y * v + ac.y * w, z: a.z + ab.z * v + ac.z * w });
}

/** The distance from a point to a mesh's surface (0 when it's inside the mesh), within `max` (else Infinity). */
function meshDistance(p: V, m: BoundedMesh, max: number): number {
  if (p.x < m.min[0] - max || p.x > m.max[0] + max || p.y < m.min[1] - max || p.y > m.max[1] + max || p.z < m.min[2] - max || p.z > m.max[2] + max) return Infinity;
  // Inside: an odd number of crossings straight up.
  if (rayMeshAll({ origin: { x: p.x + 1.3e-4, y: p.y, z: p.z + 2.1e-4 }, dir: { x: 0, y: 1, z: 0 } }, m).length % 2 === 1) return 0;
  let best = Infinity;
  const q = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
    best = Math.min(best, pointTriangle(p, { x: q[a], y: q[a + 1], z: q[a + 2] }, { x: q[b], y: q[b + 1], z: q[b + 2] }, { x: q[c], y: q[c + 1], z: q[c + 2] }));
  }
  return best;
}

/** Runs of consecutive samples where `bad` holds, as stretches with the worst value in each. */
function stretches(samples: { p: V; s: number }[], values: (number | null)[], bad: (v: number) => boolean, worse: (a: number, b: number) => boolean): Stretch[] {
  const out: Stretch[] = [];
  let open: Stretch | null = null;
  values.forEach((v, i) => {
    const hit = v !== null && bad(v);
    const where = { along: round2(samples[i].s), at: r2(samples[i].p) };
    if (hit && !open) open = { from: where, to: where, worst: v! };
    else if (hit && open) {
      open.to = where;
      if (worse(v!, open.worst)) open.worst = v!;
    } else if (!hit && open) {
      out.push(open);
      open = null;
    }
  });
  if (open) out.push(open);
  return out.map((s) => ({ ...s, worst: round2(s.worst) }));
}

export function measurePath(nodes: SceneNode[], id: string, input: MeasureInput) {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`id: no node "${id}"`);
  let points: V[];
  if (node.type === "line") points = polyline(node);
  else if (node.type === "ramp") points = rampStations(node).map((s) => ({ x: s.x, y: s.y, z: s.z }));
  else throw new Error(`id: "${id}" is a ${node.type}; measure a line (a route, a through line) or a ramp`);
  const length = points.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - points[i].x, p.y - points[i].y, p.z - points[i].z), 0);
  if (length < 1e-6) throw new Error(`id: "${id}" has no length`);
  const step = Math.max(0.25, Math.min(input.probe ? input.probe / 2 : 1, length / 400));
  const samples = resample(points, step);

  // Slopes (rise over run on the ground) and climb rates (m/s at the speed), segment by segment, at each sample's end.
  const slopes: (number | null)[] = [null];
  const rates: (number | null)[] = [null];
  for (let i = 1; i < samples.length; i++) {
    const [a, b] = [samples[i - 1].p, samples[i].p];
    const run = Math.hypot(b.x - a.x, b.z - a.z);
    const len = samples[i].s - samples[i - 1].s;
    slopes.push(run > 1e-6 ? (Math.atan2(b.y - a.y, run) * 180) / Math.PI : b.y > a.y ? 90 : -90);
    rates.push(input.speed && len > 0 ? ((b.y - a.y) / len) * input.speed : null);
  }
  const extreme = (values: (number | null)[], pick: (a: number, b: number) => boolean) => {
    let best: { v: number; i: number } | null = null;
    values.forEach((v, i) => {
      if (v !== null && (!best || pick(v, best.v))) best = { v, i };
    });
    const b = best as { v: number; i: number } | null;
    return b ? { value: round2(b.v), along: round2(samples[b.i].s), at: r2(samples[b.i].p) } : null;
  };
  const ys = samples.map((s) => s.p.y);
  const result: Record<string, unknown> = {
    length: round2(length),
    ...(input.speed ? { time: round2(length / input.speed) } : {}),
    height: [round2(Math.min(...ys)), round2(Math.max(...ys))],
    steepestClimb: extreme(slopes, (a, b) => a > b),
    steepestDescent: extreme(slopes, (a, b) => a < b),
  };
  if (input.speed) {
    result.fastestClimb = extreme(rates, (a, b) => a > b);
    result.fastestSink = extreme(rates, (a, b) => a < b);
  }
  if (input.climbRate !== undefined && input.speed) result.overClimbRate = stretches(samples, rates, (v) => v > input.climbRate!, (a, b) => a > b);
  if (input.sinkRate !== undefined && input.speed) result.overSinkRate = stretches(samples, rates, (v) => -v > input.sinkRate!, (a, b) => a < b);
  if (input.maxSlope !== undefined) result.overSlope = stretches(samples, slopes, (v) => Math.abs(v) > input.maxSlope!, (a, b) => Math.abs(a) > Math.abs(b));
  if (input.maxY !== undefined) result.aboveMaxY = stretches(samples, ys, (v) => v > input.maxY!, (a, b) => a > b);

  if (input.probe) {
    // The clearance: the nearest solid's surface to each sample (not the path's own ramp, nor what's ignored).
    const expanded = expandNodes(nodes);
    const hidden = hiddenIds(expanded);
    const skip = new Set([id, ...(input.ignore ?? [])]);
    const solids = expanded.filter(
      (n): n is Solid =>
        n.type !== "group" && isSolid(n as Shape) && !isHole(n) && !hidden.has(n.id) && !skip.has(n.id) && !skip.has(sightOwner(n.id)) && !skip.has(n.id.split("/")[0]),
    );
    const meshes = solids.flatMap((s) => {
      const m = hitMesh(s);
      return m ? [{ owner: sightOwner(s.id), m }] : [];
    });
    const b = solids.length > 0 ? boundsOf(solids) : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    const reach = input.probe * 3;
    const clear: (number | null)[] = [];
    const against: (string | null)[] = [];
    for (const { p } of samples) {
      let best = Infinity;
      let who: string | null = null;
      if (solids.length > 0 && p.x > b.minX - reach && p.x < b.maxX + reach && p.z > b.minZ - reach && p.z < b.maxZ + reach) {
        for (const { owner, m } of meshes) {
          const d = meshDistance(p, m, Math.min(best, reach));
          if (d < best) [best, who] = [d, owner];
        }
      }
      clear.push(Number.isFinite(best) ? best : null);
      against.push(who);
    }
    let tight: { i: number; v: number } | null = null;
    clear.forEach((v, i) => {
      if (v !== null && (!tight || v < tight.v)) tight = { i, v };
    });
    const t = tight as { i: number; v: number } | null;
    result.clearance = t
      ? { tightest: round2(t.v), along: round2(samples[t.i].s), at: r2(samples[t.i].p), against: against[t.i], ...(t.v === 0 ? { inside: true } : {}) }
      : `nothing within ${round2(reach)} m of the path`;
    // Each stretch closer than the probe, with what it's close to where it starts.
    result.underProbe = stretches(samples, clear, (v) => v < input.probe!, (a, b) => a < b).map((st) => {
      const i = samples.findIndex((x) => round2(x.s) === st.from.along);
      return { ...st, against: i >= 0 ? against[i] : null };
    });
  }
  return result;
}

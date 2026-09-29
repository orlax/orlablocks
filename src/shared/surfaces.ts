import { arrayLayout } from "./arrays";
import { arrayItemInstance, arrayShapes, expandShapes, instanceShapes } from "./entities";
import { boundsOf, rampStations, round2, roundPoints } from "./geometry";
import { surfaceUnder, type Vec3 } from "./ray";
import { DEFAULT_APEX, type ArrayNode, type Instance, type LinePoint, type SceneNode, type Shape, type StandPose, type Through } from "./scene.types";
import { isGroup, shapesUnder } from "./tree";

/**
 * Walking surfaces (plan 13 §7): where a player stands on a node, so things can stand ON other things and lines can
 * go THROUGH nodes, both kept up to date as the level changes. Pure, over the scene's nodes.
 */

/** The item an ID names (`array_3/5`), as an instance, or undefined when it names no item. */
function itemOf(byId: Map<string, SceneNode>, id: string): Instance | undefined {
  const m = /^(.+)\/(\d+)$/.exec(id);
  const array = m && byId.get(m[1]);
  return array?.type === "array" ? arrayItemInstance(array, Number(m![2])) : undefined;
}

/** The solid shapes a node stands for, in world space: its own, an instance's, an array's, an item's or a group's. */
function solidsOf(byId: Map<string, SceneNode>, nodes: SceneNode[], id: string): Shape[] | undefined {
  const item = itemOf(byId, id);
  if (item) return instanceShapes(item);
  const n = byId.get(id);
  if (!n) return undefined;
  if (isGroup(n)) return expandShapes(shapesUnder(nodes, [id]));
  if (n.type === "instance") return instanceShapes(n);
  if (n.type === "array") return arrayShapes(n);
  return [n];
}

/**
 * The height of the walking surface at (x, z) over these shapes: the highest flat top, floor or wall top under the
 * point (holes, lines and slopes don't count), or a ramp's surface where the point is on it; null over none.
 */
export function surfaceAt(shapes: Shape[], x: number, z: number): number | null {
  let best = surfaceUnder({ origin: { x, y: 1e5, z }, dir: { x: 0, y: -1, z: 0 } }, shapes)?.y ?? null;
  for (const s of shapes) {
    if (s.type !== "ramp") continue;
    let near: { d: number; y: number } | null = null;
    for (const st of rampStations(s)) {
      const d = Math.hypot(st.x - x, st.z - z);
      if (!near || d < near.d) near = { d, y: st.y };
    }
    if (near && near.d <= s.width / 2 && (best === null || near.y > best)) best = near.y;
  }
  return best;
}

/**
 * Where one stands on a node: the center of its walking surface (plan 13 §7), a through line's stop. A shape's or
 * group's is over the middle of its bounds, an instance's or item's over its pivot, a ramp's halfway along it, a
 * note's its point; lines and whole arrays have none (an array's items do). Null for none, or an unknown ID.
 */
export function topOf(nodes: SceneNode[], id: string, byId = new Map(nodes.map((n) => [n.id, n]))): Vec3 | null {
  const n = byId.get(id);
  if (n?.type === "note") return { x: n.x, y: n.y, z: n.z };
  if (n?.type === "line" || n?.type === "array") return null;
  if (n?.type === "ramp") {
    // Halfway along, between the stations either side of it.
    const stations = rampStations(n);
    if (stations.length === 0) return null;
    const half = (stations.at(-1)!.s ?? 0) / 2;
    const k = Math.max(0, stations.findIndex((st) => st.s >= half) - 1);
    const [a, b] = [stations[k], stations[Math.min(k + 1, stations.length - 1)]];
    const u = b.s > a.s ? (half - a.s) / (b.s - a.s) : 0;
    return { x: round2(a.x + (b.x - a.x) * u), y: round2(a.y + (b.y - a.y) * u), z: round2(a.z + (b.z - a.z) * u) };
  }
  const solids = solidsOf(byId, nodes, id);
  if (!solids || solids.length === 0) return null;
  const pivot = n?.type === "instance" ? n : itemOf(byId, id);
  const b = boundsOf(solids);
  const x = pivot ? pivot.x : (b.minX + b.maxX) / 2;
  const z = pivot ? pivot.z : (b.minZ + b.maxZ) / 2;
  return { x: round2(x), y: round2(surfaceAt(solids, x, z) ?? b.maxY), z: round2(z) };
}

/** Why a node can't be stood on (for `on`), or null. */
export function standProblem(nodes: SceneNode[], id: string, self: string): string | null {
  const n = nodes.find((m) => m.id === id);
  if (!n) return `no node "${id}"`;
  if (id === self) return "a node can't stand on itself";
  if (n.type === "line" || n.type === "note") return `"${id}" is a ${n.type}: nothing stands on it`;
  if ((n.type === "instance" || n.type === "array") && n.on?.id === self) return `"${id}" stands on ${self} already`;
  return null;
}

/** How high an instance stands on what it's `on`: the surface under its pivot, else the top of that node. */
export function standHeight(nodes: SceneNode[], inst: Instance): number | null {
  if (!inst.on) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const solids = solidsOf(byId, nodes, inst.on.id);
  if (!solids || solids.length === 0) return null;
  return round2(surfaceAt(solids, inst.x, inst.z) ?? topOf(nodes, inst.on.id, byId)?.y ?? boundsOf(solids).maxY);
}

/**
 * Where an array's items stand on what it's `on` (plan 13 §7), by layout index. On another array, item i stands on
 * that array's item i: at its place, turned as it is, on its top (so flame jets stay on their slabs whatever the
 * ring does); on anything else, each item where its layout puts it, on the surface under it. Null where there's
 * nothing to stand on (the item stays where its layout puts it).
 */
export function standPoses(nodes: SceneNode[], array: ArrayNode): (StandPose | null)[] {
  if (!array.on) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const target = byId.get(array.on.id);
  const { items } = arrayLayout({ ...array, stand: undefined });
  const poses: (StandPose | null)[] = [];
  const solids = target && target.type !== "array" ? solidsOf(byId, nodes, target.id) : undefined;
  for (const item of items) {
    let pose: StandPose | null = null;
    if (target?.type === "array") {
      const under = arrayItemInstance(target, item.index);
      const shapes = under ? instanceShapes(under) : [];
      if (under && shapes.length > 0) {
        const y = surfaceAt(shapes, under.x, under.z) ?? boundsOf(shapes).maxY;
        pose = { x: under.x, y: round2(y), z: under.z, rotation: under.rotation };
      }
    } else if (solids) {
      const y = surfaceAt(solids, item.x, item.z);
      if (y !== null) pose = { x: item.x, y: round2(y), z: item.z };
    }
    poses[item.index] = pose;
  }
  return Array.from(poses, (p) => p ?? null);
}

/**
 * A through line's stops as item and node IDs, in order: `array_3/*` is every item of array_3, `array_3/2..6` the
 * items 2 to 6 it has (skipped ones left out). `problems` names the stops that are nothing.
 */
export function expandStops(nodes: SceneNode[], stops: string[]): { ids: string[]; problems: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids: string[] = [];
  const problems: string[] = [];
  for (const stop of stops) {
    const m = /^(.+)\/(\*|(\d+)\.\.(\d+))$/.exec(stop);
    if (m) {
      const array = byId.get(m[1]);
      if (array?.type !== "array") {
        problems.push(`${stop}: no array "${m[1]}"`);
        continue;
      }
      const [lo, hi] = m[2] === "*" ? [0, Infinity] : [Number(m[3]), Number(m[4])];
      for (const item of arrayLayout(array).items) if (item.index >= lo && item.index <= hi) ids.push(`${array.id}/${item.index}`);
      continue;
    }
    const n = byId.get(stop);
    if (n?.type === "array") problems.push(`${stop}: an array isn't a stop; its items are (${stop}/* for all of them)`);
    else if (n?.type === "line") problems.push(`${stop}: a line isn't a stop`);
    else if (!n && !itemOf(byId, stop)) problems.push(`${stop}: no such node or item`);
    else ids.push(stop);
  }
  return { ids, problems };
}

/**
 * A through line's points (plan 13 §7): the stops' tops, joined straight, or with `style: "jumps"` by one arc per
 * hop, peaking `apex` m above the higher stop, its handles a third of the way along the hop.
 */
export function throughPoints(nodes: SceneNode[], through: Through): { points: LinePoint[]; problems: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { ids, problems } = expandStops(nodes, through.stops);
  const tops = ids.flatMap((id) => {
    const top = topOf(nodes, id, byId);
    if (!top) problems.push(`${id}: nothing to stand on`);
    return top ? [top] : [];
  });
  if (through.style === "straight") return { points: roundPoints(tops.map((p) => ({ ...p }))), problems };
  const apex = through.apex ?? DEFAULT_APEX;
  const points: LinePoint[] = tops.map((p) => ({ ...p }));
  for (let k = 0; k + 1 < tops.length; k++) {
    const a = tops[k];
    const b = tops[k + 1];
    // A cubic whose two handles sit at height h peaks at (a.y + b.y) / 8 + 3h / 4: solve for the peak wanted.
    const peak = Math.max(a.y, b.y) + apex;
    const h = (peak - (a.y + b.y) / 8) / 0.75;
    const dx = (b.x - a.x) / 3;
    const dz = (b.z - a.z) / 3;
    points[k].out = { x: dx, y: h - a.y, z: dz };
    points[k + 1].in = { x: -dx, y: h - b.y, z: -dz };
  }
  return { points: roundPoints(points), problems };
}

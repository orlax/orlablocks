import { expandNodes } from "./entities";
import { boundsOf, isSolid, localFootprint, pointInPolygon, round2, toLocal3 } from "./geometry";
import { cutters, isHole } from "./holes";
import { hitMesh } from "./mesh";
import { rayMeshAll, type Vec3 } from "./ray";
import type { ClosedShape, SceneNode, Shape, Solid } from "./scene.types";
import { hiddenIds, subtreeIds } from "./tree";

/**
 * Sight checks (plan 13 §8): how much of a target is visible from an eye, and what blocks it, in text, with rays
 * cast over the scene's solids on the server. The server has no cut meshes, so a hit counts as passing when it's
 * inside a hole that cuts that shape: exact for walls cut by holes that go through them.
 */

export type SightPair = { from: string; to: string; visible: number; blockers: string[] };

/** What an expanded shape's ID stands for to the agent: `instance_4/box_2` is instance_4, `array_3/7/box_2` array_3/7. */
export function sightOwner(id: string): string {
  const parts = id.split("/");
  return parts[0].startsWith("array_") && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Whether an expanded shape belongs to one of these IDs (a node, what's in a group, an instance's or array's shapes, an item's). */
const within = (id: string, owners: Set<string>) => owners.has(id) || owners.has(sightOwner(id)) || owners.has(id.split("/")[0]);

/** Whether a world point is inside a hole's volume (its footprint, from its bottom to its top, tilt and turn included). */
function insideHole(hole: ClosedShape, p: Vec3): boolean {
  const l = toLocal3(hole, p);
  if (l.y < -1e-6 || l.y > hole.height + 1e-6) return false;
  return pointInPolygon(localFootprint(hole), l);
}

/** About 15 points over a box: its corners, faces' centers and center, pulled a tenth of the way in (no grazing edges). */
function samplesOf(shapes: Shape[]): Vec3[] {
  const b = boundsOf(shapes);
  const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
  const h = { x: ((b.maxX - b.minX) / 2) * 0.9, y: ((b.maxY - b.minY) / 2) * 0.9, z: ((b.maxZ - b.minZ) / 2) * 0.9 };
  const points: Vec3[] = [c];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) points.push({ x: c.x + sx * h.x, y: c.y + sy * h.y, z: c.z + sz * h.z });
  for (const [k, s] of [["x", -1], ["x", 1], ["y", -1], ["y", 1], ["z", -1], ["z", 1]] as const) points.push({ ...c, [k]: c[k] + s * h[k] });
  return points;
}

/**
 * From each eye to each target, the fraction of its sample points in sight and everything that blocks the others,
 * nearest first (a column, then the wall behind it: taking the first away shows the next at once). Hidden nodes and `ignore` (with what's in them: light shafts, decor) are left out; the target's own shapes
 * never block it. Errors (as thrown messages) for targets that are nothing.
 */
export function checkSight(nodes: SceneNode[], eyes: { label: string; eye: Vec3 }[], targets: string[], ignore: string[] = []): SightPair[] {
  const expanded = expandNodes(nodes);
  const hidden = hiddenIds(expanded);
  const skipped = new Set<string>();
  for (const id of ignore) for (const d of subtreeIds(expanded, id)) skipped.add(d);
  ignore.forEach((id) => skipped.add(id));
  const visibleNodes = expanded.filter((n) => !hidden.has(n.id) && !within(n.id, skipped));
  const solids = visibleNodes.filter((n): n is Solid => n.type !== "group" && isSolid(n as Shape) && !isHole(n));
  const cuts = cutters(visibleNodes);

  return eyes.flatMap(({ label, eye }) =>
    targets.map((target) => {
      const inTarget = new Set([target, ...subtreeIds(expanded, target)]);
      const own = expanded.filter((n): n is Shape => n.type !== "group" && isSolid(n as Shape) && !isHole(n) && within(n.id, inTarget));
      if (own.length === 0) throw new Error(`to: "${target}" has nothing to see (no such node or item, or no solid shapes)`);
      const samples = samplesOf(own);
      const nearest = new Map<string, number>();
      let seen = 0;
      for (const sample of samples) {
        const dir = { x: sample.x - eye.x, y: sample.y - eye.y, z: sample.z - eye.z };
        // Every blocker along the ray, not only the first: removing one shows what's behind it at once.
        let blocked = false;
        for (const s of solids) {
          if (within(s.id, inTarget)) continue;
          const mesh = hitMesh(s);
          if (!mesh) continue;
          for (const t of rayMeshAll({ origin: eye, dir }, mesh)) {
            if (t <= 1e-4 || t >= 1 - 1e-3) continue;
            const p = { x: eye.x + dir.x * t, y: eye.y + dir.y * t, z: eye.z + dir.z * t };
            if ((cuts.get(s.id) ?? []).some((hole) => insideHole(hole, p))) continue;
            const id = sightOwner(s.id);
            nearest.set(id, Math.min(nearest.get(id) ?? Infinity, t));
            blocked = true;
          }
        }
        if (!blocked) seen++;
      }
      const blockers = [...nearest].sort((a, b) => a[1] - b[1]).map(([id]) => id);
      return { from: label, to: target, visible: round2(seen / samples.length), blockers };
    }),
  );
}

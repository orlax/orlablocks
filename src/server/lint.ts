import { arrayLayout } from "../shared/arrays";
import { allDefinitions, arrayItemInstance, entityMiddle, expandShapes, instanceShapes } from "../shared/entities";
import { boundsOf, isSolid, round2 } from "../shared/geometry";
import { holeWarnings, isHole } from "../shared/holes";
import { surfaceUnder } from "../shared/ray";
import type { Instance, SceneNode, Shape } from "../shared/scene.types";
import { isGroup, isShape, subtreeIds } from "../shared/tree";

/**
 * The lint pass (plan 14 §11, `check_scene`): likely mistakes, each with the ID to fix, nothing changed. The checks:
 * things floating over nothing, notes that name what's gone, entities built off their pivot, holes that cut
 * nothing, and the same node twice in the same place.
 */

export const LINT_CHECKS = ["floating", "stale_notes", "off_center", "holes", "duplicates"] as const;
export type LintCheck = (typeof LINT_CHECKS)[number];
export type Finding = { check: LintCheck; id: string; message: string; at?: { x: number; y: number; z: number } };

/** How far above what's under it something may float before it's flagged. */
export const FLOAT_TOLERANCE = 0.5;
/** At most this many findings per check, then a count. */
const MAX_PER_CHECK = 25;

const ID_PATTERN = /\b(box|cylinder|freeform|line|ramp|note|instance|array|group)_\d+(?:\/\d+)?\b/g;

export function lintScene(nodes: SceneNode[], opts: { root?: string; checks?: LintCheck[]; floats?: string[] } = {}): { findings: Finding[]; more?: Record<string, number> } {
  const checks = new Set(opts.checks ?? LINT_CHECKS);
  const inRoot = opts.root !== undefined ? subtreeIds(nodes, opts.root) : null;
  const scoped = inRoot ? nodes.filter((n) => inRoot.has(n.id)) : nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const findings: Finding[] = [];
  const more: Record<string, number> = {};
  const add = (f: Finding) => {
    if (findings.filter((g) => g.check === f.check).length >= MAX_PER_CHECK) more[f.check] = (more[f.check] ?? 0) + 1;
    else findings.push(f);
  };
  const allowed = new Set(opts.floats ?? []);

  if (checks.has("floating")) {
    const solids = expandShapes(nodes.filter(isShape)).filter((s) => isSolid(s) && !isHole(s));
    /** How far a thing's bottom is above the highest surface under a point (the ground at worst), leaving its own shapes out. */
    const gapUnder = (own: Shape[], x: number, z: number) => {
      const ids = new Set(own.map((s) => s.id));
      const bottom = boundsOf(own).minY;
      const under = surfaceUnder({ origin: { x, y: bottom + 0.01, z }, dir: { x: 0, y: -1, z: 0 } }, solids.filter((s) => !ids.has(s.id)), { slopes: true });
      return { bottom, gap: bottom - Math.max(under?.y ?? 0, bottom < 0 ? bottom : 0), support: under?.y ?? 0 };
    };
    for (const n of scoped) {
      if (allowed.has(n.id)) continue;
      if (n.type === "instance" && !n.on) {
        const shapes = instanceShapes(n);
        if (shapes.length === 0) continue;
        const g = gapUnder(shapes, n.x, n.z);
        if (g.gap > FLOAT_TOLERANCE) add({ check: "floating", id: n.id, message: `${n.id} (${n.entity}) floats ${round2(g.gap)} m above what's under it (its bottom at y ${round2(g.bottom)}, the surface at ${round2(g.support)}): a typo in y, or stand it on something (on)`, at: { x: n.x, y: n.y, z: n.z } });
      }
      if (n.type === "array" && !n.on) {
        const floating: { id: string; gap: number }[] = [];
        for (const item of arrayLayout(n).items) {
          const inst = arrayItemInstance(n, item.index) as Instance;
          const shapes = instanceShapes(inst);
          if (shapes.length === 0) continue;
          const g = gapUnder(shapes, item.x, item.z);
          if (g.gap > FLOAT_TOLERANCE) floating.push({ id: `${n.id}/${item.index}`, gap: round2(g.gap) });
        }
        const total = arrayLayout(n).items.length;
        // Every item floating is a layout of platforms on purpose; some of them floating is likely a mistake.
        if (floating.length > 0 && floating.length < total) {
          add({ check: "floating", id: n.id, message: `${floating.length} of ${n.id}'s ${total} items float over nothing (${floating.slice(0, 5).map((f) => `${f.id} by ${f.gap} m`).join(", ")}${floating.length > 5 ? ", …" : ""}): stand it on the surface (on), or skip them` });
        }
      }
    }
  }

  if (checks.has("stale_notes")) {
    for (const n of scoped) {
      if (n.type !== "note" || n.status !== "open") continue;
      for (const [ref] of n.text.matchAll(ID_PATTERN)) {
        const [head, index] = ref.split("/");
        const target = byId.get(head);
        if (!target) add({ check: "stale_notes", id: n.id, message: `${n.id} names ${ref}, which is gone: rewrite the note, or mark it done`, at: { x: n.x, y: n.y, z: n.z } });
        else if (index !== undefined && target.type === "array" && !arrayLayout(target).items.some((i) => i.index === Number(index))) {
          add({ check: "stale_notes", id: n.id, message: `${n.id} names ${ref}, but ${head} has no item ${index} now (skipped, or fewer items)`, at: { x: n.x, y: n.y, z: n.z } });
        }
      }
    }
  }

  if (checks.has("off_center")) {
    const used = new Set(scoped.flatMap((n) => (n.type === "instance" ? [n.entity] : n.type === "array" ? n.entities.map((e) => e.entity) : [])));
    for (const [id, def] of Object.entries(allDefinitions())) {
      if (!used.has(id)) continue;
      const shapes = def.filter((n): n is Shape => !isGroup(n));
      if (shapes.length === 0) continue;
      const m = entityMiddle(shapes);
      const bottom = boundsOf(shapes).minY;
      if (Math.hypot(m.x, m.z) > 0.5) add({ check: "off_center", id, message: `the entity ${id} is built ${round2(Math.hypot(m.x, m.z))} m off its pivot (its middle at x ${round2(m.x)}, z ${round2(m.z)}): its instances sit that far off their point` });
      if (Math.abs(bottom) > 0.05) add({ check: "off_center", id, message: `the entity ${id}'s bottom is at y ${round2(bottom)}, not 0: its instances stand that far off their y` });
    }
  }

  if (checks.has("holes")) {
    for (const w of holeWarnings(nodes)) {
      const id = /^(\S+)/.exec(w)?.[1] ?? "";
      if (!inRoot || inRoot.has(id)) add({ check: "holes", id, message: w });
    }
  }

  if (checks.has("duplicates")) {
    // The same node twice: every field but its ID and who made it (a copy dropped in place, a batch sent twice).
    const seen = new Map<string, string>();
    for (const n of scoped) {
      if (isGroup(n)) continue;
      const { id: _id, createdBy: _by, name: _name, ...rest } = n as SceneNode & { name?: string };
      const key = JSON.stringify(rest);
      const first = seen.get(key);
      if (first !== undefined) {
        add({ check: "duplicates", id: n.id, message: `${n.id} is the same as ${first}, in the same place: remove one` });
      } else seen.set(key, n.id);
    }
  }
  return { findings, ...(Object.keys(more).length > 0 ? { more } : {}) };
}

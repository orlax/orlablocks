import { expandNodes, inEntityRoot, setDefinitions } from "../entities";
import { isSolid } from "../geometry";
import { holeScope, isHole } from "../holes";
import type { SceneNode } from "../scene.types";
import { legacyHoleScope } from "./legacyHoleScope";

const placement = (id: string) => id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : undefined;
const relations = (nodes: SceneNode[], legacy: boolean) => nodes.filter(isHole).map((h) => [h.id, (legacy ? legacyHoleScope : holeScope)(nodes, h).map((n) => n.id).sort()]);

/** Annotate exact eligible relationships, including non-overlapping targets. No geometry or IDs change. */
function annotate(authored: SceneNode[], expanded: SceneNode[], externalOnly: boolean, prefix: string): SceneNode[] {
  const tags = new Map<string, Set<string>>();
  const sets = new Map<string, string>();
  const add = (id: string, tag: string) => { if (!tags.has(id)) tags.set(id, new Set()); tags.get(id)!.add(tag); };
  for (const h of expanded.filter(isHole)) {
    const targets = legacyHoleScope(expanded, h).filter((t) => !externalOnly || !placement(h.id) || placement(h.id) !== placement(t.id));
    if (!targets.length) continue;
    const key = targets.map((t) => t.id).sort().join("\n");
    let tag = sets.get(key);
    if (!tag) { tag = `${prefix}.${sets.size + 1}`; sets.set(key, tag); }
    add(h.id, tag);
    targets.forEach((t) => add(t.id, tag!));
  }
  return authored.map((n) => {
    if (n.type === "instance" || n.type === "array") {
      const cutTagParts = Object.fromEntries([...tags].filter(([id]) => id.startsWith(`${n.id}/`)).map(([id, ts]) => [id.slice(n.id.length + 1), [...ts]]));
      return Object.keys(cutTagParts).length ? { ...n, cutTagParts } : n;
    }
    return n.type !== "group" && isSolid(n) && tags.has(n.id) ? { ...n, cutTags: [...tags.get(n.id)!] } : n;
  });
}

/** Convert a complete project together so definition-local cuts and scene bindings can be verified exactly. */
export function migrateProjectCuts(definitions: Record<string, SceneNode[]>, scenes: Record<string, SceneNode[]>, namespace = "project") {
  setDefinitions(definitions);
  const before = Object.fromEntries(Object.entries(scenes).map(([id, nodes]) => [id, expandNodes(nodes)]));
  const migratedDefinitions = Object.fromEntries(Object.entries(definitions).map(([id, nodes]) => {
    const expanded = inEntityRoot(nodes);
    const migrated = annotate(nodes, expanded, false, `migrated.${namespace}.e.${id}`);
    if (JSON.stringify(relations(expanded, true)) !== JSON.stringify(relations(inEntityRoot(migrated), false))) throw new Error(`Entity ${id}: cut relationships differ`);
    return [id, migrated];
  }));
  const migratedScenes = Object.fromEntries(Object.entries(scenes).map(([id, nodes]) => [id, annotate(nodes, before[id], true, `migrated.${namespace}.s.${id}`)]));
  setDefinitions(migratedDefinitions);
  for (const [id, nodes] of Object.entries(migratedScenes)) {
    const after = expandNodes(nodes);
    if (JSON.stringify(relations(before[id], true)) !== JSON.stringify(relations(after, false))) throw new Error(`Scene ${id}: cut relationships differ; nothing should be written`);
  }
  return { definitions: migratedDefinitions, scenes: migratedScenes };
}

import { ownerOf } from "../shared/entities";
import type { SceneNode } from "../shared/scene.types";
import { ancestry, selectableAt } from "../shared/tree";

/** Highlight the ordinary entity placement, but only the hit part of an array item. Never its owning group. */
export function hoverTarget(hit: string): string {
  return hit.startsWith("array_") ? hit : ownerOf(hit);
}

/** Explain click ownership independently of the localized visual highlight. */
export function hoverOwnerLabel(nodes: SceneNode[], outside: string | null, hit: string | null, context: string | null, pickingTarget: boolean): string | null {
  const owner = hit ? ownerOf(hit) : null;
  const id = outside ?? (owner ? pickingTarget ? owner : selectableAt(nodes, owner, context) ?? selectableAt(nodes, owner, null) ?? owner : null);
  if (!id) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return ancestry(nodes, id).reverse().map((key) => byId.get(key)?.name ?? key).join(" › ");
}

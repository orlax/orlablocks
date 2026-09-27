import { z } from "zod";
import { MAX_PASTE, NodeSchema, type SceneNode } from "../shared/scene.types";
import { subtreeIds } from "../shared/tree";

/**
 * The system clipboard format for copy, cut and paste: `{ "dungeonDesigner": "nodes", "nodes": [...] }` as plain
 * text, so it works across scenes, tabs and reloads. Anything else on the clipboard isn't ours and is ignored.
 */
const ClipboardSchema = z.object({
  dungeonDesigner: z.literal("nodes"),
  nodes: z.array(NodeSchema).min(1).max(MAX_PASTE),
});

/** The clipboard text for the selected nodes: each with its whole subtree, in list order. */
export function clipboardText(nodes: SceneNode[], ids: string[]): string {
  const all = new Set(ids.flatMap((id) => [...subtreeIds(nodes, id)]));
  return JSON.stringify({ dungeonDesigner: "nodes", nodes: nodes.filter((n) => all.has(n.id)) });
}

/** Our nodes from clipboard text, or null for anything else (other text, other JSON, invalid nodes). */
export function readClipboard(text: string | undefined): SceneNode[] | null {
  if (!text) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ClipboardSchema.safeParse(data);
  return parsed.success ? parsed.data.nodes : null;
}

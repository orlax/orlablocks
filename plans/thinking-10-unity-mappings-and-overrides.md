# Unity mappings and per-node overrides

## Orlando's request — 2026-10-15

Analysis and a new plan, not implementation yet:

1. The Unity mappings inspector has become a list of lists. It is difficult to recognize entries; explore a grid and thumbnails.
2. Place repeated NPC placeholders in orlablocks, then replace individual placements with specific NPC prefabs in Unity. This must be an exception for that node, not an entity-wide mapping.

The attached screenshot shows entity names/IDs and prefab fields surrounded by always-expanded scale, offset, rotation and blockout controls. Only a handful of entries fit vertically. A missing-export entry is visible. Tags follow in the same long inspector.

## Analysis

Recognition and editing are different tasks. A grid alone would merely distribute large forms across columns. Prefer compact visual cards for finding an entity, with one detail panel for editing its mapping. Keep text, status and search useful when previews are unavailable. Tags and colors need their own representations, not prefab-shaped cards everywhere.

An entity mapping answers “what do all placements of this entity become?” A node override answers “what does this one placement become?” Claim already exists but stops sync for the object/subtree; it does not satisfy keeping an NPC attached to its authored placement.

Current evidence:

- `OrlaMappingsEditor.cs` renders all entity settings on every row. Its catalog reads exports from loaded Levels using the asset, so an absent entity is not necessarily deleted from the project.
- `OrlaMappings.cs` stores reusable entity/tag/color rules. `MappingSet` includes a global fingerprint in object revisions and generated entity hashes.
- `Sync.cs` resolves prefabs, placement transforms and kept blockouts separately. All must use the same effective per-placement mapping.
- `Replace` creates a new root, reparents added children and destroys the old root. It does not migrate arbitrary added root components or repair external references. This is a significant NPC workflow risk, not a solved preservation guarantee.
- `OrlaNode` has source identity and sync baselines. Overrides must survive replacement, so storing the only copy on the replaceable root is insufficient.
- `itemInstance` uses `arrayId/index`; this identifies a slot, not an independently persistent character. Start with ordinary instances for named NPCs.

Updated direction after Orlando’s clarification: a dockable mapping browser; Unity-only override state on a stable placement parent carrying OrlaNode; a replaceable prefab child; continued source transform synchronization. Override opens a prefab picker and applies the choice immediately. Clear override restores inheritance immediately. No Level navigation or extra Apply step. Investigate safe migration of existing prefab roots before implementation. See phase 18 for milestones, decisions and acceptance.

## Workflow clarification — 2026-10-15

Orlando wants the entire interaction on the selected synced GameObject’s OrlaNode inspector: Override → prefab picker → replacement, and Clear override → ordinary orlablocks behavior. His proposed empty parent with a prefab child makes node-owned state viable because that parent is no longer destroyed by replacement. This supersedes the initial Level-owned record recommendation; the Level still supplies sync context.

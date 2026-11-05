# Terrain layer mappings and terrain holes

> Implementation was authorized after this research. See `20-terrain-layers-and-holes` for the chosen source-local targeting, implementation and verification progress. Historical research statements below describe the pre-implementation investigation.

## Request and status — 2026-11-05

Orlando wants to research two additions:

1. Map an orlablocks terrain's palette color to a chosen Unity **TerrainLayer**, through the existing mappings workflow. The generated fallback currently looks too glossy in his project.
2. Author holes in terrain in orlablocks and carry them into Unity.

This is research and a proposed implementation direction, not an implementation plan accepted by Orlando. No production code, scene storage or Unity project was changed. Code paths and official Unity documentation were inspected; no new runtime, browser, physics or visual experiments were run. Existing phase 16/18 acceptance remains independent. Terrain holes were explicitly deferred by phase 16; this follow-up does not silently extend that phase.

## 1. Current implementation

| Area | Evidence and implication |
|---|---|
| Terrain authoring | `src/shared/scene.types.ts` and `terrain.ts`: one color per terrain, height modifiers Raise/Lower/Set, one owned source group. Modifier colors do not paint terrain regions. |
| Height generation | `evaluateTerrain` produces heights and a complete regular-grid mesh. Source collection accepts untilted volumes and smooth ramps. Validation rejects holes in source groups. Hidden inputs do not contribute. |
| Existing holes | `src/shared/holes.ts`: holes target ordinary solids through hierarchy scope. Terrain is not a solid or a cuttable target. These holes cannot currently cut terrain. |
| Unity export | `src/server/export.ts`: format 2 carries normalized, z-reversed height samples and terrain size; its record already includes the palette color. No hole mask exists. Source subtrees are omitted as geometry. |
| GLB | `src/server/gltf.ts` reconstructs the complete terrain grid from the Unity export payload. Adding holes only to Unity would leave GLB incorrect. |
| Unity import | `Sync.ApplyTerrain` creates stable TerrainData, sets heights, builds a palette texture/generated TerrainLayer and assigns a Terrain-compatible material plus TerrainCollider. It unconditionally restores a single generated layer on refresh. |
| Mappings | `Runtime/OrlaMappings.cs`: ColorMapping has body/floor Material fields. `Editor/Mappings.cs` ignores rows with neither of those fields and fingerprints only those material references. Terrain import does not resolve color mappings. |
| Mapping UI | `OrlaMappingBrowser.cs` Colors cards, summaries and detail fields currently represent body/floor materials. `MappingCatalog.cs` already discovers the exported palette. |
| Local edits | `TerrainSync.cs` fingerprints heights, size/resolution, layer references and selected layer/texture properties, material reference/shader and collider. It does not fingerprint holes. Drift checks run before unchanged-revision skipping. Trees/details/painted weights are outside ownership; assigning a new layer list is nevertheless currently managed. |
| Picking | `rayTerrainFirst` assumes six indices at a fixed offset per cell. Simply filtering mesh indices for holes would break this assumption. |

Read before implementation: `16-terrains` §§5, 8, 10, 13; `18-unity-mappings-and-overrides` §§4, 8; `19-ux-improvements` §19.6; their referenced thinking documents; `unity/Orlablocks/README.md`.

## 2. Feature A — color → TerrainLayer

### Proposed user workflow

In Unity's existing Mappings → Colors tab, select a color and assign **Terrain layer** using a normal TerrainLayer asset reference field. Example: green → Grass, brown → Dirt. Sync uses that layer across the terrain with that color. Body/floor mappings keep their current meaning for meshes. Clearing the field restores the generated palette fallback on the next Sync.

This is a reusable color rule shared by Levels using the mappings asset. A node-local terrain override, per-modifier painting and multiple surface regions on one terrain are separate features. Confirm that distinction if the request expands: today's terrain has only one surface color.

### Why a layer, and the glossy fallback

Unity separates the **Terrain Material** (shader/rendering behavior) from **TerrainLayer assets** (surface textures, tiling, normals and material properties). A layer can be shared among multiple terrains. An ordinary mesh Material is not a substitute for a TerrainLayer. [Unity Terrain Layers](https://docs.unity3d.com/6000.0/Documentation/Manual/class-TerrainLayer.html)

The current importer creates a 2×2 RGBA palette texture, writes opaque palette colors and leaves TerrainLayer smoothness/source at defaults. Unity documents diffuse alpha as a possible smoothness source, and mask-map alpha as smoothness when a mask is used. Local Unity **6000.5.9f1** URP `Shaders/Terrain/TerrainLitPasses.hlsl`, lines 175–195, additionally confirms source-dependent alpha/constant behavior. This is a plausible cause of Orlando's glossy appearance, not a visually reproduced diagnosis. The exact active layer values, shader and lighting in his project were not inspected.

Make the generated fallback explicitly matte as a companion fix: set generated-layer metallic/smoothness and a version-appropriate smoothness source, then verify under the actual URP shader, including its distant basemap. Do not assume changing a generic material `_Smoothness` property controls terrain layers. The 6000.5 API exposes `ConstantOnly`, `ConstantMultipliedByDiffuseAlpha`, and `DiffuseAlphaChannel`; avoid copying the older `Constant` spelling without compiling against the supported editor. [Unity 6000.5 smoothness source](https://docs.unity.com/en-us/engine/6000.5/script-reference/unityengine/terrainlayersmoothnesssource)

### Implementation boundaries and ownership

- Add an optional TerrainLayer reference to ColorMapping, its GUID/local-ID fingerprint and the lookup. A terrain-only rule must count as mapped even with null body/floor fields. Update Colors card preview/summary/search/detail UI to expose it.
- Resolve the mapping inside ApplyTerrain. Assign the selected asset by reference, preserving its tiling, textures, normals and smoothness. Never recolor, resize, dirty, regenerate or otherwise mutate that external asset or its textures. Keep the Terrain-compatible material path.
- No TypeScript scene schema or export-format change is needed for A: the color is already exported. Old mapping assets deserialize the added field as null.
- Start with one managed base layer, matching today's importer. Do not promise preservation of extra Unity-painted layers/weights through layer-list replacement. Define a tested preservation policy before broadening that contract; avoid adding unconditional SetAlphamaps calls to ordinary height refreshes.
- Distinguish reference drift from edits to an external layer asset. Editing a shared Grass asset should update every user of Grass; it should not falsely mark every terrain as locally sculpted. Fingerprint managed references, and only inspect mutable contents for importer-owned fallback assets.
- Review `TerrainSync.Protected`: shared external layers are expected and read-only. They should not force fresh TerrainData forks merely because a claimed terrain uses the same Grass layer. Continue protecting shared generated assets that sync actually writes.
- Changing fingerprint structure can invalidate every existing baseline. Version/migrate it deliberately, verifying the old managed baseline before adopting a new one. Do not blindly accept a new baseline over local sculpt/layer edits.
- Ensure changing/clearing a mapping refreshes an unchanged source export, honors Claim/drift and participates in Unity Undo. Unity provides [SetTerrainLayersRegisterUndo](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/TerrainData.SetTerrainLayersRegisterUndo.html); validate its interaction with the existing complete-object Undo and rollback path.

## 3. Feature B — terrain holes

### Unity capability and limit

Unity stores holes in a separate opacity mask. With `n` height samples per side, the hole mask has `(n−1)²` cells. `TerrainData.SetHoles` takes `[row,column]` booleans: **true means surface exists; false means a hole**. Keep that polarity explicit in the interchange contract. [SetHoles](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/TerrainData.SetHoles.html)

Holes affect TerrainCollider and baked navigation as well as rendering. They remove the terrain surface; they do not create tunnel walls, a floor or thickness. Those remain ordinary geometry. Edges follow mask resolution and can be concealed with rock/entrance meshes. At 256 m width / 257 height samples, cells are 1 m wide; at 1025 samples they are 0.25 m. Width/depth spacing can differ. URP builds require Terrain Holes enabled in the pipeline asset and a shader that samples the hole mask. [Unity Paint Holes](https://docs.unity3d.com/6000.0/Documentation/Manual/terrain-PaintHoles.html)

### Authoring choices — vertical semantics confirmed; target scope proposed

Reuse existing box/cylinder/free-form **Hole** shapes instead of introducing a destructive brush or boolean height operation. Heights remain evaluated normally; a second pass derives cell presence. Overlapping holes union; Raise/Lower/Set ordering does not refill holes. No Fade for a binary hole mask.

Two distinct choices need to be made explicitly:

1. **Vertical semantics — confirmed by Orlando (2026-11-05):** volume/surface intersection. A cutter entirely above or below the terrain does nothing. Use the final evaluated surface, so moving a hill can change whether it intersects the hole. The per-cell rasterization policy still needs the experiment below.
2. **Target ownership:** simplest bounded first increment is Hole shapes inside the terrain's owned source group, cutting that terrain only and omitted from export with other inputs. This intentionally gives those authoring holes a terrain-local role; do not accidentally let them cut source modifiers or unrelated buildings. Alternative: ordinary scene holes target terrain using the common resolver. Phase 19.6 proposes explicit `cuts` targets, but it is not implemented; do not assume it exists or couple the first version to its completion. Decide whether general scene-hole targeting is required before implementation.

For the first prototype, support untilted boxes, cylinders and free-forms, with yaw; decide tapered/beveled cutters explicitly. A footprint-plus-min/max-y shortcut does not describe tapered geometry accurately. Entity/array-generated cutters, tilted cutters, refill operations, arbitrary terrain CSG, caves and overhang generation can remain deferred.

### Rasterization experiment required

Volume intersection is continuous; Unity's presence mask is per cell. Compare at least:

- Sampling the final terrain surface at each cell center and testing containment in the hole volume: cheap and deterministic, but can miss narrow cutters and cell-corner intersections.
- Removing a cell if either of its two surface triangles intersects the hole volume: preserves narrow intersections but expands openings to touched cells and costs more.

Choose one documented policy from a fixture with a small doorway, a diagonal cut, sloped ground, sub-cell shapes and boundary contacts. Do not claim geometric precision finer than the grid. The browser/GLB should remove the same whole cells; exact Unity shading/LOD edge appearance still needs visual verification.

### Shared implementation path

1. Extend terrain input validation/collection to classify height modifiers separately from cutters. Keep source ownership, inherited hidden state, transforms, copy/delete/undo, conversion validation and omission from exports coherent. Add mask-relevant cutter geometry to cache keys without making color changes rebuild heights.
2. Return a derived cell-presence mask alongside heights from shared evaluation; persist authored shapes only. Keep raw heights finite and available even under removed cells. Define empty/all-hole bounds explicitly. Keep cache memory accounting accurate when per-terrain indices replace shared full-grid indices.
3. Make TerrainMesh and capture meshes omit both triangles of removed cells. Fix `rayTerrainFirst` to address each cell's vertices directly or use stable per-cell metadata, rather than slicing six indices out of a now-compacted buffer. Picking must pass through holes to geometry below.
4. Keep the existing 129-sample drag preview policy under review: rerasterizing at 129 may erase a narrow entrance during a drag. Compare responsiveness versus retaining/resampling the canonical hole mask. Release, captures and exports must use canonical resolution.
5. Version the Unity interchange explicitly (proposed format 3), carrying mask offset/dimensions or a documented implicit `(n−1)` size. One byte per cell is at most 1 MiB for the current 1025-sample terrain; bit-packing is optional, not a prerequisite. Keep binary chunk alignment valid for later float payloads. Include mask contents in revisions but exclude packaging offsets just as heights do.
6. Validate dimensions, byte lengths, offsets, polarity and values before import. New reader accepts format 1/2 and treats absent legacy masks as full surface; old readers reject format 3 instead of silently filling holes. Reverse **cell** rows using `(n−2−z)`, not the height-sample `(n−1−z)` formula.
7. GLB must read that same mask and omit the same cells. Handle zero-triangle/all-hole meshes without emitting invalid accessors or infinities. Source cutters remain absent from exported geometry.
8. Apply the mask after setting Unity heightmap resolution, using SetHoles. A one-shot import does not need delayed interactive LOD APIs. Explicitly restore full surface when the last authored hole is removed. TerrainCollider uses the same TerrainData; confirm physics with raycasts rather than appearance alone.
9. Extend managed drift/Undo/rollback/claim protection to the hole mask, with a baseline migration policy. Unity-painted holes must be detected before any refresh can overwrite them. Legacy baselines contain no mask, so nonempty existing Unity holes need a decision rather than silent adoption/erasure. Save/reload and unchanged-export drift checks matter here too.
10. Update inspector explanations, MCP validation/read summaries, guides and GLOSSARY when behavior is implemented. Preserve the existing explicit limitation on terrain-aware Walk/placement/sight/clearance/slice/enclosure; this feature must not imply those deferred queries have become terrain-aware.

## 4. Recommended sequence and acceptance gates

Implement A first as a Unity-only increment; then prototype B's cutter semantics and rasterization before making its format and editor contract final. They are independent enough that A need not wait for B.

**A checks:** generated matte fallback under URP; chosen layer identity/tiling/normals retained; terrain-only color mapping UI and serialization; map/change/clear on unchanged exports; body/floor regression; legacy assets; shared layer across two Levels and a claimed terrain; external layer edits without false drift; user-assigned reference drift; height sculpt protection; Undo/Redo, rollback and save/reopen. Compile against the supported Unity version and extend the existing real importer/mapping harnesses. Orlando verifies appearance in his own project separately.

**B checks:** asymmetric off-center holes on rectangular, nonzero/negative terrain; polarity/z flip; cuts above/below/intersecting the surface; slopes and all supported cutter types; narrow/diagonal/boundary cuts at different resolutions; hidden/nested sources; move/scale/mirror/copy/reorder/delete/undo/reload; no holes, overlapping holes and all-hole terrain; editor picking through to a room below; captures/GLB/Unity mask-cell agreement; malformed payload rejection and old exports; hole-only changes refresh while unrelated packaging does not; Unity collider ray misses in holes and hits beside them; last-hole removal; local painted-hole drift; Claim/Revert and shared assets; Unity Undo/Redo/rollback/save/reopen; URP player build. Benchmark mask generation and drag behavior in scratch data only.

No tests were run for this research-only change. The implementation gates above are future work, not passed checks.

## 5. Progress and next step

- **2026-11-05 — research gathered:** traced terrain evaluator/render/picking, Unity and GLB export, mappings UI/lookup, importer ownership and existing acceptance harnesses; checked official Unity layer/hole APIs and installed Unity 6000.5 URP smoothness source code.
- **Confirmed by Orlando (2026-11-05):** existing Hole shapes cut terrain where their volume intersects its surface; footprint-only punching is not the chosen behavior.
- **Recommendations:** color → external TerrainLayer in existing Colors UI; read-only ownership of mapped assets; explicitly matte fallback; shared cell mask for holes; settle source-local versus general hole targeting before implementation.
- **Remaining:** settle target scope and prototype cell rasterization, then create a scoped follow-up phase with independent layer-mapping and hole increments. No implementation, visual reproduction or new automated acceptance is claimed.

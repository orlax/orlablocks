# Orlablocks for Unity

Brings an orlablocks scene into a Unity project as a blockout (plan 15). orlablocks does the geometry: it bakes every
shape as its editor draws it, holes cut, and exports it. This code builds the scene in Unity from that export. It isn't
a package yet.

Needs Unity 6 and URP. Without URP, the materials fall back to the Standard shader.

## Install

Copy (or symlink) this `Orlablocks` folder into your project's `Assets/`. It has two assemblies:
- `Orlablocks.Runtime`: the components on synced objects, included in builds;
- `Orlablocks.Editor`: the sync, editor only.

## Use

1. In orlablocks, open **Export → Unity** and **Choose…** a folder next to your Unity project's `Assets/`, not
   inside it (for example `<UnityProject>/Orlablocks`). Then **Export now**. Each scene gets a folder of its own
   there, named by the scene's ID.
2. In Unity, choose **GameObject → Orlablocks Level**, then pick the scene's folder (the one with `level.json` in
   it). It syncs right away.
3. After changes in orlablocks, export again and press **Sync** on the Level.

## What you get

- **Under the Level:** one GameObject per orlablocks node, in the same groups (a group sits at its parent's
  origin), named `name (id)`, each with an `OrlaNode` (its ID, type, tags, description).
  - Shapes have their mesh, a collider (a box collider for plain boxes, a mesh collider otherwise) and the static
    flags for batching and occlusion. What carries orlablocks' built-in `#no-collisions` tag, and everything in a
    group or entity that does, gets no collider (an instance in such a group has its entity's colliders turned off).
  - New ordinary instances have a stable placement parent with a managed prefab child (generated blockout or mapped prefab). Array items retain the existing prefab-root layout.
  - Notes (`OrlaNote`) and lines (`OrlaLine`) are tagged EditorOnly, so they never reach a build.
  - Hidden nodes arrive disabled.
- **In `Assets/OrlablocksGenerated/<project>/`:**
  - `Materials/`: `orla-<color>` and `orla-<color>-floor`, URP Lit, matte, with the 1 m tile. They're made only if
    missing, so tune them freely. **Rebuild materials** on the Level makes them again.
  - `Textures/OrlaTile.png`: that tile.
  - `Entities/`: each entity's prefab and meshes. Don't edit these: a sync replaces them when the entity changes.
  - `Levels/`: each scene's meshes and `Terrains/<Level key>/`: stable TerrainData, layer, palette texture and Terrain-compatible material assets. New Levels own separate terrain assets; existing 16.1 assets keep their identity when safe.
- **Coordinates:** orlablocks' north (-z there) is Unity's forward (+z), and east is +x in both. One unit is one meter.

## Syncing again

A sync only changes what changed in orlablocks: each object keeps the export's `rev` for its record, and one whose
rev is the same is left alone.
- **What's yours stays.** A sync owns an object's transform, name, meshes, materials, collider and `OrlaNode`.
  Children and components you add are yours, and they stay. When orlablocks removes an object you added things to,
  they're kept in `Orphaned (<id>)` under the Level, where they were.
- **Moved in Unity:** a synced object you move, turn, scale or reparent is left where you put it and listed on the
  Level. **Revert** takes orlablocks' place back on the next sync; **Claim** makes it yours.
- **Terrain edited in Unity:** sculpted heights or managed settings are left alone, even on an unchanged export. The Level and node inspectors offer the same **Revert**/**Claim** buttons. Sync owns heights, resolution, size, generated layer/diffuse texture/tile size, material reference/shader and TerrainCollider reference/enabled state. Trees, details, painted layer weights, extra components, children and other Terrain settings remain yours. Changing resolution can reset Unity's painted weights; claim before using Unity as the terrain authoring source. A deleted locally edited terrain is kept until you choose Revert (remove it) or Claim (keep it).
- Terrain asset edits participate in Unity undo/redo. Claimed terrain assets cannot be modified through another Level's sync. The first 16.4 sync of a legacy terrain establishes a content baseline when the unchanged heights match; otherwise it asks for a one-time Revert/Claim decision, because the earlier importer did not record sculpt drift.
- **Claim** (the object's inspector, or **GameObject → Orlablocks → Claim**): syncs stop changing it and what's under
  it, and the Level lists claimed objects that orlablocks changed or removed.
- **Update available** shows on the Level, and in the Scene view's corner, when orlablocks exports the scene again.
  With **Auto sync** on, the Level syncs itself (never in Play mode).
- A sync is one undo step. The report says how long each part took (read, entities, objects, meshes).
- A level's meshes are split over up to 16 files (`Levels/<scene>/meshes-*.asset`), and a sync writes only the
  files it changed, so syncing a big level after a small change stays quick.

## In the Scene view

- **Notes:** a pin and a flag in the note's color, faint when done, with its label and the start of its text (all of
  it when selected). **Show notes** on the Level turns the text off.
- **Lines:** the curve in its color and width, dashed or not, with arrowheads. `OrlaLine.WorldPoints()` gives a
  route to editor tools.
- **Holes:** a wireframe of the hole's solid, when selected or with **Show holes** on.

## Claim as ProBuilder

With ProBuilder installed (5.0 or later), **GameObject → Orlablocks → Claim as ProBuilder** turns selected synced shapes
into ProBuilder meshes you can edit, and claims them, so syncs leave them alone. It's one undo step. Faces meeting at
under 30° are smoothed, as in orlablocks, and batching static is turned off (ProBuilder can't edit a batched
renderer). Instances' parts belong to their prefab, so they're left out. Without ProBuilder, the menu item isn't there.

## Baked lighting

**Lightmap UVs** on the Level generates a second UV set on the meshes and adds Contribute GI to the shapes. It makes
syncs slower, and turning it on remakes every mesh once. Turning it off stops generating them, but doesn't take
Contribute GI back off.

## Mappings

An **Orlablocks Mappings** asset turns orlablocks' things into your game's. Make one with **New** next to the Level's
**Mappings** field (or **Create → Orlablocks → Mappings**). Give all of a project's Levels the same one, since they
share the project's entity prefabs.
- **Entities:** an entity's instances and array items become your prefab, with a scale factor, an optional
  position and rotation offset from the entity's pivot (a broom whose pivot is its middle, not the floor; the
  offset grows with the instance's scale), and the generated blockout **replaced**, **kept hidden** under it (to
  compare), or **kept**. The blockout stays at orlablocks' place whatever the offset. New ordinary instances keep `OrlaNode` on a stable parent; prefab calibration belongs to its managed child.
  Mapping changes apply on the next Sync. Legacy prefab roots are retained with a migration conflict before destructive replacement.
- **Tags:** what carries a tag, and everything in a tagged group, gets a layer (on an instance, its parts too, where
  its colliders are), a Unity tag (it must exist in Tags and Layers), components (added if missing, never removed)
  and static flags. **Keep notes and lines in builds** is for a route the game reads.
- **Colors:** a palette color uses your body and floor materials instead of the generated `orla-*` ones.

Open **Mapping browser** from the mappings asset inspector, the Level inspector, or **Window → Orlablocks → Mapping browser**.
- **Entities:** searchable cards show the entity name/ID, labeled generated blockout and Unity prefab previews,
  and mapping status. Filter mapped, unmapped, invalid or not in available exports. Select a card to edit its
  prefab, scale, position/rotation offsets and blockout policy. Drag a prefab into the field, or use its picker;
  **Ping prefab** locates the asset. Narrow windows put the detail panel below the cards.
- **Tags:** compact summaries with selected layer, Unity tag, component, static flag and build settings.
- **Colors:** palette swatches and body/floor material previews with selected material fields.

The catalog reads exports from loaded scene Levels using the selected asset. **Refresh** rereads them after an
external export; opening/focusing the browser and relevant editor changes also refresh the snapshot. Unreadable
sources are reported. Unloaded Levels offer no catalog entries; saved mappings remain editable. **Not in available
exports** never means deleted. **Manual entity ID/tag/color key → Add rule** works without a loaded Level.
Selecting an unmapped card creates nothing; assigning its prefab or choosing **Create mapping** creates a rule.
Duplicate entity rules remain visible as invalid: edit their IDs or explicitly **Remove mapping** on individual rules.
Multiple tag rules remain additive. Existing sync resolution and mapping assets are unchanged.

Edits support Unity Undo/Redo and asset dirty tracking. Changes apply on the **next Sync** of each Level; opening
or editing this browser does not trigger a sync. Invalid mappings are also reported by Sync.
Previews are requested only for visible cards, cached until asset changes, with icons/text when unavailable.

To repeat the automated browser checks, copy `scripts/unity/MappingBrowserAcceptance.cs` under `Assets/Editor`
and this importer into a scratch project at `/private/tmp/orla-mappings-18-browser`. Run Unity with
`-batchmode -nographics -projectPath /private/tmp/orla-mappings-18-browser -executeMethod MappingBrowserAcceptance.Run`
(without `-quit`). The harness refuses other project paths and writes `browser-result.json` and `filter-metrics.txt`.
Its fixture uses a generated export under that scratch project; no orlablocks scene storage is accessed.
Run `MappingBrowserAcceptance.RunGUI` with `-batchmode` (without `-nographics` or `-quit`) for five IMGUI
layout/repaint event scenarios; it writes `gui-result.json` and `gui-metrics.txt`, then exits. These checks validate
layout execution and preview request bounds, not human visual acceptance. A minimal scratch project's built-in
Unity modules are sufficient; optional template packages are not required.
`MappingBrowserAcceptance.Open` opens the saved fixture for visual checks. The final fixture deliberately contains
missing destinations, duplicates, an unknown ID, and an unreadable export. Human review should also exercise
prefab drag/drop, previews and narrow docking with real mappings.

## Individual NPC prefab overrides

Select the **placement parent** of a newly synced ordinary instance. Its `OrlaNode` inspector has a standard
**Override prefab** GameObject reference field. Drag a prefab asset from the Project panel into it, or use its native
Unity picker. Assignment updates that node immediately as one Undo step. Emptying the field restores inheritance.
**Clear override** immediately returns to the current entity mapping, or the generated blockout when unmapped.
No Level navigation or extra Apply/Sync is required. The optional **Calibration** foldout edits scale, position/rotation
offsets and blockout policy immediately. The first override copies effective global calibration; subsequent values
are local, including when global mappings change. Different prefab pivots may need different offsets.

The parent owns source transforms, visibility, identity and the serialized `OrlaPlacement` state. The chosen prefab
and optional blockout are explicitly referenced managed children; the blockout stays at the source pivot. Source
movement continues on Sync. Immediate representation edits preserve local parent drift; Sync still requires Revert
or Claim for that drift. Revert keeps the override. Claimed nodes/ancestors require Unclaim before replacement.
Tags and no-collisions continue to apply. Overrides never enter shared generated entity assets.

Reference the **placement parent or user components on it** from gameplay. Those references, components and separate
user children survive supported prefab swaps. References into a replaced prefab cannot be repaired or preserved.
Local modifications within managed prefab content (including direct calibration edits) block replacement and Sync;
resolve/revert those edits first, or Claim the node. Edit calibration through the node inspector. Use
**GameObject → Orlablocks → Select owning placement** from selected managed content; generated `OrlaNode` inspectors
also offer an owning-parent button.

Only ordinary scene instances support overrides. Array items have slot identity and remain ineligible. Generated
assets and entity-definition children cannot own exceptions. Legacy prefab roots are **not automatically migrated**:
Claim the old object, create a new ordinary source instance with a new ID, explicitly rebind gameplay references to
its stable parent, verify it, then retire the legacy source/object. The sync report explains migration conflicts.

A missing override prefab retains the previous representation and warns; choose a valid prefab or Clear override.
A changed source entity/type is retained for review; choose Override to explicitly rebind an ordinary instance or
Clear to resume inheritance/conversion. Removed source nodes retain their stable parent and override under the Level,
where Sync can rediscover the same source identity if restored. Clearing a missing-source override allows ordinary
removal/orphan handling on the next Sync. The Level inspector lists placement conflicts for recovery. Changing the
Level's project/scene source never reuses a local override for colliding IDs; restore the original source to recover.
Two Levels, including editor duplicates, own independent exceptions. Duplicating a node in Unity detaches its copied
ID from sync, as before. Save/reopen, domain reload and Undo/Redo retain the serialized records and managed references.

For production override regression checks, copy `scripts/unity/PlacementAcceptance.cs` under `Assets/Editor` and this
importer into a scratch Unity project at **`/private/tmp/orla-mappings-18-overrides`**. The harness refuses other paths.
Run Unity with `-batchmode -nographics -projectPath /private/tmp/orla-mappings-18-overrides
-executeMethod PlacementAcceptance.Run -logFile /private/tmp/orla-mappings-18-overrides/checks.log` (without `-quit`).
It creates scratch exports and fixtures, requests a real script reload, tests export-driven Auto sync and exits,
writing `placement-result.json`. No orlablocks scene storage or game project is used.

Production browser appearance, interactive prefab picker/drag/drop, and moving distinct NPCs while exercising actual
gameplay references in Orlando's project still need his hands-on acceptance. Automated scratch tests cannot grant it.

## Terrain export verification

Format 2 adds native Terrain height payloads; the reader accepts format 1 ordinary scenes and rejects terrain records in format 1 or newer unsupported formats. Unity imports the server's evaluated samples, not source shapes. GLB uses the same samples as a triangle mesh with the editor's diagonal layout; Unity's height storage/LOD can differ slightly.

For a repeatable isolated check, run `node --import tsx scripts/terrain-export-fixtures.ts /private/tmp/terrain-fixtures`, copy this importer and `scripts/unity/TerrainAcceptance.cs` into a scratch Unity project's Assets (the latter under Editor), then launch Unity with `ORLA_TERRAIN_FIXTURES=/private/tmp/terrain-fixtures`, `-batchmode -nographics -projectPath <scratch> -executeMethod TerrainAcceptance.Run` (without `-quit`). The harness exits and writes `result.json`; it tests the real importer, asset undo, local sculpt protection, claims, deletion/orphans, compatibility and the Auto sync watcher. Never run fixtures in your real project.

## Phase 18 prototype

The mapping browser and stable-parent NPC override experiments live separately in
[`scripts/unity/mappings-prototype`](../../scripts/unity/mappings-prototype/README.md).
They run only in a scratch Unity project. The production browser is now available above; the stable-parent override is integrated in production as described above.
The prototype README records the supported reference target, calibration/pivot findings, legacy migration
policy and reproduction steps. Orlando confirmed seeing the prototype work in the scratch project. Production node override integration is implemented; final gameplay acceptance remains pending.

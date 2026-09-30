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
  - Instances and array items are instances of a generated prefab per entity.
  - Notes (`OrlaNote`) and lines (`OrlaLine`) are tagged EditorOnly, so they never reach a build.
  - Hidden nodes arrive disabled.
- **In `Assets/OrlablocksGenerated/<project>/`:**
  - `Materials/`: `orla-<color>` and `orla-<color>-floor`, URP Lit, matte, with the 1 m tile. They're made only if
    missing, so tune them freely. **Rebuild materials** on the Level makes them again.
  - `Textures/OrlaTile.png`: that tile.
  - `Entities/`: each entity's prefab and meshes. Don't edit these: a sync replaces them when the entity changes.
  - `Levels/`: each scene's meshes.
- **Coordinates:** orlablocks' north (-z there) is Unity's forward (+z), and east is +x in both. One unit is one meter.

## Syncing again

A sync only changes what changed in orlablocks: each object keeps the export's `rev` for its record, and one whose
rev is the same is left alone.
- **What's yours stays.** A sync owns an object's transform, name, meshes, materials, collider and `OrlaNode`.
  Children and components you add are yours, and they stay. When orlablocks removes an object you added things to,
  they're kept in `Orphaned (<id>)` under the Level, where they were.
- **Moved in Unity:** a synced object you move, turn, scale or reparent is left where you put it and listed on the
  Level. **Revert** takes orlablocks' place back on the next sync; **Claim** makes it yours.
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
  compare), or **kept**. The blockout stays at orlablocks' place whatever the offset. Your prefab's root gets the `OrlaNode`.
  When you change the mapping, the next sync swaps the instances, and whatever you added under them moves across.
- **Tags:** what carries a tag, and everything in a tagged group, gets a layer (on an instance, its parts too, where
  its colliders are), a Unity tag (it must exist in Tags and Layers), components (added if missing, never removed)
  and static flags. **Keep notes and lines in builds** is for a route the game reads.
- **Colors:** a palette color uses your body and floor materials instead of the generated `orla-*` ones.

The entity and tag pickers search (type to filter) what the exports of the Levels using the mappings have, and a
search field filters the entity rows once there are more than a few. The next sync applies a change to
every object once. A mapping that can't apply (no prefab, a missing script, an unknown Unity tag) is listed in the
Level's report, and the blockout stays.

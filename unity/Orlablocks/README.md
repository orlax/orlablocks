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
    flags for batching and occlusion.
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
- A sync is one undo step.

Mapping entities to your own prefabs and tags to layers or components comes next (plan 15, §9).

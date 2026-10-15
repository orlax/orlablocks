# Phase 18.1 scratch prototype

This directory is an experiment, separate from the installed importer. Copy its Runtime files into a scratch Unity project's `Assets/`, its Editor files into `Assets/Editor/`, and `unity/Orlablocks` into `Assets/Orlablocks`. Use Unity **6000.5.9f1**. The harness refuses projects outside `/private/tmp/orla-mappings-18-*`.

Run (without `-quit`; the harness exits after checks):

```sh
/Applications/Unity/Hub/Editor/6000.5.9f1/Unity.app/Contents/MacOS/Unity \
  -batchmode -nographics -projectPath /private/tmp/orla-mappings-18-prototype \
  -executeMethod OrlablocksPrototype.MappingPrototypeChecks.Run \
  -logFile /private/tmp/orla-mappings-18-prototype/checks.log
```

The harness creates prefab assets, a 120-entity fixture plus one unknown saved ID, and `Assets/Fixture/NPCs.unity`. `result.json` records checks and filter timing. For visual review, reopen the project with `-executeMethod OrlablocksPrototype.MappingPrototypeChecks.Open`. Select `instance_1` and use its **PrototypePlacement** inspector for Override / Clear. This is an interaction experiment; the production OrlaNode inspector and Sync remain unchanged. The browser exposes Entities only; Tags/Colors, real export discovery and inspector entry points belong to 18.2.

## Chosen hierarchy

```text
Level
  placement parent (source transform, active state, OrlaNode, local override)
    managed prefab child (calibration position / rotation / scale)
    optional managed blockout (identity local transform, hidden or shown)
    user child
```

Identify both managed children through serialized object references. Gameplay references should target the parent GameObject, Transform, OrlaNode or user components on the parent. Swapping a prefab deliberately destroys its internal components: external references into them do not survive. No arbitrary component copying or reference repair is promised.

Calibration lives wholly on the managed prefab child. Its local matrix is `TRS(offset, Euler(rotation), scale)` under the source placement matrix. The optional blockout is a sibling at identity, so calibration never moves the blockout. Copy effective inheritance at the first override, then retain independent local values. The different-pivot fixture demonstrates that copying is only a starting point: a center-pivot merchant needs different vertical calibration from a floor-pivot guard. 18.3 must expose this under the collapsed calibration section.

The experiment reconciles only representation. It preserves parent drift and refuses claimed placements and recorded component/descendant/content edits in the managed prefab, and rolls back a failed operation as a whole. It does **not** exercise production sync, source deletion/switching, array slots, tag/cut/no-collision handling, export checkpoints or Auto sync. Those remain 18.3/18.4 checks. Root calibration is treated as managed content in this experiment; detecting direct edits to the managed child’s calibration against its applied baseline remains a production integration requirement.

## Legacy compatibility decision for 18.3

Do not automatically migrate existing root-prefab placements in this phase. Keep their current hierarchy, references and existing sync behavior until a representation replacement would be needed; then retain the old representation and report a migration conflict instead of destroying it. This gate must also cover a legacy source type change or removal when user state could be lost. Applying an override to a legacy root must explain the conflict before making changes.

Why: putting the existing root below a new empty parent moves the stable reference target away from its source identity. Keeping it as the parent requires unpacking its prefab and deciding which components, nested prefabs and modifications to remove. Neither is a safe generic migration of gameplay references. Added components, tag-added components, prefab connections, overrides, children, claimed/drifted transforms and kept/cut blockouts cannot be inferred as disposable content.

Concrete recovery for an existing referenced NPC: Claim the legacy placement to retain it and its references; create a separate ordinary source instance with a new ID and import it as a stable placement; move/rebind the intended gameplay components/references to that parent manually, verify them, then remove the retired source instance and explicitly clean up the claimed object. This is deliberate opt-in work. A later dedicated conversion tool could improve this; phase 18 does not promise one. New placements use stable parents. Unconverted legacy nodes remain reported and must never silently adopt new settings through a destructive root replacement.

## Browser implementation choice

Use an IMGUI EditorWindow for this increment, matching the importer and verified against the installed Unity assemblies. Fixed-height cards allow row virtualization; details move below the grid under 760 px. Only visible cards request previews. Cache successful previews per asset, clear on project asset changes, and bound pending-preview repaints to a short interval. Fallback icons/text keep cards usable headlessly. No manifests are read by cards. The fixture does not establish real export I/O or large-project asset-preview performance; measure those in 18.2.

## Verification status (2026-10-15)

The real headless Unity harness passes 25 checks; npm has 577 passing tests, typecheck and importer compilation pass. Browser catalog/filter mean: 1.59 ms for 121 entries over 100 headless iterations. This measures catalog work, not total GUI frame or asset-preview time.

Rendered wide/narrow screenshots remain pending. An initial graphical run exposed Unity fake-null handling in search, which was fixed; its incomplete captures were rejected. The native UI tool bound to Orlando's separate game editor rather than this scratch process; no edits or sync were performed in that game project. Do not use that window as evidence for this prototype. Picker acceptance/cancellation and Orlando's visual/gameplay review also remain open.

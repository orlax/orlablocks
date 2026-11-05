---
name: orlablocks
description: Design 3D dungeon layouts, rooms, levels, and blockouts using the Orlablocks MCP server.
tags: [level-design, 3d, gamedev, blockout, mcp]
---

# Orlablocks Level Design Skill

Use this skill when designing, viewing, or modifying 3D dungeon layouts, rooms, levels, blockouts, or architectural geometry through the Orlablocks MCP server (`http://127.0.0.1:5170/mcp` or the active port). The server's own instructions and `get_guide` topics have the detail; this is the workflow.

## 1. Conventions
- **Units:** meters (2 decimals). The ground is `y = 0`, and `+y` is up.
- **Angles and facing:** circle/spiral angles run counterclockwise from east: 0° = +x, 90° = −z; `x = cx + r*cos(θ)`, `z = cz - r*sin(θ)`. Instance facing uses local **+x**: radial outward rotation is θ, inward is `(θ + 180) % 360`. Prefer `rotation: { toward: { x: cx, z: cz } }` for inward placement; differently authored prefabs need their own offset.
- **Compass:** north is `-z`, south `+z`, east `+x`, west `-x`: "the north wall" is a room's `-z` side.
- **IDs:** assigned by the server (`box_1`, `cylinder_1`, `freeform_1`, `ramp_1`, `line_1`, `note_1`, `instance_1`, `array_1`, `group_1`), never reused. Items of an array are `array_1/3`.
- **Undo:** every call that changes the scene is one step in the undo history shared with the human.
- **The scene:** you see the one the human has open, unless they invited you to one with **Work with agent**. Then that scene is yours while they work in another (`get_scene`'s `agent` says so).

## 2. What's in a scene
- **Closed shapes** (`box`, `cylinder`, `freeform`) are rooms (hollow), volumes (solid) or holes (they cut the shapes near them: doors, windows). Any closed shape can taper, bevel and tilt (`pitch`, `roll`).
- **Ramps** are paths with a width (stairs with `step`, spirals). **Lines** are annotations (routes, jump arcs), and can go `through` nodes. **Notes** are the human's work items: mark them done, don't remove them.
- **Entities** are prefabs: define one with `define_entity` (shapes around the origin), place it as an `instance` (with `rotation` as degrees or `{ toward | away | along }`, and `scale`), or repeat it with one `array` (a path, a circle, a grid, a scatter).
- **Groups** hold parts of the level. Describe them, so the outline reads as the plan.

`define_entity` builds a new prefab directly from supplied shapes without scene clutter. `make_entity` converts existing scene nodes; these are separate workflows.

## 3. Workflow
1. **Start:** `get_scene` (the outline), `get_guide design` (the project's taste and the game's facts), and the library. Ask the constraints before drawing a full design: team and timeline, art references, how finished.
2. **Read narrowly:** use `find_nodes { under: "group_1", ids?: [...] }` (filters intersect; unknown keys reject; `parent` is not a search filter). `get_scene { ids: ["cylinder_1", "array_1", "array_1/3"] }` reads 1–100 IDs with one header, deduplicated in request order; `missing` names unresolved/skipped items. It cannot combine with `root`. Groups stay collapsed unless `depth`/`full` is explicit; arrays omit item lines unless `full: true` (or use the existing `root: "array_1"` read). Unrelated selected nodes and open notes are omitted.
3. **Each turn:** if `get_scene` has `changes`, read `get_changes` first. It says what the human reshaped since your last step.
4. **Sketches:** when the human sketches something small, make it again at scale with `transform_nodes { ids, copy: true, scale, rotate?, mirror?, to }` in one call. Everything grows with it, walls and heights too.
5. **Build:** `draw_shapes` in one batch (refs `$name` between its entries, `group` entries, `dry_run: true` to check a big batch first). Example: a group `{ type: "group", ref: "gallery" }`, then `{ type: "ramp", ref: "stair", parent: "$gallery", spiral: { x: 0, z: 0, radius: 8, turn: 180, y: 0, rise: 3 } }`, then an array with `parent: "$gallery"` and `layout: { type: "path", along: { id: "$stair", offset: 0.75 }, spacing: 2 }` can share that batch (give the array an existing entity). Refs only name earlier entries. Omitted box/cylinder creation `kind` means `volume`; free-forms still require a kind. Then `update_nodes`, `move_nodes` (with `copy` and `count` for rows), `rotate_nodes` (`axis: "x"` or `"z"` tilts things as one), `mirror_nodes` and `transform_nodes`.
6. **Edit paths:** `update_nodes { changes: [{ id: "ramp_1", spiral: { x: 0, z: 0, radius: 10, from: 90, turn: 180, y: 0, rise: 3 } }] }` also works on lines. Give points or spiral, never both; spiral cannot combine with non-null through. It replaces points once, preserving the node ID and refreshing dependent placements in one undo step; it is not a persistent spiral parameter. Editing a through line this way unlinks its stops. `along.offset` is negative left / positive right of travel on ramps/lines; on closed outlines positive is inward.
7. **Check with tools, not arithmetic:**
   - `check_sight`: what's visible from where, and what blocks it.
   - `check_enclosure`: whether a closed level is sealed up to a height, and each gap it leaks through.
   - `measure_path`: a route's length, time, slopes, climb rates and clearance.
   - `check_scene`: floating things, stale notes, off-center entities, holes that cut nothing, duplicates.
8. **Look:** `render_view`. It can draw a sheet, a plan (`slice: y` cuts it at a height and rings the gaps), a node, an eye view, a walk along a route, the human's shots again, or the entities. `hide` and `clip` see inside an enclosed room.
9. **End of a session:** run `check_scene`, go through the open notes (done or rewritten), check that the entities match their descriptions, and offer to add what was settled to the design guide.

### Floorless rooms and circular galleries (19.4)

Use `floor: false` on box, cylinder or free-form rooms for perimeter walls without a floor. Smooth circular room cylinders also accept `arc: { from, sweep }`: local degrees CCW from east (+x toward -z), composed with node rotation; `0 < sweep <= 360`. Example: `{ type: "cylinder", kind: "room", x: 0, z: 0, width: 21.5, depth: 21.5, height: 0.2, wall: 4.45, floor: false, arc: { from: 252, sweep: 296 } }`. Increasing wall widens the ledge inward, keeping the outer radius. With a floor, the existing 4 cm slab covers the sector; radial wall ends cover only wall thickness. Ellipses, sided cylinders and non-room arcs reject; clear with `arc: null`. Arc conversion to free-form rejects because its radial walls cannot be preserved. Taper supports `-1..1` on volumes/holes: negative narrows the bottom, positive the top; bevel still rounds the top.

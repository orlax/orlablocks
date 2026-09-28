---
name: orlablocks
description: Design 3D dungeon layouts, rooms, levels, and blockouts using the Orlablocks MCP server.
tags: [level-design, 3d, gamedev, blockout, mcp]
---

# Orlablocks Level Design Skill

Use this skill when designing, viewing, or modifying 3D dungeon layouts, rooms, levels, blockouts, or architectural geometry through the Orlablocks MCP server (`http://127.0.0.1:5170/mcp` or active port).

## 1. Core Coordinate System & Conventions
- **Units:** Real-world meters (2 decimals). Ground plane is at `y = 0`. Vertical axis is `+y` (up).
- **Compass:**
  - **North:** `-z`
  - **South:** `+z`
  - **East:** `+x`
  - **West:** `-x`
  - *Example:* "the north wall" of a room is at its `-z` edge.
- **Node IDs:** Server-assigned immutable IDs (`box_1`, `cylinder_1`, `freeform_1`, `ramp_1`, `group_1`, `instance_1`). Never invent or reuse IDs.
- **Undo History:** Every tool call that modifies the scene creates one atomic step in the undo history shared with the human in the 3D editor.

## 2. Shapes & Geometry
- **`box` (Default):** Centered at `(x, z)`, rising from `y` to `y + height`. Sized with `width` (local x) and `depth` (local z), rotated by `rotation` (degrees CCW).
- **`cylinder`:** Inscribed in `width × depth`. Set `sides` (3 to 64) for regular polygon prisms (hexagons, octagons) or omit for smooth curves.
- **`freeform`:** Closed polygon path with 2D points and bezier handles in world x/z, with `y` and `height`.
- **`hole`:** Any closed shape marked with `kind: "hole"` that cuts near shapes in the hierarchy (doors, windows, archways, floor drops).
- **`ramp`:** Walkways, straight stairs, landings, or spiral stairs. Follows a centerline path with `width` and height changes.
- **`line`:** Open annotations, patrol paths, player jump arcs, arrows.
- **`note`:** Post-it pinned to a 3D point (`x, y, z`) with work items or intents (`open` / `done`).

## 3. Entities (Prefabs)
- Prefabs shared across scenes (e.g. `human` (1.8m scale reference), `torch`, `tree`, `pillar`).
- Created with `make_entity`, placed in scenes as `instance` nodes with position and rotation.

## 4. Design Workflow
1. **Outline & Context:** Call `get_scene` to inspect the level structure, open project, and visible area.
2. **Design Guide:** Call `get_guide design` to read the game's specific facts, jump distances, player size, and aesthetic rules.
3. **Inspect Nodes:** Use `find_nodes` to find specific landmarks or selection (`scene.selection`).
4. **Build & Iterate:** Use `draw_shapes` to create rooms, `move_nodes` / `rotate_nodes` to manipulate them, and `update_nodes` to tune properties.
5. **Review Sightlines:** Check sightlines and critical paths with `render_view` (`view: "plan"`, `view: "eye"`, or `view: "walk"`).

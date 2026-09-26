# Dungeon Designer

An ideation tool for dungeon layouts: a local web editor, a local server that owns the scene, and an MCP server so Claude Code can read and edit the same scene. See `plans/` for the vision (`00-initial`), the finished phases (`01-first-playable` with `01B-first-playable-refinements`, `02-basic-3d-editing`) and the current one (`03-UX-improvements`). Each phase plan logs its progress in a final Progress section. Use the terms in `GLOSSARY.md` when naming things, and add new terms there.

## Running

- `npm run dev` starts one process on http://127.0.0.1:5170 that serves the editor, the editor WebSocket (`/ws`) and the MCP endpoint (`/mcp`).
- **Start the server before starting Claude Code.** If the `dungeon-designer` MCP server shows as failed, start the server and reconnect with `/mcp`.
- `PORT=5171 npm run dev` runs a second instance on another port, for scripted checks that shouldn't touch the main one.
- `npm test` runs the unit tests, and `npm run typecheck` runs the type checker.

## Working with the scene

- To read or change the scene, use the `dungeon-designer` MCP tools (`get_scene`, `draw_boxes`, `update_nodes`, `remove_nodes`, `move_nodes`, `rotate_nodes`, `group_nodes`, `ungroup`). Don't edit files to draw.
- Coordinates are world units (`u` = meters), not pixels. The world is 3D with y up and the ground at y = 0. The scene holds **boxes**: a room (hollow) or a volume (solid). A box's footprint is **centered** at `x, z`, with `width` along its local x and `depth` along its local z. It rises from its elevation `y` (its bottom: 0 = on the ground, negative = below) to `y + height`. `rotation` is in degrees around the vertical axis through the center, counterclockwise seen from above. `color` is a palette key, and `name` is an optional, non-unique label. IDs are `box_1`, `box_2`, ..., never reused, and they're how the other tools refer to a box. Every tool call is one step in the undo history the human shares with the agent. The editor is a 3D view seen from a fixed pitch, rotating only by yaw.
- The scene's `nodes` is one flat list of boxes and **groups** (`group_1`, ...). A node is in a group when its `parent` is that group's ID. Groups have no position of their own: boxes keep absolute coordinates, and `get_scene` reports each group's derived `bounds`. To move or turn a group, use `move_nodes` / `rotate_nodes` on it (one call, one undo step).
- `scene.selection` lists the node IDs the human has selected in the editor, so "this" means those nodes.
- The scene's `view` is what the editor currently shows: `focus` (ground point at the screen center), `yaw` (degrees) and `bounds` (the axis-aligned box around the visible ground, `x, z` at its min corner). Before a browser connects it's focus 0,0, yaw 45, bounds -30..30 × -20..20.
- The scene is in memory only, so restarting the server clears it.

## Code layout

- `src/shared/`: types and zod schemas shared by the server and the editor, plus pure box geometry (`geometry.ts`) and node-tree helpers (`tree.ts`).
- `src/server/scene.ts`: the scene store. It's the single code path for edits, used by both the WebSocket and MCP. Every edit goes through `commit` as one undoable command.
- `src/server/commands.ts`: ops, their inverses and the shared linear history (pure, no server dependencies).
- `src/server/{ws,mcp,main}.ts`: transports and wiring.
- `src/web/`: the React + three.js (react-three-fiber) editor. `camera.ts` holds the pure camera math.

# Dungeon Designer

An ideation tool for dungeon layouts: a local web editor, a local server that owns the scene, and an MCP server so Claude Code can read and edit the same scene. See `plans/` for the vision (`00-initial`) and the current phase (`01-first-playable`, refinements logged in `01B-first-playable-refinements`). Use the terms in `GLOSSARY.md` when naming things, and add new terms there.

## Running

- `npm run dev` starts one process on http://127.0.0.1:5170 that serves the editor, the editor WebSocket (`/ws`) and the MCP endpoint (`/mcp`).
- **Start the server before starting Claude Code.** If the `dungeon-designer` MCP server shows as failed, start the server and reconnect with `/mcp`.
- `PORT=5171 npm run dev` runs a second instance on another port, for scripted checks that shouldn't touch the main one.
- `npm test` runs the unit tests, and `npm run typecheck` runs the type checker.

## Working with the scene

- To read or change the scene, use the `dungeon-designer` MCP tools (`get_scene`, `draw_boxes`, `update_boxes`). Don't edit files to draw.
- Coordinates are world units (`u` = meters), not pixels. The world is 3D with y up and the ground at y = 0. The scene holds **boxes**: a room (hollow) or a volume (solid) standing on the ground, with its footprint `x, z` at the min corner, `width` along +x, `depth` along +z, and a `height`. IDs are per kind (`room_1`, `volume_1`) and are how `update_boxes` refers to a box. Every tool call is one step in the undo history the human shares with the agent. The editor is a 3D view seen from a fixed pitch, rotating only by yaw.
- The scene's `view` is what the editor currently shows: `focus` (ground point at the screen center), `yaw` (degrees) and `bounds` (the axis-aligned box around the visible ground). Before a browser connects it's focus 0,0, yaw 45, bounds -30..30 × -20..20.
- The scene is in memory only, so restarting the server clears it.

## Code layout

- `src/shared/`: types and zod schemas shared by the server and the editor.
- `src/server/scene.ts`: the scene store. It's the single code path for edits, used by both the WebSocket and MCP. Every edit goes through `commit` as one undoable command.
- `src/server/commands.ts`: ops, their inverses and the shared linear history (pure, no server dependencies).
- `src/server/{ws,mcp,main}.ts`: transports and wiring.
- `src/web/`: the React + three.js (react-three-fiber) editor. `camera.ts` holds the pure camera math.

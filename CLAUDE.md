# Dungeon Designer

An ideation tool for dungeon layouts: a local web editor, a local server that owns the scene, and an MCP server so Claude Code can read and edit the same scene. See `plans/` for the vision (`00-initial`) and the current phase (`01-first-playable`, refinements logged in `01B-first-playable-refinements`). Use the terms in `GLOSSARY.md` when naming things, and add new terms there.

## Running

- `npm run dev` starts one process on http://127.0.0.1:5170 that serves the editor, the editor WebSocket (`/ws`) and the MCP endpoint (`/mcp`).
- **Start the server before starting Claude Code.** If the `dungeon-designer` MCP server shows as failed, start the server and reconnect with `/mcp`.
- `PORT=5171 npm run dev` runs a second instance on another port, for scripted checks that shouldn't touch the main one.
- `npm test` runs the unit tests, and `npm run typecheck` runs the type checker.

## Working with the scene

- To read or change the scene, use the `dungeon-designer` MCP tools (`get_scene`, `draw_rects`). Don't edit files to draw.
- Coordinates are world units (`u` = meters), not pixels. The editor is a 3D view of the ground plane (x/z, y up) seen from a fixed pitch, rotating only by yaw. During phase 02 rects still exist and lie flat on the ground: rect `x` → ground x, rect `y` → ground z.
- The scene's `view` is what the editor currently shows: `focus` (ground point at the screen center), `yaw` (degrees) and `bounds` (the axis-aligned box around the visible ground). Before a browser connects it's focus 0,0, yaw 45, bounds -30..30 × -20..20.
- The scene is in memory only, so restarting the server clears it.

## Code layout

- `src/shared/`: types and zod schemas shared by the server and the editor.
- `src/server/scene.ts`: the scene store. It's the single code path for edits, used by both the WebSocket and MCP.
- `src/server/{ws,mcp,main}.ts`: transports and wiring.
- `src/web/`: the React + three.js (react-three-fiber) editor. `camera.ts` holds the pure camera math.

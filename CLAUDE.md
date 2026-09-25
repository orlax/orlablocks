# Dungeon Designer

An ideation tool for dungeon layouts: a local web editor, a local server that owns the scene, and an MCP server so Claude Code can read and edit the same scene. See `plans/` for the vision (`00-initial`) and the current phase (`01-first-playable`, refinements logged in `01B-first-playable-refinements`). Use the terms in `GLOSSARY.md` when naming things, and add new terms there.

## Running

- `npm run dev` starts one process on http://127.0.0.1:5170 that serves the editor, the editor WebSocket (`/ws`) and the MCP endpoint (`/mcp`).
- **Start the server before starting Claude Code.** If the `dungeon-designer` MCP server shows as failed, start the server and reconnect with `/mcp`.
- `npm test` runs the unit tests, and `npm run typecheck` runs the type checker.

## Working with the scene

- To read or change the scene, use the `dungeon-designer` MCP tools (`get_scene`, `draw_rects`). Don't edit files to draw.
- Coordinates are world units (`u`), not pixels. 1 u = 20 px at default zoom. x/y is the top-left corner and +y points down. The scene's `view` is the area currently visible in the editor window. It follows the window size, and the default before a browser connects is 0..60 × 0..40.
- The scene is in memory only, so restarting the server clears it.

## Code layout

- `src/shared/`: types and zod schemas shared by the server and the editor.
- `src/server/scene.ts`: the scene store. It's the single code path for edits, used by both the WebSocket and MCP.
- `src/server/{ws,mcp,main}.ts`: transports and wiring.
- `src/web/`: the React + SVG editor.

# orlablocks

A dungeon-layout ideation tool: a local web editor and MCP server share one server-owned scene.

## Development workflow

- Read the requested phase/subphase in `plans/`, its referenced thinking document, and latest Progress entries. Read earlier plans only when relevant. Plans own status, decisions and acceptance requirements; `plans/00-initial` holds the vision.
- Current checkpoint: `plans/16-terrains` 16.1–16.4 are implemented; scratch browser/Unity checks passed. Orlando's visual acceptance in his own project remains open. Terrain-aware walking and surface queries are a separate follow-up (§10).
- Complete the subphase's required checks. Record decisions, relevant files, checks performed, remaining acceptance and next steps in the plan's Progress section so a fresh chat can continue. Distinguish automated verification from Orlando's acceptance.
- Use `GLOSSARY.md` terminology and add new terms there.
- Keep changes within the requested phase; respect its explicit deferrals.

## Running and verification

- `npm run dev` serves the editor at http://127.0.0.1:5170, WebSocket `/ws` and MCP `/mcp`. Start it before connecting Codex; reconnect with `/mcp` if MCP failed.
- Data lives in `./data` or `DATA_DIR`. Dev reads the gitignored `.env`; shell variables win. A lock prevents two servers sharing a data folder.
- Use `PORT=5171 DATA_DIR=<scratch>/data npm run dev` for isolated checks. Always use a separate scratch data folder; never use the main project's data for fixtures.
- `npm test` runs unit tests; `npm run typecheck` checks types. Follow the phase's browser/Unity checklist; Unity importer changes compile with `scripts/compile-unity.sh` where available.

## Scene work

- Read/change scenes through orlablocks MCP tools or the editor. Never read or edit files under `data/` or the configured data folder directly. Every scene edit is saved and shares the human's undo history.
- Before designing, read `get_scene` and `get_guide design`. Use `find_nodes` and scoped outlines instead of requesting the entire scene unnecessarily. Read the relevant `get_guide` topic for tool/shape details (including `terrains`); `get_guide review` covers level-design review.
- Treat open notes and captioned shots as human requirements. Mark handled notes done instead of removing them. Inspect work with `render_view`; use `get_shots` for saved requirements. Keep detail proportional to gameplay.
- “This” refers to `scene.selection`. Respect `view.isolated`, locked and hidden nodes unless asked to change them. Check `editing`: Edit entity mode changes the definition and every instance.
- Repeat entities with one array; repeat other geometry with `move_nodes` and `copy: true` (`count` for rows). Use `mirror_nodes` for symmetry. Move/rotate groups with their tools; reuse the returned rotation pivot for an exact inverse.
- Coordinates are meters, y up, north −z, east +x. Boxes/cylinders are centered at x/z; y is their bottom. Groups have no independent position and children keep absolute coordinates. Consult guides for free-form/ramp geometry, holes, transforms and dependencies.
- Tags must exist in the project library before assignment. Library and entity-definition histories are separate from scene history. Prefer compact tool results; request verbose results only when needed.

## Code entry points

- `src/shared/`: schemas, geometry/meshes, tree/holes, entities/arrays, shared baking and terrain evaluation.
- `src/server/scene.ts`: single edit path for WS and MCP; `commit` makes one undoable command. `commands.ts` owns ops/inverses; `workspace.ts` and `persist.ts` own saving.
- `src/server/outline.ts`, `guide.ts`, `mcp.ts`: agent reads, documentation and tools. `library.ts` owns library history.
- `src/web/`: React/three.js editor, inspector, gizmos, captures, Walk and panels. `src/ui/` shares theme/fonts/wordmark with `src/control-panel/`; `src-tauri/` packages the Control Panel.
- `src/shared/bake.ts`/`bakeScene.ts` and server `export.ts`/`gltf.ts` share rendered/exported geometry. `unity/Orlablocks/` owns Unity sync; read its README for checks.
- For a detailed file map or scene conventions, load the relevant section of `docs/agent-reference.md` on demand. Avoid loading the entire reference for unrelated code tasks.

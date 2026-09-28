# orlablocks

A 3D blockout editor for game levels, built to be co-edited by a human and an AI agent.

The human draws in a browser editor. The agent (Claude Code, or any MCP client) reads and edits the same scene through an MCP server. Both share one undo history. Beyond geometry, a scene carries **semantics**: descriptions, notes, tags, skills and a design guide. These tell the agent what the level is for, not just where things are.

## What's in it

- **Shapes**: boxes, cylinders, free-forms (bezier outlines), ramps and stairs, lines (annotations).
- **Kinds**: every closed shape is a *room* (hollow, with walls), a *volume* (solid, with optional taper, bevel and tilt) or a *hole* (cuts doors, windows and floor openings out of nearby shapes).
- **Groups** with descriptions. **Entities** (prefabs) with instances that follow their definition.
- **Notes**: post-its pinned in the scene, marked open or done. Open notes tell the agent what the human wants.
- **Library** (per project): `#tags` (properties), `@skills` (player abilities) and a markdown **design guide** (taste, game facts, house rules).
- **Projects → scenes**, saved to disk on every edit.

## Run

Requires Node 22+.

```sh
npm install
npm run dev          # editor, WebSocket and MCP on http://127.0.0.1:5170
```

Open http://127.0.0.1:5170 and create a project.

Data is saved in `./data` (or set `DATA_DIR`). A lock file stops two servers from sharing one folder.

## Use with Claude Code

`.mcp.json` registers the `orlablocks` MCP server (`http://127.0.0.1:5170/mcp`).

1. Start the server first.
2. Run `claude` in the repo. If the server shows as failed, run `/mcp` to reconnect.
3. Ask for a layout. The agent reads the scene (`get_scene`, `find_nodes`, `get_guide design`) and edits it (`draw_shapes`, `update_nodes`, `move_nodes`, `mirror_nodes`, `make_entity`, ...). Changes appear in the editor live.

Selecting nodes in the editor tells the agent what "this" means.

## Editor keys

| Key | Tool | | Key | Action |
|---|---|---|---|---|
| `V` | Select | | `⌘Z` / `⇧⌘Z` | Undo / redo |
| `H` | Hand (or hold `Space`) | | `⌘G` / `⇧⌘G` | Group / ungroup |
| `B` | Box | | `⌘C` `⌘X` `⌘V` | Copy / cut / paste |
| `C` | Cylinder | | `⇧X` / `⇧Z` | Mirror on x / z |
| `P` | Pen (free-form) | | `I` | Isolate selection |
| `L` | Line | | `Delete` | Remove |
| `R` | Ramp / stairs | | `Esc` | Deselect / exit |
| `N` | Note | | | |

Units are meters. Y is up. North is −z.

## Develop

```sh
npm test             # unit tests
npm run typecheck
```

- `src/shared/`: types, schemas, geometry, meshes.
- `src/server/`: scene store, history, persistence, MCP and WebSocket.
- `src/web/`: React + three.js editor.
- `plans/`: design docs, one per phase. `GLOSSARY.md`: the terms used.

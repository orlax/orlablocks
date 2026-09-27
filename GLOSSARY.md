# Glossary

Shared vocabulary for this project, for humans and agents alike. Use these names in code, plans and conversation. Add terms as they come up, keep entries short, and sort each section alphabetically.

## Editor UI

- **Alt-drag (copy)**: holding `Alt` on a move drag (the body, the x/z arrows, the y arrow) copies instead of moving: the originals stay, and the copies follow the cursor with the selection highlight and a `· copy` label. `Alt` counts at release, so it can be pressed or released mid-drag. On the y arrow a copy snaps onto the originals' tops (a second floor). The copies become the selection. Scale handles and drawing keep `Alt` = from the center (from 05).
- **box tool**: `B`, drags boxes on the ground with the kind and color from the contextual bar. `Shift` makes the footprint square, `Alt` draws from the center, and `Cmd/Ctrl` turns off snap. Drawing never changes the selection, and the tool stays Box. Replaces the separate room and volume tools (from 03).
- **camera**: the 3D perspective camera with a narrow (30°) field of view, so perspective stays mild (from 02). Its pitch is fixed, it orbits the focus point with yaw only, and zoom moves it toward the focus point.
- **canvas**: the full-window 3D drawing surface (the viewport). It fills the whole browser window.
- **contextual bar**: the bar that floats just above the tool-bar. In the Box tool it sets the next box's kind and color. In the Select tool it edits the selection: kind for a single box, color for all selected boxes, plus read-only numbers (from 03).
- **draft**: the live preview of a box while you drag its footprint, drawn lighter, with a `W × D m` label next to the cursor. `Esc` cancels it.
- **entered group**: the group you've double-clicked into. Clicks, the marquee and `Cmd/Ctrl+A` then act on its children, and the contextual bar says `in lobby › …`. `Esc` or clicking outside it leaves it (from 03).
- **focus point**: the ground point under the center of the screen. The camera orbits it and pans move it (from 02).
- **graybox**: the look of the view: warm near-white matte materials with a 1 m tile texture, a sun with soft shadows and faint outlines, like a blocked-out game level.
- **grid**: the reference lines on the ground plane: a line every 1 m and a stronger one every 5 m, fading out away from the focus point. It's a measuring and snapping aid only and is never part of the scene data.
- **hand tool**: `H`, navigation only: drag to pan and scroll to zoom toward the focus point. Holding `Space` switches to it temporarily from any tool (from 03; in 02 it also selected).
- **height handle**: the small yellow cube on the top center of a single selected box, part of the transform gizmo. Dragging it changes the box's height with the bottom fixed, in 0.05 m steps (`Cmd/Ctrl` for free), with a live `h … m` label. It replaces 02's height gizmo (the blue stem and cone) (from 03).
- **info-label**: the status bar docked along the bottom edge, full width, one line: the connection state, the cursor's ground position (x · z), the camera yaw, the room and volume counts, and the current tool's hint on the right (a short notice, in yellow, can replace the hint for a moment). The numbers are fixed-width so it never jitters. The 3D view ends above it (a small top-right box before 03, a floating row across the top from 03, the bottom bar from 05, when the project bar moved out of it).
- **marquee**: the rectangle you drag on empty ground with the Select tool to select every box it touches on screen (its exact outline, not its bounds), live as you drag. `Shift` adds to the selection and `Esc` restores the selection it started from (from 03).
- **origin axes**: a marker at the world origin, with +x as a red bar, +y as a green bar and +z as a blue bar (the gizmo's colors), for orientation while rotating.
- **outliner**: the collapsible tree panel on the left listing every node by name (or ID) with a room / volume / group icon. Click selects (`Shift` or `Cmd/Ctrl` toggles), double-click renames, dragging a row drops it before, after or into a group, and hovering a row highlights it in the view (from 03).
- **project bar**: `Castle ▸ Entrance`, the button at the top left, above the outliner, as wide as the names need (at least the outliner's width, at most 640 px): the open project and scene. Clicking it opens the project picker (from 04; its own button from 05, first in the info-label before).
- **project picker**: the modal for projects and scenes: projects on the left (double-click renames, **New project** shows the create project form), and the selected project's description and scenes on the right. Clicking a scene opens it for every tab and the agent. Each scene row has rename and duplicate buttons on hover, and a duplicate copies the history and opens the copy. With nothing open it can't be dismissed, and with no projects at all it's only the **create project** form (name, description, first scene) (from 04).
- **repeat copy (`Alt+J`)**: copies the current selection by the last Alt-drag copy's offset and selects the copies, so pressing it again continues a row. The offset is remembered per tab and forgotten when the scene changes. With nothing to repeat, the info-label says "Alt-drag a copy first" (from 05).
- **rotate handle**: the purple, nearly closed ring just outside a top corner of the selection (a single box's own corner, so it turns with it). Dragging it rotates the selection around its center: 15° snaps (whole angles for one box, the change for several), `Cmd/Ctrl` for free, with a live angle label (from 03).
- **scale handles**: the 8 small white squares on the corners and edge midpoints of a single selected box's top face, turned with the box. Dragging one resizes the box in its own axes with the opposite side fixed: `Shift` keeps the aspect ratio, `Alt` scales from the center, `Cmd/Ctrl` turns off snap (from 03).
- **select tool**: `V`, click to select (`Shift`-click adds or removes), drag a box to move the selection, drag empty ground for a marquee, `Cmd/Ctrl+A` selects all. It pans only with `Space` or the middle button (from 03).
- **selection**: the nodes currently selected in the editor, highlighted with a blue tint and outline (a group highlights all its boxes; hovering what a click would select tints it yellow) and described in the contextual bar. The Select tool selects on click (the outermost group, or inside an **entered group** its child), `Esc` deselects, `Delete` removes the selection, and drawing never changes it (from 03). It's also reported to the server as **selection (scene)**.
- **tool-bar**: the floating bar at the bottom center, with a margin from the window edges and the info-label. It holds only controls: the big icon tool buttons (Select, Hand, Box, with the shortcut letter in the corner), then Undo, Redo and Clear icon buttons. Counts and hints live in the info-label (from 03).
- **transform gizmo**: the handles on the selection, in the Select tool only: body drag and x/z arrows to move, a y arrow to raise, 8 footprint handles and a height handle to scale, a rotate handle (from 03). Replaces the height gizmo.
- **yaw**: rotation of the camera around the vertical axis through the focus point. It's the only rotation the camera has (A/D or ←/→).

## Scene and data

- **actor**: who made a change, either `human` (the editor) or `agent` (MCP). Stored on each box as `createdBy`. Not shown in the view since the graybox look.
- **box**: a footprint plus a height: `{ id, type: "box", name?, kind, x, z, y, width, depth, height, rotation, color, createdBy }` in meters. `x, z` is the footprint's **center** (from 03, it was the min corner in 02), `width` and `depth` run along the box's own axes, and it rises from `y` to `y + height`. Its kind is either **room** or **volume** and can change. Its ID is `box_N`, never reused (from 03, it was per kind in 02).
- **command**: one user-level edit and one undo step. It's made of ops, records its actor, and stores its inverse (from 02).
- **copy (duplicate)**: a node copied with its whole subtree: new IDs, the same names, structure and parent group, offset by `dx, dy, dz` (`count` copies make a row, copy i offset i times). It goes right after its original in the list, and every copy call is one step (`Copy group_1 ×3`). The store's `duplicateNodes`, the `duplicate_nodes` message, and `move_nodes` with `copy: true` for the agent (from 05).
- **data folder**: where the server saves everything: `./data` where it runs (gitignored), or `DATA_DIR`. It holds `app.json` (the last open scene), `projects/`, and a `.lock` so only one server uses it (from 04).
- **editor state**: a scene's `editor.json`: the camera (focus, yaw, zoom distance) and the selection. It's written 500 ms after they stop changing, and right away before switching scenes or stopping the server. It's restored when the scene opens. It isn't design data and isn't undoable (from 04).
- **elevation (`y`)**: the height of a box's bottom above the ground, in meters. 0 = on the ground; negative is below ground (from 03).
- **group**: a node that contains other nodes (via their `parent`), with ID `group_N`. It has no position of its own: its bounds come from its boxes (`get_scene` reports them as `bounds`), and moving, rotating or deleting it acts on everything inside as one command. A group left empty disappears in the same command (from 03).
- **history**: the single linear list of commands shared by the human and the agent. Undo reverts the latest command, whoever made it (from 02) From 04 it's per scene and survives restarts, rebuilt from the **history log**.
- **history log**: a scene's `history.jsonl`, append-only, one line per step (`commit` with its ops and inverse, `undo`, `redo`), numbered by `seq`. `scene.json` records the `seq` it includes. The log is written first, so after a crash it can be one step ahead, and opening the scene applies that step (from 04).
- **name**: an optional human-friendly label on any node ("lobby"). Not unique. Tools still take IDs (from 03).
- **node**: anything in the scene's flat list: a box or a group. Each has an `id`, an optional `name` and an optional `parent` (from 03).
- **op**: the smallest reversible scene change (`add`, `remove`, `update`, and `order` for the outliner's reordering) inside a command.
- **palette**: the fixed set of color keys a box can use: the neutrals `white` (#ffffff), `almost-white` (#ededed, the default) and `gray` (#c4c4c4), plus pastels (`blue`, `yellow`, ...). The keys are the contract, and the pastel hex values are tuned freely (from 03).
- **room**: a hollow box: a floor slab and walls, no ceiling. It will later hold openings like doors and windows. Default height 3 m. Its walls are drawn 0.2 m thick, centered on the footprint edge (see **wall thickness**).
- **rotation**: a box's turn around the vertical axis through its center, in degrees, counterclockwise seen from above. 0 = grid-aligned (from 03).
- **open scene**: the one scene the server has open, shared by every tab and the agent, or none. Undo acts within it (from 04).
- **project**: a folder of scenes for one game, with a name and a description the agent reads. Its ID is a slug of its name at creation, and it holds `scenes/` plus the empty semantic folders `abilities/`, `entities/` and `rules/` (from 04).
- **scene**: the full design state the server owns: the `view`, the `selection` and all nodes (`scene.nodes`, from 03). The editor and the agent both read and edit the same scene. From 04 it's one scene (one level) of a project, saved on disk in `scenes/<id>/scene.json` after every step, and its ID is a slug of its name at creation.
- **selection (scene)**: the IDs of the selected nodes, reported in `scene.selection` so the agent knows what "this" means. Last tab wins, not undoable (from 03).
- **snap**: rounding a drawn footprint to the nearest 0.5 m. On by default, and holding `Cmd/Ctrl` while drawing turns it off (from 03; `Alt` in 02).
- **snap (vertical)**: rounding heights to the nearest 0.05 m. It's also the minimum height (from 02).
- **view**: what the editor currently shows: the focus point, the yaw and `bounds`, the axis-aligned box around the visible ground. The editor reports it to the server so the agent knows where to draw.
- **volume**: a solid box, something you stand on or bump into. Default height 0.25 m.
- **wall thickness**: 0.2 m, centered on the footprint edge, so rooms that share an edge read as one wall. Rendering only: the footprint in the data is the wall centerline.
- **world unit (u)**: the coordinate unit of the scene. It's abstract for now and becomes meters in 02 (1 u = 1 m). At default zoom 1 u = 20 px. The data never stores pixels.

## System

- **MCP server / tools**: the `/mcp` endpoint Claude Code connects to. Current tools: `get_scene`, `draw_boxes`, `update_nodes`, `remove_nodes`, `move_nodes` (with `copy`, from 05), `rotate_nodes`, `group_nodes`, `ungroup`.
- **server instructions**: the conventions text (units, boxes, groups, IDs, the view, copying) the MCP server sends once when a client connects, instead of repeating it in every tool description (from 05).
- **server**: the single local process (`npm run dev`) that owns the open scene, saves it in the data folder, and serves the editor, the WebSocket (`/ws`) and MCP (`/mcp`).

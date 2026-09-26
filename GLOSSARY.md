# Glossary

Shared vocabulary for this project, for humans and agents alike. Use these names in code, plans and conversation. Add terms as they come up, keep entries short, and sort each section alphabetically.

## Editor UI

- **camera**: the 3D perspective camera with a narrow (30°) field of view, so perspective stays mild (from 02). Its pitch is fixed, it orbits the focus point with yaw only, and zoom moves it toward the focus point.
- **canvas**: the full-window 3D drawing surface (the viewport). It fills the whole browser window.
- **draft**: the live preview of a box while you drag its footprint, drawn lighter, with a `W × D m` label next to the cursor. `Esc` cancels it.
- **focus point**: the ground point under the center of the screen. The camera orbits it and pans move it (from 02).
- **graybox**: the look of the view: warm near-white matte materials with a 1 m tile texture, a sun with soft shadows and faint outlines, like a blocked-out game level.
- **grid**: the reference lines on the ground plane: a line every 1 m and a stronger one every 5 m, fading out away from the focus point. It's a measuring and snapping aid only and is never part of the scene data.
- **hand tool**: drag to pan, scroll to zoom toward the focus point, click without dragging to select a box (from 02).
- **height gizmo**: the single handle on top of the selected box. Dragging it changes the box's height (from 02).
- **info-label**: the small fixed-width label at the top right. It shows the connection state, the cursor's ground position (x · z) and the camera yaw. It has a fixed width and fixed-width text so it never jitters.
- **origin axes**: a marker at the world origin, with +x as a red bar and +z as a blue bar, for orientation while rotating.
- **room tool / volume tool**: drag on the ground to draw a room or a volume at its default height. `Shift` makes the footprint square, and `Alt` turns off snap.
- **selection**: the box currently selected in the editor. It's editor-local and never part of the scene (from 02).
- **tool-bar**: the floating bar at the bottom center, with a margin from the window edges. It holds the tools (Hand, Room, Volume) and scene-level state (legend, room and volume counts, a hint for the current tool, Clear).
- **yaw**: rotation of the camera around the vertical axis through the focus point. It's the only rotation the camera has (A/D or ←/→).

## Scene and data

- **actor**: who made a change, either `human` (the editor) or `agent` (MCP). Stored on each box as `createdBy`. Not shown in the view since the graybox look.
- **box**: a footprint on the ground plus a height: `{ id, kind, x, z, width, depth, height, createdBy }` in meters, with `x, z` at the footprint's min corner. Its kind is either **room** or **volume**, and its ID is per kind (`room_1`, `volume_1`).
- **command**: one user-level edit and one undo step. It's made of ops, records its actor, and stores its inverse (from 02).
- **history**: the single linear list of commands shared by the human and the agent. Undo reverts the latest command, whoever made it (from 02).
- **op**: the smallest reversible scene change (`add`, `remove`, `update`) inside a command (from 02).
- **room**: a hollow box: a floor slab and walls, no ceiling. It will later hold openings like doors and windows. Default height 3 m. Its walls are drawn 0.2 m thick, centered on the footprint edge (see **wall thickness**).
- **scene**: the full design state the server owns: the `view` plus all boxes. The editor and the agent both read and edit the same scene.
- **snap**: rounding a drawn footprint to the nearest 0.5 m. On by default, and holding `Alt` while drawing turns it off.
- **snap (vertical)**: rounding heights to the nearest 0.05 m. It's also the minimum height (from 02).
- **view**: what the editor currently shows: the focus point, the yaw and `bounds`, the axis-aligned box around the visible ground. The editor reports it to the server so the agent knows where to draw.
- **volume**: a solid box, something you stand on or bump into. Default height 0.25 m.
- **wall thickness**: 0.2 m, centered on the footprint edge, so rooms that share an edge read as one wall. Rendering only: the footprint in the data is the wall centerline.
- **world unit (u)**: the coordinate unit of the scene. It's abstract for now and becomes meters in 02 (1 u = 1 m). At default zoom 1 u = 20 px. The data never stores pixels.

## System

- **MCP server / tools**: the `/mcp` endpoint Claude Code connects to. Current tools: `get_scene`, `draw_boxes`.
- **server**: the single local process (`npm run dev`) that owns the scene and serves the editor, the WebSocket (`/ws`) and MCP (`/mcp`).

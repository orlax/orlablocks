# Glossary

Shared vocabulary for this project, for humans and agents alike. Use these names in code, plans and conversation. Add terms as they come up, keep entries short, and sort each section alphabetically.

## Editor UI

- **camera**: the orthographic 3D camera (from 02). Its pitch is fixed and it orbits the focus point with yaw only.
- **canvas**: the full-window SVG drawing surface. It fills the whole browser window.
- **focus point**: the ground point under the center of the screen. The camera orbits it and pans move it (from 02).
- **grid**: the reference lines drawn on the canvas: a line every 1 u and a stronger one every 5 u. It's a measuring and snapping aid only and is never part of the scene data.
- **hand tool**: drag to pan, scroll to zoom toward the focus point, click without dragging to select a box (from 02).
- **height gizmo**: the single handle on top of the selected box. Dragging it changes the box's height (from 02).
- **info-label**: the small fixed-width label at the top right. It shows status text such as the connection state and the current cursor coordinates. It has a fixed width and fixed-width text so it never jitters.
- **selection**: the box currently selected in the editor. It's editor-local and never part of the scene (from 02).
- **tool-bar**: the floating bar at the bottom center, with a margin from the window edges. It holds tools and scene-level state (legend, rect count, drawing hint, Clear).
- **yaw**: rotation of the camera around the vertical axis through the focus point. It's the only rotation the camera has (A/D or ←/→).

## Scene and data

- **actor**: who made a change, either `human` (the editor) or `agent` (MCP). Stored on each rect as `createdBy`.
- **box**: a footprint on the ground plus a height, with a server-assigned ID. Its kind is either **room** or **volume** (from 02).
- **command**: one user-level edit and one undo step. It's made of ops, records its actor, and stores its inverse (from 02).
- **history**: the single linear list of commands shared by the human and the agent. Undo reverts the latest command, whoever made it (from 02).
- **op**: the smallest reversible scene change (`add`, `remove`, `update`) inside a command (from 02).
- **rect**: the only shape so far, an axis-aligned rectangle: `{ id, x, y, width, height, createdBy }` in world units, with `x, y` at the top-left corner. A square is just a rect with equal sides. Holding `Shift` while drawing forces one. Replaced by **box** in 02.2.
- **room**: a hollow box (floor and walls, no ceiling). It will later hold openings like doors and windows. Default height 3 m.
- **scene**: the full design state the server owns: the `view` plus all rects. The editor and the agent both read and edit the same scene.
- **snap**: rounding a drawn position or size to the nearest 0.5 u. On by default, and holding `Alt` while drawing turns it off.
- **snap (vertical)**: rounding heights to the nearest 0.05 m. It's also the minimum height (from 02).
- **view**: the rectangle of world space currently visible in the editor window. The editor reports it to the server so the agent knows where to draw.
- **volume**: a solid box, something you stand on or bump into. Default height 0.25 m.
- **world unit (u)**: the coordinate unit of the scene. It's abstract for now and becomes meters in 02 (1 u = 1 m). At default zoom 1 u = 20 px. The data never stores pixels.

## System

- **MCP server / tools**: the `/mcp` endpoint Claude Code connects to. Current tools: `get_scene`, `draw_rects`.
- **server**: the single local process (`npm run dev`) that owns the scene and serves the editor, the WebSocket (`/ws`) and MCP (`/mcp`).

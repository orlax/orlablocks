# Glossary

Shared vocabulary for this project, for humans and agents alike. Use these names in code, plans and conversation. Add terms as they come up, keep entries short, and sort each section alphabetically.

## Editor UI

- **canvas**: the full-window SVG drawing surface. It fills the whole browser window.
- **grid**: the reference lines drawn on the canvas: a line every 1 u and a stronger one every 5 u. It's a measuring and snapping aid only and is never part of the scene data.
- **info-label**: the small fixed-width label at the top right. It shows status text such as the connection state and the current cursor coordinates. It has a fixed width and fixed-width text so it never jitters.
- **tool-bar**: the floating bar at the bottom center, with a margin from the window edges. It holds tools and scene-level state (legend, rect count, drawing hint, Clear).

## Scene and data

- **actor**: who made a change, either `human` (the editor) or `agent` (MCP). Stored on each rect as `createdBy`.
- **scene**: the full design state the server owns: the `view` plus all rects. The editor and the agent both read and edit the same scene.
- **rect**: the only shape so far, an axis-aligned rectangle: `{ id, x, y, width, height, createdBy }` in world units, with `x, y` at the top-left corner. A square is just a rect with equal sides. Holding `Shift` while drawing forces one.
- **snap**: rounding a drawn position or size to the nearest 0.5 u. On by default, and holding `Alt` while drawing turns it off.
- **view**: the rectangle of world space currently visible in the editor window. The editor reports it to the server so the agent knows where to draw.
- **world unit (u)**: the coordinate unit of the scene. It's abstract for now and meant to become meters. At default zoom 1 u = 20 px. The data never stores pixels.

## System

- **MCP server / tools**: the `/mcp` endpoint Claude Code connects to. Current tools: `get_scene`, `draw_rects`.
- **server**: the single local process (`npm run dev`) that owns the scene and serves the editor, the WebSocket (`/ws`) and MCP (`/mcp`).

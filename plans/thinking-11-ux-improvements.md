A conversation report I had with Gemini 4 Argon after a working session: 

1. Evaluating Your Two Ideas
A. Floorless Rooms (floor: false) + Arc/Ring Support

Verdict: High-impact—and solves an editor UX bug you hit yourself.

What went wrong today: Both the 2nd-floor horseshoe gallery (ramp_70) and 3rd-floor mezzanine (ramp_75) had to be built as flat spiral ramps (rise: 0). Because a ramp’s width expands symmetrically from its centerline, when you dragged ramp_70 wider in the editor (3.25 → 3.75), the outer edge pushed outward through the rotunda wall instead of growing inward toward the atrium.
How floor: false makes this much better:
Adding floor?: boolean (default true) on kind: "room" lets a hollow box, cylinder, or freeform act as pure perimeter walls or an inward-growing ring ledge whose outer boundary stays locked to the room’s footprint while wall controls inward width!
It also unlocks stacked tower tiers (like your Observatory cylinders), vertical shafts, parapets, and chimneys without cutting a giant floor-hole every time.
Bonus pairing: Add optional arc?: { from: number, sweep: number } on cylinder (or ring volumes). Then a horseshoe gallery (296°) or crescent mezzanine (101°) is a single native primitive (width: 21.5, height: 0.2, wall: 4.45, floor: false, arc: { from: 252, sweep: 296 })—no bezier points, and dragging wall in the UI widens the walkway purely inward.
B. Exposing Math Tools vs. Declarative Spatial Placement

Verdict: Skip a generic arithmetic calculator; add scene-aware spatial placement & queries instead.

Why I wrote 4 Python scripts today:
Polar placement (x = cx + r·cos θ, z = cz - r·sin θ) + computing inward-facing entity rotation = (θ + 90) % 360.
Rescaling ramp_70’s 5 bezier points + in/out tangent handles because update_nodes doesn’t accept spiral.
Computing chord midpoints (r·cos(Δθ/2) > r_inner) so freeform_19 (west walkway) and freeform_24 (east roof) stayed inside cylinder_27’s 0.3 m wall without poking into the interior.
Counting how many 2.03 m railings fit along an arc (count vs sweep).
Why a raw eval_math tool wouldn't be ideal: Each MCP call adds round-trip latency and tool framing tokens, the LLM can still flip -z (North) sign conventions in its formula, and baking raw (x: 10.1, z: -7.1) loses semantic intent.
What eliminates 95% of LLM math scripts with fewer tokens:
Declarative polar / wall-relative placement in draw_shapes & update_nodes: Allow at: { around: "cylinder_27", radius: 10.46, angle: 225, facing: "in" } (or on_wall: { id: "cylinder_27", angle: 225, side: "inner" }). The server computes exact (x, z, rotation) using Orlablocks' compass and entity forward axis—zero Python, zero trig mistakes, zero extra tool calls.
Accept spiral in update_nodes (not just draw_shapes): Letting update_nodes re-specify spiral: { x, z, radius, from, turn, y, rise } on an existing ramp eliminates manual bezier handle scaling and avoids deleting/recreating ramps (which breaks on / along references).
Support place: "spacing" on circle arrays (just like path arrays already do!): path layouts let us pass place: "spacing", spacing: 1.95, whereas circle layouts require computing count manually from radius * sweep. Supporting spacing on circle removes railing-count math completely.
One read-only measure_geometry tool (if you want an explicit math helper): Make it scene-aware rather than a calculator—e.g. given { a: "array_13/3", b: "group_103" } or { sample_arc: { around: "cylinder_27", radius: 10.92, from: -67, to: 43, max_sagitta: 0.1 } }, return exact clearance distances, surface y, angles, or arc points.
2. Geometry & Workflow Friction Points We Hit
Curved-Wall Roof/Walkway Intrusion (freeform_19 & freeform_24):
Both the west roof walkway and the east Hall A roof (box_160 → freeform_24) poked wedges through the interior curved wall of cylinder_27 because straight polygon chords dip inside r_inner. Even reshaping freeform_24 by hand in the editor took 5 steps and still poked inside above the east paintings.
Improvement: Either allow clip_outside: "cylinder_27" (boolean trim of an exterior volume against a room’s outer/mid wall), or add an editor/MCP helper fit_arc on freeform point ranges { around: "cylinder_27", radius: 10.92 }.
Hole Scoping Across Sub-Groups (door_gallery_roof_west):
Logically, the 3rd-floor roof door belongs inside third_floor_mezzanine (group_104), not loose under group_28. We had to keep instance_97 directly in group_28 because holes/door-instances don't cut cylinder_27 once nested inside a child group.
Improvement: Let holes/door instances cut ancestor kind: "room" shapes within the same room root, or support an explicit cuts: "cylinder_27" field.
Wall-Mounted Entities (check_scene False Positives & Resizing):
check_scene flagged all 9 wall-hung frames (instance_99..106, 114) as "floating 8.8 m above what's under it".
Improvement: Allow on: { id: "cylinder_27", wall: "inner", angle: 225, y: 13 } (or a wall_mounted: true entity flag) so check_scene knows wall art isn't a y typo—and moving/resizing the room moves its wall art automatically.
Cross-Group Interior Intrusion Check in check_scene:
check_scene didn't catch freeform_19 or freeform_24 (from roof_section) poking 0.8 m inside cylinder_27's interior wall; only eye-level render_view caught them. Adding an intrusion check when sibling/external volumes pierce a room's inner wall would catch this in text before rendering.
Negative taper (or taper_bottom) for Corbels / Capitals:
taper (0..1) only narrows the top face, so we needed two stacked boxes per corbel under the mezzanine (6 nodes instead of 3). Allowing taper: -1..1 (negative narrows the bottom) lets one box model corbels, brackets, and hoppers.
3. Big Token & Tool-Call Savers in Existing Schemas
find_nodes Silently Ignores Unknown Filter Keys (~6,000+ wasted tokens):
find_nodes does not set "additionalProperties": false on its input schema. When an agent passes "parent": "group_28" (matching draw_shapes/update_nodes terminology instead of "under": "group_28") or "ids": [...], find_nodes silently drops the unknown key and dumps 100 unrelated nodes from the start of the scene!
Fix: Add "additionalProperties": false to find_nodes, support ids: string[], and optionally alias parent → under.
get_scene Multi-ID Lookup (ids: string[]):
get_scene currently accepts a single root: string. Inspecting 4 specific nodes (cylinder_27, array_13, array_38, freeform_24) either takes 4 separate calls (4× scene header boilerplate) or full: true on a big group (which exceeded 46 KB and truncated!). Adding ids: ["cylinder_27", "array_13", "freeform_24"] returns just those nodes in one compact call.
Default kind: "volume" on box / cylinder in draw_shapes:
The draw_shapes description says "only kind, x, z, width and depth are required", which is easy to miss on large batches of decorative box props—causing an all-or-nothing -32602 rejection and forcing the LLM to resend the entire JSON payload. Defaulting kind to "volume" when omitted (while still allowing explicit "room" | "volume" | "hole") saves full-batch retries.
4. Tool Description & SKILL.md Quick Wins

Even without changing server code, updating SKILL.md and a few tool descriptions will immediately cut mistakes:

Surface ref / "$ref" and type: "group" in SKILL.md: draw_shapes already supports creating a group, a ramp ("ref": "stair"), and its "along": { "id": "$stair" } railing in one single call and one undo step—but SKILL.md doesn't mention it, so agents default to 3 sequential calls (draw_shapes → draw_shapes → group_nodes).
Clarify define_entity vs make_entity in SKILL.md: Line 33 says "Created with make_entity", whereas new procedural library prefabs are created with define_entity (make_entity converts existing scene nodes).
Document Polar & Entity Facing Math in One Line: Add to SKILL.md and draw_shapes:

"Circle/spiral angles run CCW from 0° = +x (East), 90° = -z (North): x = cx + r·cos(θ), z = cz - r·sin(θ). Entities facing -z at rotation: 0 face inward toward (cx, cz) at rotation = (θ + 90) % 360, and a box/railing aligns its local width (+x) radially along θ at rotation = θ."

Clarify along.offset Sign on Ramps/Arrays: Document directly in layout.along.offset’s schema description: "Signed lateral offset in meters perpendicular to the path direction (negative = left of forward travel, positive = right)."

If you'd like, we can immediately update SKILL.md in this repo with those description/workflow improvements right now!

## Some more Ideas I have for improvements for my self: 

- el default hover es molesto cuando tienes grupos muy grandes "todo" se pone amarillo

- "cut groups" to better control what cuts what? 
	- this just needs a general improvement.

- que los array groups en una linea sigan la verticalidad del array rotando tambien en los otros Ejes, no solo en Y

- seleccionar algo en el viewport deberia mover el scroll view de la herarquia

- poder modificar el snapping values 

- right click options for context menu

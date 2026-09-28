import {
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  DEFAULT_LINE_COLOR,
  DEFAULT_THICKNESS,
  DEFAULT_WALL,
  MAX_SIDES,
  MAX_THICKNESS,
  MIN_HEIGHT,
  MIN_SIDES,
  MIN_THICKNESS,
  MIN_WALL,
  SHAPE_COLORS,
} from "../shared/scene.types";
import { FULL_SCENE_MAX } from "./outline";

/**
 * What the agent is told (plan 08 §4): a short core, sent once as the server's `instructions`, and the detail per
 * topic, which `get_guide` returns on demand, so a session only pays for the topics it uses.
 */

export const GUIDE_TOPICS = ["shapes", "volumes", "holes", "ramps", "lines", "groups"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** One line per topic, for the core and for get_guide's description. */
const TOPIC_SUMMARIES: Record<GuideTopic, string> = {
  shapes: "boxes, cylinders and free-forms in detail: rooms and their walls, volumes, colors, converting to a free-form",
  volumes: "taper, bevel and tilt (pyramids, cones, hills, a cylinder lying on its side)",
  holes: "which shapes a hole cuts; doors, windows, arches and holes in floors",
  ramps: "ramps, stairs, landings, walkways and spiral stairs",
  lines: "lines: routes, patrols, jump arcs and pointers",
  groups: "groups, copying, mirroring and turning things as a unit",
};

export const INSTRUCTIONS =
  "Dungeon Designer: an ideation tool for dungeon layouts. The human edits the same scene in a local 3D editor, " +
  "and you read and edit it with these tools. The scene is one scene of a project (a project holds several scenes, " +
  "e.g. one per level); get_scene reports which, and the project's description gives the context. You only see the " +
  "open scene: the human opens and switches scenes in the editor. Every change is saved as it happens, and every " +
  "tool call that changes the scene is one step in the undo history shared with the human. " +
  "Units are meters, kept to 2 decimals. The world is 3D with y up and the ground at y = 0. The compass is fixed: " +
  'NORTH is -z, south +z, east +x, west -x, so "the north wall" is a shape\'s -z side. ' +
  "The scene is a flat list of nodes, shapes and groups, each with a server-assigned ID (box_1, cylinder_1, " +
  "freeform_1, line_1, ramp_1, group_1, ..., never reused) and an optional `name` (not unique; tools take IDs). " +
  "The shapes: box (the default type), cylinder and freeform are CLOSED shapes, each a room (hollow: floor and walls, " +
  "no ceiling, its footprint the room's outside, walls growing inward), a volume (solid: a platform, a pillar, a hill) " +
  "or a hole (it cuts the shapes near it: doors, windows, holes in floors). A box's footprint is CENTERED at (x, z), " +
  "`width` along its local x and `depth` along its local z, turned by `rotation` (degrees, counterclockwise seen from " +
  "above); it rises from `y` (its bottom: 0 = on the ground) to y + height, so to stack B on A, B.y = A.y + A.height. " +
  "A ramp is a path with a width (ramps and stairs), and a line is an annotation (a route, an arrow, an idea). A group " +
  "has no position of its own: a node is in a group when its `parent` is that group's ID, shapes keep world " +
  "coordinates, and tools act on a group as a unit. " +
  "READING: get_scene returns an outline: the top level (or a group's contents with `root`), with each group's " +
  "description, bounds and counts (`contains`); `depth` opens more levels and `full: true` returns every node " +
  `(a scene of ${FULL_SCENE_MAX} nodes or fewer comes back in full). The human's selection is always included: when ` +
  'they say "this", they mean the `selection`. When `view.isolated` is set, the human is working inside that node: ' +
  "pass it as root, and put new shapes for it inside it. Use find_nodes to look nodes up by name, type, kind, group " +
  "or place, instead of reading the whole scene. `view.focus` is the ground point at the screen center: draw near it " +
  "to be on screen. A node with `locked: true` (the human can't pick it) or `hidden: true` (not drawn, and a hidden " +
  "hole cuts nothing) is the human's aid: leave those alone unless asked. " +
  "WAYS OF WORKING: describe groups (update_nodes description) so the outline tells what each part is. To repeat " +
  "things, copy them with move_nodes and copy: true (count for a row) instead of redrawing; for symmetry, copy then " +
  "mirror_nodes. A door or window is a hole shape in the room's group: cut it, don't build walls around the opening. " +
  "Draw lines for paths, routes, jumps and ideas. " +
  "THE GUIDE: before using a shape type or a field for the first time in a session, read its topic with get_guide: " +
  GUIDE_TOPICS.map((t) => `${t} (${TOPIC_SUMMARIES[t]})`).join("; ") +
  ". Errors and warnings name the topic to read when one helps.";

const GUIDE: Record<GuideTopic, string> = {
  shapes:
    `A box's footprint is CENTERED at (x, z), with \`width\` along the box's local x and \`depth\` along its local z. It ` +
    "rises from its elevation `y` (its bottom: 0 = on the ground, negative = below ground) to y + height, so to stack " +
    "box B on box A, set B.y = A.y + A.height. `rotation` turns a box around the vertical axis through its center, in " +
    "degrees, counterclockwise seen from above (0 = grid-aligned: width along world +x, depth along world +z). " +
    "Rotating never moves the center. " +
    `A room is hollow: floor and walls, no ceiling; default height ${DEFAULT_HEIGHT.room} m. Its footprint is the room's ` +
    `OUTSIDE, and its walls grow inward from it, \`wall\` m thick (default ${DEFAULT_WALL}, at least ${MIN_WALL}), so a ` +
    "10 m room is 10 m across outside. Two rooms that touch have two walls back to back, so overlap them by a wall's " +
    `thickness to share one. A volume is solid (a platform, a pillar; default height ${DEFAULT_HEIGHT.volume} m). ` +
    `A hole cuts (get_guide holes; default height ${DEFAULT_HEIGHT.hole} m). Minimum height is ${MIN_HEIGHT} m. ` +
    `\`color\` is a palette key: ${SHAPE_COLORS.join(", ")} (default ${DEFAULT_COLOR}). ` +
    "A cylinder has exactly a box's fields, and its footprint is the ellipse inscribed in its width × depth rectangle " +
    "(width = depth for a circle, so a round room 10 m across is width 10, depth 10), centered at (x, z) and turned by " +
    `\`rotation\` like a box. With \`sides\` (${MIN_SIDES}..${MAX_SIDES}) it's a regular polygon on that ellipse instead, ` +
    "with a flat edge facing its local +x (sides 8 at rotation 0: an octagon with flat walls facing ±x and ±z); " +
    "without sides it's smooth. update_nodes with sides: null makes one smooth. " +
    "A free-form (type: freeform) is any other outline: a closed list of `points` in ABSOLUTE world x/z (3 or more; " +
    "the last joins the first), at elevation `y` and rising to y + height, a room, a volume or a hole like a box (same " +
    "walls and default heights). It has no x, z, width, depth or rotation of its own. A point is { x, z } (a corner), " +
    "optionally with bezier handles `in` and `out`, which are OFFSETS from that point (not absolute positions): the " +
    "edge from point i to point i + 1 curves when point i has `out` or point i + 1 has `in`. For a smooth point, make " +
    "`in` the negative of `out`. A circle of radius r through 4 smooth points uses handles of length 0.5523 × r, " +
    "along the tangent. The outline must not cross itself (the error names the edges that do). update_nodes with " +
    "`points` replaces the whole outline. move_nodes, rotate_nodes and mirror_nodes change a free-form's points " +
    "(rotating or mirroring one bakes the turn or the flip into them), so use them instead of recomputing points. " +
    'To reshape a box or cylinder freely, first convert it with update_nodes { id, type: "freeform" } (a box gives ' +
    "its 4 corners, a sided cylinder its corners, a smooth one 4 smooth points that are still a true circle or oval), " +
    "then edit the new free-form's points. The free-form gets a NEW ID (the result maps each old ID to it) and keeps " +
    "the name, group, kind, color, y, height and place in the list. Don't compute circle handles by hand. " +
    "Every shape records who created it (human or agent).",
  volumes:
    "A volume or a hole (of any closed shape) can have two fractions: `taper` 0..1 shrinks its top toward its center " +
    "(1 = a point: a box becomes a pyramid, a cylinder a cone) and `bevel` 0..1 rounds its top edge (1 = as round as " +
    "it fits: a tall cylinder gets a dome, a box a rounded top); together they make hills and mountains (taper 0.6, " +
    "bevel 0.5). The top stays at y + height, the bottom stays flat. Rooms have neither; making a volume a room drops " +
    "them, and making a room a volume drops its wall. " +
    "A box or cylinder volume or hole can also tilt: `pitch` turns it around its own x axis and `roll` around its own " +
    "z axis, in degrees through its CENTER (x, y + height / 2, z), roll first, then pitch, then `rotation` as usual " +
    "(so rotating never changes the tilt). +pitch leans the top toward its local +z, +roll toward its local -x. `y` " +
    "stays the bottom before tilting and `height` the length along the tilted axis: a cylinder lying on its side (a " +
    "round window or a log) is pitch 90, with height as its length and its center at y + height / 2. get_scene gives " +
    "a tilted shape its actual axis-aligned `bounds`. Free-forms and rooms don't tilt, and a tilted shape can't " +
    "convert to a free-form.",
  holes:
    "A HOLE (kind: hole) is any closed shape that cuts itself out of other shapes when drawn: a door, a window, an " +
    "arch, a hole in a floor, a tunnel. For a hole in group G, whose parent is P (the top level if G is top-level), it " +
    "cuts the shapes directly in G, directly in P (beside G), and directly in G's and P's sibling groups; nothing " +
    "deeper. A hole outside any group cuts nothing (results warn about it), and it only cuts what it overlaps. So give " +
    "a room a group holding its walls and a `door` group of holes (a door can be several holes): the door cuts its " +
    "room's walls and the walls of the rooms beside that room (P's sibling groups), for a doorway through two walls. " +
    "Holes never cut holes. A hole cuts a room's floor only if its bottom is below the room's y (a door standing on " +
    `the floor doesn't notch it). Default hole height ${DEFAULT_HEIGHT.hole} m. A door: a box hole about 1 m wide, ` +
    "2.2 m tall, standing on the floor, turned like the wall and a bit deeper than the wall. A round window: a " +
    "cylinder hole with pitch 90 (lying, its height through the wall). An arch: a box hole plus a lying cylinder hole " +
    "on top. For a stair up to a floor above, cut a hole in that floor and keep it thin (from about 0.05 m below the " +
    "floor to just above it): a hole cuts everything in reach that it overlaps, the stair included. Holes can taper, " +
    "bevel and tilt like volumes (get_guide volumes).",
  ramps:
    "A RAMP (type: ramp) is a path with a `width` (default 1.5 m) you walk along its top: a ramp, stairs, a landing, " +
    "a walkway, a spiral stair. Its `points` are the centerline in ABSOLUTE world x/z, each with the surface's height " +
    "`y` there (a floor's y, a platform's top); between two points the height changes evenly with the distance, so " +
    "two points at the same y make a landing, and flat handles `in` / `out` ({ x, z } offsets) curve it. `step` is " +
    "the riser height (stairs: each edge gets round(rise / step) equal steps, the top one flush with the higher end); " +
    "without it the ramp is smooth. `base` is solid (the default, filled down to its lowest point) or floating (a " +
    "slab under the surface). For a spiral, give `spiral: { x, z, radius, turn, y, rise, from? }` instead of points " +
    "(turn in degrees, counterclockwise seen from above; from 0 = east, 90 = north) and don't compute a helix by hand. " +
    "A ramp is always a volume (never a hole); it has no x, z, y, height or rotation, and move_nodes, rotate_nodes " +
    "and mirror_nodes change its points. For a stair up to a floor above, cut a thin hole in that floor " +
    "(get_guide holes).",
  lines:
    "A line (type: line) is an annotation, not geometry: an open path of `points` in ABSOLUTE world x/y/z (2 or more; " +
    "it doesn't close), for a route, a patrol, a jump arc, a pointer or an idea. Each point has its own y (0 = the " +
    "ground; a platform's top to start on it), and bezier handles `in` / `out` are 3D offsets { x, y, z } from the " +
    "point (a jump arc from a platform is 2 points with an `out` handle pulling up on the first). It has `color` " +
    `(default ${DEFAULT_LINE_COLOR}), \`thickness\` in screen pixels (${MIN_THICKNESS}..${MAX_THICKNESS}, default ` +
    `${DEFAULT_THICKNESS}), \`dashed\` (default false) and \`arrow\`: none (default), end (an arrowhead at the last ` +
    "point) or both. It has no kind, x, z, y, height or rotation; move_nodes, rotate_nodes and mirror_nodes change " +
    "its points.",
  groups:
    "A group (type: group) has NO position of its own: its shapes keep absolute world coordinates, and a node is in " +
    "a group when its `parent` is that group's ID (groups can nest). get_scene adds each group's derived `bounds` " +
    "(center x/z, bottom y, sizes) and `contains` (what's under it). A group can have a `description` (what that part " +
    'of the level is: "entry hall, safe zone"), set with update_nodes or group_nodes; the outline shows it, so ' +
    "describe the main areas. Tools act on a group as a unit: move_nodes and rotate_nodes on a group move or turn " +
    "everything in it in one step. A group left empty disappears. Draw straight into a group with draw_shapes' " +
    "`parent`. To repeat things (a row of pillars, a second wing, another floor), copy them with move_nodes and copy: " +
    "true (count for several, each offset further) instead of retyping shapes: copies get new IDs and keep their " +
    "names, structure and parent group. For symmetry, mirror_nodes flips nodes in place on a WORLD axis (x or z, not " +
    "the camera's view): copy a wing with move_nodes, then mirror the copy, instead of computing reflected positions " +
    "by hand. rotate_nodes turns around the bounds' center by default and returns that `pivot`: pass it back to turn " +
    "something back exactly.",
};

export const guideTopic = (topic: GuideTopic) => GUIDE[topic];
export const topicList = () => GUIDE_TOPICS.map((t) => `${t}: ${TOPIC_SUMMARIES[t]}`).join("\n");

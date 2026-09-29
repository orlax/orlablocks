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

export const GUIDE_TOPICS = ["design", "review", "shapes", "volumes", "holes", "ramps", "lines", "notes", "groups", "library", "entities", "arrays"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** One line per topic, for the core and for get_guide's description. */
const TOPIC_SUMMARIES: Record<GuideTopic, string> = {
  design: "THIS PROJECT's design guide: what a good level is for this game, its facts (player size, jumps) and house rules",
  review: "checking your work as a level designer: shots as requirements, reveals, wayfinding, landmarks, metrics, detail",
  shapes: "boxes, cylinders and free-forms in detail: rooms and their walls, volumes, colors, converting to a free-form",
  volumes: "taper, bevel and tilt (pyramids, cones, hills, a cylinder lying on its side)",
  holes: "which shapes a hole cuts; doors, windows, arches and holes in floors",
  ramps: "ramps, stairs, landings, walkways and spiral stairs",
  lines: "lines: routes, patrols, jump arcs and pointers",
  notes: "notes: post-its pinned in the scene, the human's intents and work items (and yours)",
  groups: "groups, copying, mirroring and turning things as a unit",
  library: "the project's tags (#name) and skills (@name): what they mean, tagging nodes, referring to them",
  entities: "entities (prefabs): making them, placing instances, swapping, detaching; holes in and around them",
  arrays: "arrays: one node repeating entities along a path, around a circle, in a grid or scattered (battlements, windows, pillars, forests)",
};

export const INSTRUCTIONS =
  "orlablocks: an ideation tool for dungeon layouts. The human edits the same scene in a local 3D editor, " +
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
  "or place, instead of reading the whole scene. RESULTS of the edit tools are COMPACT: each node's id, type, kind, " +
  "name, parent and bounds (x, z at the center, y the bottom, width, depth, height), with a count instead of points, " +
  "and for an array its item count and the range of its tops; items: true adds its item lines (`array_5/3 → x, y, z · " +
  "top t · r°`: where each item stands, how high its top is and its turn). Pass verbose: true only to read a node " +
  "back in full. dry_run: true on an edit tool checks the whole call and returns what it would do, and every error, " +
  "changing nothing: use it before a big batch. Open notes come short in get_scene (notes: \"full\" for every field). " +
  "An instance's rotation can be where it faces instead of degrees: { toward: {x, z} or an ID }, { away }, { along: " +
  "a line or ramp }. `view.focus` is the ground point at the screen center: draw near it " +
  "to be on screen. `view.walking` (while the human walks through the level with the Walk tool) is their eye, where " +
  "it looks (`yaw` as the view's, `pitch` up) and the field of view: what they see from there. `view.pointer` is where " +
  "the human's pointer last rested (on a node, with its `id`, or on the ground): \"here\" means there. A node with `locked: true` (the human can't pick it) or `hidden: true` (not drawn, and a hidden " +
  "hole cuts nothing) is the human's aid: leave those alone unless asked. " +
  "WAYS OF WORKING: describe groups (update_nodes description) so the outline tells what each part is. To repeat " +
  "things, copy them with move_nodes and copy: true (count for a row) instead of redrawing; for symmetry, copy then " +
  "mirror_nodes. When the human SKETCHES something small and asks for it at scale, the sketch is the brief: make it " +
  "again with transform_nodes { ids, copy: true, scale, rotate?, mirror?, to } in one call (everything grows, walls " +
  "and heights too), never by re-deriving its points; scale an instance or array with its `scale`. " +
  "A door or window is a hole shape in the room's group: cut it, don't build walls around the opening. " +
  "Draw lines for paths, routes, jumps and ideas. " +
  "REVIEWING (get_guide review): the human's captioned shots are requirements: after a change that may touch one, " +
  "re-check it (render_view view: shots) and say whether its caption holds. To know whether a landmark is in view, " +
  "check_sight (text, cheap) before render_view. Keep detail proportional to gameplay. " +
  "ENTITIES are the project's prefabs (a tree, a door, a poison pit): an instance (type: instance, e.g. instance_4) " +
  "shows its entity's shapes at its x, y, z and rotation, and carries its description and tags; the outline shows " +
  "one line per instance, and the glossary what each entity is and its size. Place and repeat entities instead of " +
  "redrawing a thing twice. Make a new entity with define_entity (its shapes around the origin, never drawn in the " +
  "scene). To repeat an entity many times (battlements, windows round a tower, pillars in a hall, a " +
  "row of torches), use one ARRAY (type: array; get_guide arrays), not copies: it stays one node and draws cheaply. " +
  "When get_scene has `editing`, the human is editing an entity: the nodes are its shapes " +
  "around its pivot, and your changes reach every instance. " +
  "NOTES (type: note) are post-its pinned in the scene: the human's intents and work items. The outline always lists " +
  "the open ones (`notes`); treat them as intent, act on them when asked, and mark one done (update_nodes status: " +
  "done) once it's handled. Leave a note of your own for an assumption or a question. " +
  "THE PROJECT: its library has tags (#climbable) and skills (@telekinesis: what the player can do), and nodes carry " +
  "tags; the outline's `glossary` explains the ones it shows, and get_library lists them all. Build around the " +
  "player's skills. The project's DESIGN GUIDE (get_guide design; get_scene's `guide` says when it changed) holds the " +
  "human's taste, the game's facts and house rules: read it once per session before designing or reviewing, and " +
  "follow it. Change the library or the guide only when asked. " +
  "THE GUIDE: before using a shape type or a field for the first time in a session, read its topic with get_guide: " +
  GUIDE_TOPICS.map((t) => `${t} (${TOPIC_SUMMARIES[t]})`).join("; ") +
  ". Errors and warnings name the topic to read when one helps.";

const GUIDE: Record<Exclude<GuideTopic, "design">, string> = {
  review:
    "Review your work as a level designer: what the player will see, from where, and what they can do there. A render " +
    "(render_view) is for what a player SEES; numbers (get_scene, find_nodes) are for what a player can DO. " +
    "WHETHER something is in view is a question for check_sight, not a render: check every landmark and goal from the " +
    "entrance and from each beat's standing point (from: a point, a node to stand on, or \"human\"), in one call; it " +
    "names every blocker along the way, nearest first, so fix them all at once; pass light shafts and decor in " +
    "`ignore`. Render for how it looks. For an ENCLOSED room, render_view { hide: [its walls] } or { clip: eye height } " +
    "shows it from outside for that render only (the scene's hidden flags stay the human's), instead of the outside " +
    "of a wall. " +
    "SHOTS ARE REQUIREMENTS. The human takes shots of views that matter, and a shot's caption is a claim about the " +
    "level from that camera (\"the flag reads from the approach\", \"the window shows from the stair\"). get_shots lists " +
    "them with changedSince (steps since each was taken). After a change that may touch a captioned shot's view, " +
    "re-check it: render_view { view: \"shots\" } draws each captioned shot taken before the last change as taken and " +
    "now, side by side (or pass shots: [...]). For each, say whether its claim still holds; if it broke, fix it, or say " +
    "what you traded and why (a tower lowered so its flag stays in frame). Treat a caption you're asked to satisfy the " +
    "same way: build, then re-check the shot before calling it done. An uncaptioned shot is only a picture. When you " +
    "make a view that matters, you can keep it (save: true on a node, eye or shot render) and state its claim in your " +
    "reply or a note. " +
    "WHAT TO CHECK, AND WHEN. Reveals: the first view of each area, an eye view from its entrance (render_view view: " +
    "eye, from the doorway's floor, at the room): is the thing the room is about in view, and the way on? Wayfinding: " +
    "after changing a route, walk it (view: walk, path: the critical path's line or ramp): in each frame, is the next " +
    "goal, door or landmark visible, or something that leads the eye to it (light, an opening, a line of sight, a " +
    "contrasting shape)? A frame with nothing to follow needs a breadcrumb. Landmarks: something big meant to be seen " +
    "from far must stay visible from the places that steer by it; check from those places (eye), not from above. " +
    "Metrics: jumps, drops, door widths, stair rises, ramp slopes and corridor widths against the design guide's " +
    "numbers, measured from the shapes, never judged from a picture. Structure: a sheet (the default view) after " +
    "building or reshaping something, for stairs that end in walls, doors that cut nothing, floating shapes, overlaps, " +
    "rooms with no way in, and scale against the human. Entities: view: entities before placing ones you haven't seen. " +
    "Say what you checked and what you found, in a line each; don't describe every image. " +
    "HOW MUCH DETAIL. A blockout decides the level: shapes are gameplay space (where the player walks, climbs, hides " +
    "and looks). Put detail where the player's attention is (a landmark, a goal), in as few shapes as read clearly. " +
    "Decoration is one shape or one array, not many shapes: a roof as one cone, a railing as one thin box, battlements " +
    "as one array of a merlon entity along the wall top (get_guide arrays). A detail repeated many times is an entity " +
    "placed by an array. Every extra shape makes the next change slower, for you and for the editor. The design guide " +
    "may set its own budget: follow it.",
  entities:
    "An ENTITY is a prefab in the project library: a name, a description (what it is and does in the game), tags, " +
    "and a DEFINITION, its shapes around a PIVOT at the origin (its bottom center). Its ID is a slug of its first " +
    "name (\"tree-tall\") and never changes. An INSTANCE (type: instance) places one: { entity, x, z, y?, rotation?, " +
    "name? } in draw_shapes, where x, y, z is where the pivot goes (y the surface it stands on) and rotation turns it " +
    "around the pivot (degrees, counterclockwise seen from above). FACING: instead of degrees, rotation can say where " +
    "its local +x faces, worked out once (it doesn't follow later): { toward: {x, z} or a node or item ID } (a stand " +
    "facing the ring), { away: ... } (its back to it), { along: a line's or ramp's ID } (along the route where it " +
    "passes nearest: rings along a flight path). No atan2. An instance has nothing else of its own: its shapes, " +
    "description and tags are its entity's (find_nodes { tag } finds instances through their entity's tags), and " +
    "editing the entity changes every instance. update_nodes on an instance takes x, y, z, rotation, name, parent and " +
    "`entity` (swap: a small tree becomes a tall one in place). move_nodes, rotate_nodes and copy work on instances as " +
    "on shapes; mirror_nodes moves one to its mirrored place and turns it to face the mirrored way, but doesn't flip " +
    "the entity (a left-handed door stays left-handed). To repeat a thing, make it an entity once and place instances " +
    "(a forest: a few tree entities, many instances) rather than copying shapes. To make a new entity, " +
    "define_entity { name, description, tags, shapes } takes its shapes (draw_shapes' entries, with refs and groups) " +
    "around its PIVOT, the bottom center at the origin: build it standing on y = 0 around x = 0, z = 0 (a 2 × 2 × 0.5 " +
    "slab is { kind: \"volume\", x: 0, z: 0, width: 2, depth: 2, height: 0.5 }; a column on a plinth, the plinth at y " +
    "0 and the shaft at y = the plinth's height). Nothing is drawn in the scene and no instance is left to clean up, so " +
    "it's the way to make an entity you're about to place. make_entity { ids, name, description, tags, keep? } turns " +
    "shapes or a group already in the scene into a new entity and puts an instance in their place (keep: false leaves " +
    "nothing; a single group's contents become the entity), with the pivot at the bottom center of their bounds. " +
    "detach_instances turns an instance back into a plain group of shapes, only when one copy must " +
    "differ. get_library { entity } returns a definition's nodes. For HOLES an instance is a group: its shapes are " +
    "directly in it. So an entity that is a hole (a window) cuts what's directly in the instance's parent group and in " +
    "the groups beside it: place a window instance in the room's group and it cuts that room's walls. The human edits " +
    "an entity's shapes in Edit entity mode: then get_scene has `editing`, the nodes are the definition (around the " +
    "pivot: keep its bottom at y = 0), the tools change it (as its own undo steps), and every instance follows. A hole in the " +
    "scene cuts an instance's shapes as it cuts a sibling group's. An instance whose entity is missing shows as a red " +
    "block (results warn about it). To place many of one entity on a path, a circle, a grid or scattered in an area, use an array (get_guide arrays).",
  arrays:
    "An ARRAY (type: array, array_1, ...) repeats entities on a LAYOUT, live: one node whose ITEMS are instances the " +
    "layout places, so change the layout and every item follows. draw_shapes { type: \"array\", entity (or entities: " +
    "[{ entity, weight? }] to mix several, chosen by weight), layout, facing?, rotation?, jitter?, turnJitter?, seed?, " +
    "skip?, name?, parent? }. The outline shows it as one line with `items` (how many) and its bounds. WHERE ITEMS ARE: " +
    "with items: true, the edit tools' results list an array's ITEM LINES (`array_5/3 → 12.1, 4.5, -8 · top 5 · 90°`: " +
    "item 3 stands at x 12.1, y 4.5, z -8, its top is at y 5 and it's turned 90°), the first 40 (by default only the " +
    "count and the range of tops, to keep results short); get_scene { root: " +
    "\"array_5\" } lists them all, and find_nodes { type: \"item\", near } finds the ones near a point, nearest first. " +
    "Use them to aim a line from item to item, or to pick which to skip, instead of working out where the layout puts " +
    "them. LAYOUTS: " +
    "{ type: \"path\", points (a line's: absolute world x/y/z, with 3D handles; items stand at the path's height), " +
    "closed?, place?, spacing? | count? }: place spacing (the default) puts an item every `spacing` m, FITTED so they " +
    "land evenly (every 1.2 m on a 45.5 m wall is 38 gaps of 1.197 m), with one at each end of an open path and none " +
    "repeated on a closed one; count puts `count` evenly; corners one on every point (a pillar on each corner); " +
    "midpoints one mid-edge (a window on every face). A vertical path stacks (floors of a tower, a pile). " +
    "FOLLOWING: instead of points, a path can follow another node, live: layout: { type: \"path\", along: { id, at?, " +
    "offset? }, spacing }. A box, cylinder or free-form gives its outline (a loop, counterclockwise seen from above) at " +
    "its top (the default; a tapered volume's top ring) or bottom (at: \"bottom\", its floor), moved `offset` m " +
    "inward: by default half a room's wall, so items stand on the wall's centerline, and 0 for a volume (on its edge). " +
    "A ramp gives its centerline at its surface's height, and a line its path, `offset` m to the right of travel. " +
    "Battlements on a keep are one call: { type: \"array\", entity: \"merlon\", layout: { type: \"path\", along: { id: " +
    "\"box_5\" }, spacing: 1.2 } }; posts along both sides of a stair are two, offset ± half its width. When the " +
    "followed node changes (resized, reshaped, raised) the items follow in that same step. A following array has no " +
    "place of its own: move, turn or mirror what it follows (it's refused alone; in a group it goes with its target). " +
    "Removing the followed node unlinks the array (it keeps its last path; remove_nodes says which), converting it to " +
    "a free-form keeps the follow, a copy made with its target follows the copy and one made without it is unlinked. " +
    "update_nodes { layout: { along: { offset: 0.3 } } } changes the follow, { along: null } unlinks it. " +
    "{ type: \"circle\", x, z, y?, radius, count, start?, sweep?, rise? }: angles in degrees from 0 = east (+x), 90 = " +
    "north (-z), counterclockwise; sweep under 360 is an arc with items at both ends; `rise` makes the items climb " +
    "evenly, the last one `rise` above the first on an arc (over a full circle, `rise` per turn): a spiral of " +
    "platforms round a wall, 9 slabs over 120° climbing 8 m, is { type: \"circle\", x: 0, z: 0, y: 0.5, radius: 17, " +
    "count: 9, start: 270, sweep: 120, rise: 8 }. A path takes `spiral` too, as a line does (get_guide lines), for " +
    "items spaced by distance along a spiral rather than by angle. { type: \"grid\", x, z, y?, rotation?, " +
    "columns, rows, layers?, spacing: { x, z, y? }, stagger? }: centered on x, z, columns along its local x, rows along " +
    "its local z, layers up (spacing.y), stagger offsets every other row by half (brick). { type: \"scatter\", x, z, " +
    "radius (a circle) or area (an outline as a free-form's points), y?, count, minDistance?, rotation? }: items at " +
    "random from the seed, at least minDistance apart (default: the widest entity's width), fewer when they can't all " +
    "fit (the result says how many did); a forest is a scatter of a few tree entities by weight, facing random. " +
    "FACING turns each item: an " +
    "entity at 0 shows as drawn; along (a path's default) and tangent (a circle's) turn its local +x along the way, so " +
    "draw a window or a merlon with its width along x and it lies along the wall; out turns its +x away from a " +
    "circle's center, in toward it; fixed keeps it as drawn (a grid's or a scatter's items turn with it); random turns each " +
    "anyhow. `rotation` is added to every item's facing. NOISE: jitter (meters on the ground) and turnJitter (± " +
    "degrees), both from `seed` (an integer: the same seed, the same look; another seed rerolls). SKIP lists item " +
    "indices (0 = the first, in layout order; the number after the slash in an item's ID) to leave out, like the " +
    "merlons over a gate (find_nodes { type: \"item\", near: the gate } says which): skip last, since changing " +
    "the count or the path's length can move which item an index is. HOLES: an array adds no level of its own, so its " +
    "items cut and are cut as instances placed where the array is: a window array in the tower's group cuts the " +
    "tower's walls. Windows round a 10-sided tower 20 m across: a circle at the tower's center, count 10, facing " +
    "tangent, radius = the distance to the middle of a face (10 × cos 18° = 9.51) minus half the wall (9.41), start 0 " +
    "(a sided cylinder's flat edge faces its local +x). STANDING ON: on: { id } (draw_shapes or update_nodes) stands " +
    "every item on that node's walking surface under it (items over nothing keep the layout's height), kept up to date; " +
    "an array ON AN ARRAY stands its item i on that array's item i, at its place, turned as it is, on its top, and " +
    "needs no layout of its own (it takes that array's): flame jets on a ring's slabs are { type: \"array\", entity: " +
    "\"flame-jet\", on: { id: \"$ring\" }, skip: [the slabs without one] }, and they stay on their slabs whatever the " +
    "ring does. An instance takes on too (instead of y). Giving it a height (y, or the layout's " +
    "y) or moving it up or down without what it stands on unlinks it; on: null stops it standing. " +
    "update_nodes on an array takes entities, layout (the fields " +
    "given merge into it: { count: 12 } or { radius: 9 }; a different type is a whole new layout), facing, rotation, " +
    "jitter, turnJitter, seed, skip, name and parent. move_nodes, rotate_nodes and mirror_nodes act on its layout (a " +
    "mirrored array's items face the mirrored way; the entities aren't flipped), and copy copies it as one node. An " +
    "array makes at most 500 items. detach_instances turns an array into a group of plain instances, only when one " +
    "item must differ. Arrays can't go in an entity's definition.",
  library:
    "The project library holds TAGS and SKILLS, shared by every scene of the project. A tag (#climbable, #light) is a " +
    "property of things, with an optional description. A skill (@telekinesis, @fireball) is something the player can " +
    "do, with a description and optionally the tags it acts on (telekinesis tagged light: it moves things tagged " +
    "#light). Names are lowercase letters, digits, _ and -, starting with a letter, written without the sigil in " +
    "fields and with it in text. Groups and closed shapes and ramps carry `tags` (draw_shapes, update_nodes and " +
    "group_nodes take the whole list; null removes them). A tag must exist in the library first: add it with " +
    "update_library. Any description (a group's, a tag's, a skill's) can refer to skills as @name and tags as #name; " +
    "the outline's `glossary` explains every tag and skill a result shows or names, so you rarely need get_library. " +
    "find_nodes { tag } finds what carries a tag. Renaming keeps the old name as an alias: old references still " +
    "resolve, and results show current names. Deleting a tag or skill leaves what refers to it unresolved. Library " +
    "edits have their own undo history (the human's Library panel), separate from the scene's. Design with the " +
    "player's skills: a space that asks for @telekinesis needs something #light to move.",
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
    "point) or both. ARCS AND SPIRALS: instead of points, give `spiral: { x, z, radius, turn, y, rise, from? }` (a " +
    "ramp's): a circle of `radius` round (x, z) from angle `from` (0 = east, 90 = north) through `turn` degrees " +
    "(counterclockwise; negative clockwise), climbing `rise` from `y`; the server makes it points (one every 90°, with " +
    "circle handles), so don't sample a circle yourself. A 17 m arc over 120° rising 8 m from the south: spiral: { x: " +
    "0, z: 0, radius: 17, from: 270, turn: 120, y: 0.5, rise: 8 }; rise 0 is a flat arc. THROUGH NODES: for a route " +
    "over platforms (the critical path), don't compute points: give `through: { stops, style?, apex? }` instead. Stops " +
    "are, in order, node IDs (a platform, a room's floor, a ramp, an instance, a note), array items (array_3/5), every " +
    "item of an array (array_3/*, skipped ones left out) or a range (array_3/2..6), and batch refs ($ring/*); each is the " +
    "center of its walking surface. style jumps (the default) draws an arc per hop, peaking `apex` m (default 1.2) " +
    "above the higher stop; straight a polyline. It's kept up to date: move a platform, resize it or change an array's " +
    "layout and the line follows in that step; a removed stop drops out (with fewer than 2 left, the line keeps its " +
    "points, unlinked). Giving it points, or moving it without its stops, unlinks it; update_nodes { through } gives it " +
    "new stops, { through: null } unlinks it. " +
    "It has no kind, x, z, y, " +
    "height or rotation; move_nodes, rotate_nodes and mirror_nodes change its points.",
  notes:
    "A NOTE (type: note) is a post-it pinned to a point: x, z and y (the surface it stands on: a floor's y, a " +
    "platform's top), its `text`, an optional `label` of up to 3 characters shown on its flag (\"TK\", \"?\"; without " +
    "one it's a plain pin), a `color` (default yellow) and a `status`: open (a work item) or done (handled). Its text can " +
    "refer to skills (@name) and tags (#name). Notes have no size, kind or tags; move_nodes, rotate_nodes and " +
    "mirror_nodes move their point, and a note in a group moves with it, so pin a note about a room inside the room's " +
    "group. Every open note is in get_scene's `notes` (wherever it is, at any depth; with a root, those in it), short: " +
    "its id, label, point and the start of its text (notes: \"full\" for every field, false for only a count), and find_nodes { type: note, " +
    "status: done } finds the handled ones; find_nodes' name also searches a note's text. An area is described in the " +
    "text (\"slow the player down within 10 m of here\"): read it, act on it when asked, and mark the note done " +
    "(update_nodes status: done) rather than removing it, so the human sees what was handled. Leave notes of your own " +
    "for assumptions and questions (\"I assumed a 3 m jump here\").",
  groups:
    "A group (type: group) has NO position of its own: its shapes keep absolute world coordinates, and a node is in " +
    "a group when its `parent` is that group's ID (groups can nest). get_scene adds each group's derived `bounds` " +
    "(center x/z, bottom y, sizes) and `contains` (what's under it). A group can have a `description` (what that part " +
    'of the level is: "entry hall, safe zone"), set with update_nodes or group_nodes; the outline shows it, so ' +
    "describe the main areas. Tools act on a group as a unit: move_nodes and rotate_nodes on a group move or turn " +
    "everything in it in one step. A group left empty disappears. Draw straight into a group with draw_shapes' " +
    "`parent`. To make a group and what's in it in ONE call, put a group entry first in draw_shapes: { type: " +
    "\"group\", ref: \"chamber\", name, description, tags? }, then parent: \"$chamber\" on the entries that go in it; a " +
    "door hole drawn into it cuts the room's walls from the start (a hole needs a group to cut in). Refs work for " +
    "layout.along.id too (a line and the array following it). To repeat things (a row of pillars, a second wing, another floor), copy them with move_nodes and copy: " +
    "true (count for several, each offset further) instead of retyping shapes: copies get new IDs and keep their " +
    "names, structure and parent group. For symmetry, mirror_nodes flips nodes in place on a WORLD axis (x or z, not " +
    "the camera's view): copy a wing with move_nodes, then mirror the copy, instead of computing reflected positions " +
    "by hand. rotate_nodes turns around the bounds' center by default and returns that `pivot`: pass it back to turn " +
    "something back exactly.",
};

/** A topic's text; `design` is the open project's own guide. */
export const guideTopic = (topic: GuideTopic, designGuide: string) =>
  topic === "design" ? designGuide.trim() || "This project has no design guide yet. The human can write one in the editor's Library panel (Guide)." : GUIDE[topic];
export const topicList = () => GUIDE_TOPICS.map((t) => `${t}: ${TOPIC_SUMMARIES[t]}`).join("\n");

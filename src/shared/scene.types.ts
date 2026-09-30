import { z } from "zod";
import { LibraryEditSchema, type Library, type Uses } from "./library";

export type Actor = "human" | "agent";

/**
 * A room is hollow (floor and walls, no ceiling); a volume is solid (something you stand on or bump into); a hole
 * cuts itself out of the shapes in its own group and its sibling groups (a door, a window, a hole in a floor).
 */
export type ShapeKind = "room" | "volume" | "hole";

/**
 * The palette: the keys are the contract (the agent and the editor use them), the hex values are the material's
 * base color and can be tuned freely. The three neutrals are fixed; the pastels are starting values.
 */
export const PALETTE = {
  white: "#ffffff",
  "almost-white": "#ededed",
  gray: "#c4c4c4",
  blue: "#b9d0ee",
  yellow: "#f3e3a3",
  orange: "#f4c69c",
  red: "#eeaaa4",
  green: "#bddcb2",
  brown: "#cdb49b",
  black: "#5d5c5a",
} as const;
export type ShapeColor = keyof typeof PALETTE;
export const SHAPE_COLORS = Object.keys(PALETTE) as [ShapeColor, ...ShapeColor[]];
export const DEFAULT_COLOR: ShapeColor = "almost-white";

/**
 * What boxes and cylinders share. Meters, y up. The footprint is centered at `x, z` on the ground plane, with
 * `width` along the shape's local x and `depth` along its local z. It rises from its elevation `y` (its bottom;
 * 0 = on the ground, negative = below) to `y + height`. `rotation` turns it around the vertical axis through its
 * center, in degrees, counterclockwise seen from above (a right-handed turn about +y); 0 = grid-aligned.
 */
type Footprinted = {
  id: string; // server-assigned, "box_1", "cylinder_1", ... never reused
  name?: string; // for people and the agent ("lobby"); not unique
  tags?: string[]; // library tag names ("climbable"), from 08
  parent?: string; // the group it's in; none = top level
  locked?: true; // can't be picked in the view (a human's editing aid; the outliner and the agent still reach it)
  hidden?: true; // not drawn in the view (a human's aid, like locked; a hidden hole cuts nothing there)
  kind: ShapeKind;
  x: number;
  z: number;
  y: number;
  width: number; // > 0
  depth: number; // > 0
  height: number; // >= MIN_HEIGHT
  rotation: number; // degrees, 0..360
  color: ShapeColor;
  wall?: number; // rooms only: the walls' thickness, grown inward from the footprint; none = DEFAULT_WALL
  taper?: number; // volumes and holes only: 0..1, how much the top shrinks toward the center (1 = a point); none = 0
  bevel?: number; // volumes and holes only: 0..1, how round the top edge is (1 = as round as it fits); none = 0
  pitch?: number; // volumes and holes only: degrees around the local x axis through the center (+ leans the top toward local +z); none = 0
  roll?: number; // volumes and holes only: degrees around the local z axis through the center (+ leans the top toward local -x); none = 0
  createdBy: Actor;
};

export type Box = Footprinted & { type: "box" };

/**
 * A cylinder: its footprint is the ellipse inscribed in width × depth (an oval when they differ). With `sides` it's
 * a regular polygon on that ellipse instead, with a flat edge facing local +x; without, it's smooth.
 */
export type Cylinder = Footprinted & { type: "cylinder"; sides?: number };

/** An offset on the ground, e.g. a bezier handle relative to its point. */
export type Offset = { x: number; z: number };

/**
 * A free-form shape's point, in absolute world x/z. `in` and `out` are its bezier handles, as offsets from the
 * point; a point without handles is a corner. The edge from point i to point i + 1 is straight unless i has `out`
 * or i + 1 has `in`.
 */
export type FootPoint = { x: number; z: number; in?: Offset; out?: Offset };

/**
 * A free-form shape: a closed outline of points (3 or more, the last joins the first) in absolute world x/z, at
 * elevation `y`, rising to `y + height`. No center, size or rotation of its own: moving, turning and mirroring it
 * change its points. The outline must not cross itself.
 */
export type Freeform = {
  id: string; // "freeform_1", ...
  type: "freeform";
  name?: string;
  tags?: string[];
  parent?: string;
  locked?: true;
  hidden?: true;
  kind: ShapeKind;
  y: number;
  height: number;
  color: ShapeColor;
  wall?: number; // rooms only, as a box's
  taper?: number; // volumes and holes only, as a box's (toward the outline's centroid)
  bevel?: number; // volumes and holes only, as a box's
  pitch?: number; // from 14.4: degrees around the world x axis through its outline's center, at half its height; none = 0
  roll?: number; // around the world z axis, as a box's roll
  points: FootPoint[];
  createdBy: Actor;
};

/** An offset in 3D, e.g. a line point's bezier handle relative to its point. */
export type Offset3 = { x: number; y: number; z: number };

/** A line's point, in absolute world x/y/z, with optional bezier handles (offsets from the point, in 3D). */
export type LinePoint = { x: number; y: number; z: number; in?: Offset3; out?: Offset3 };

export type LineArrow = "none" | "end" | "both";

/**
 * A line: an open path of points (2 or more) in absolute world x/y/z, for annotations (a jump arc, a patrol
 * route). The edge from point i to point i + 1 curves when i has `out` or i + 1 has `in`, as on a free-form. It has
 * no kind, elevation or height: its points carry their own y. `thickness` is in screen pixels (constant at any
 * zoom), `arrow` "end" points at the last point.
 */
export type Line = {
  id: string; // "line_1", ...
  type: "line";
  name?: string;
  parent?: string;
  locked?: true;
  hidden?: true;
  color: ShapeColor;
  points: LinePoint[];
  thickness: number;
  dashed: boolean;
  arrow: LineArrow;
  through?: Through; // its points come from these stops, kept up to date (13.4)
  createdBy: Actor;
};

/** A ramp's point: in absolute world x/y/z (the surface's height there), with flat bezier handles (offsets on the ground). */
export type RampPoint = { x: number; y: number; z: number; in?: Offset; out?: Offset };

/** A ramp's underside: `solid` fills down to its lowest point, `floating` is a slab under its surface. */
export type RampBase = "solid" | "floating";

/**
 * A ramp: a path with a width, walkable along its top: a ramp, a flight of stairs (with `step`), a landing (two
 * points at the same height), a walkway or a spiral stair. Its points (2 or more) are the path's centerline in
 * absolute world x/z, each with the surface's height `y` there; between two points the height changes evenly with
 * the distance along the ground, and curves come from the points' flat handles. `step` is the riser height (none =
 * smooth). Always a volume: never a room, and never a hole (a hole that cuts stairs and floors at once cuts too much).
 */
export type Ramp = {
  id: string; // "ramp_1", ...
  type: "ramp";
  name?: string;
  tags?: string[];
  parent?: string;
  locked?: true;
  hidden?: true;
  kind: "volume";
  points: RampPoint[];
  width: number;
  step?: number;
  base: RampBase;
  color: ShapeColor;
  createdBy: Actor;
};

export type NoteStatus = "open" | "done";

/**
 * A note (from 08): a post-it pinned to a point in the scene, for the human and the agent. `x, y, z` is where it's
 * pinned (y the surface it stands on). `label` is up to 3 characters shown on its flag ("TK"); without one it's a
 * plain pin. Its text can refer to @skills and #tags. `status` is open (a work item) or done. Like a line, it's an
 * annotation: no kind, size or mesh; moving, rotating and mirroring move its point.
 */
export type Note = {
  id: string; // "note_1", ...
  type: "note";
  name?: string;
  parent?: string;
  locked?: true;
  hidden?: true;
  x: number;
  y: number;
  z: number;
  text: string;
  label?: string;
  color: ShapeColor;
  status: NoteStatus;
  createdBy: Actor;
};

/**
 * An instance of an entity (from 08): a placed copy of a definition, a small scene of its own shapes around a pivot
 * (its bottom center, at the origin). It shows those shapes turned by `rotation` (degrees, counterclockwise seen
 * from above) around the pivot, then moved to `x, y, z`. Its description and tags are the entity's; it has only a
 * place, a turn and a name of its own. For holes it's a group: its shapes are "directly in" it.
 */
/** What an instance or array stands on (plan 13 §7): another node's walking surface, kept up to date. */
export type StandOn = { id: string };
/** Where an array's item stands (13.4): its pivot on what it's on, and on another array that item's turn too. */
export type StandPose = { x: number; y: number; z: number; rotation?: number };
/** How a through line joins its stops: an arc per hop, or straight. */
export const THROUGH_STYLES = ["jumps", "straight"] as const;
export type ThroughStyle = (typeof THROUGH_STYLES)[number];
/**
 * A through line's stops (plan 13 §7): node IDs, array items (`array_3/5`), every item of an array (`array_3/*`) or
 * a range of them (`array_3/2..6`). Its points come from their walking surfaces, kept up to date.
 */
export type Through = { stops: string[]; style: ThroughStyle; apex?: number };
/** How far above the higher stop a jump arc peaks, by default. */
export const DEFAULT_APEX = 1.2;

export type Instance = {
  id: string; // "instance_1", ...
  type: "instance";
  entity: string; // the entity's ID ("tree-tall")
  name?: string;
  parent?: string;
  locked?: true;
  hidden?: true;
  x: number;
  y: number;
  z: number;
  rotation: number;
  scale?: number; // uniform, around its pivot (14.3); none = 1
  pitch?: number; // tilt around its own x axis through its pivot (14.4), as a box's; none = 0
  roll?: number; // around its own z axis; none = 0
  on?: StandOn; // standing on another node: y is its top under the pivot (13.4)
  createdBy: Actor;
};

/** The smallest and largest uniform scale an instance or array can have (14.3). */
export const MIN_SCALE = 0.01;
export const MAX_SCALE = 100;

/** One of an array's entities, and how often it's chosen among them (default 1). */
export type ArrayEntity = { entity: string; weight?: number };

/** How a path array spaces its items: every `spacing` meters (fitted), `count` evenly, on every point, or mid-edge. */
export type ArrayPlace = "spacing" | "count" | "corners" | "midpoints";

/**
 * Where an array's items go (plan 10 §3). A path is a line's points (absolute world x/y/z, 3D handles), open or
 * closed; a circle is a center, a radius and angles (from 0 = east, counterclockwise seen from above); a grid is a
 * center and a turn, with columns along its local x, rows along its local z and layers up.
 */
/**
 * What a path array follows (10.3): another node's outline, `id` a box, cylinder, free-form, ramp or line. A closed
 * shape's outline at its top (the default) or bottom, moved `offset` meters inward (default: half a room's wall, 0
 * for a volume); a ramp's surface along its centerline, or a line's path, `offset` meters to the right of travel.
 */
export type Follow = { id: string; at?: "top" | "bottom"; offset?: number };

export type PathLayout = {
  type: "path";
  points: LinePoint[]; // a following path's are its target's path as it is now (the store keeps them up to date)
  closed?: true;
  along?: Follow;
  place: ArrayPlace;
  spacing?: number; // place: spacing, meters (the real spacing is fitted to the path)
  count?: number; // place: count
};
export type CircleLayout = { type: "circle"; x: number; y: number; z: number; radius: number; count: number; start?: number; sweep?: number; rise?: number };
export type GridLayout = {
  type: "grid";
  x: number;
  y: number;
  z: number;
  rotation?: number;
  columns: number;
  rows: number;
  layers?: number;
  spacing: { x: number; z: number; y?: number };
  stagger?: true;
};
/**
 * Items scattered at random (10.2), in a circle (`x, z, radius`) or in an area (`area`, a closed outline as a
 * free-form's), at height `y`, at least `minDistance` apart. `rotation` turns the frame they're scattered in, so
 * turning the array turns the same pattern (and a fixed item turns with it).
 */
export type ScatterLayout = {
  type: "scatter";
  y: number;
  x?: number;
  z?: number;
  radius?: number;
  area?: FootPoint[];
  count: number;
  minDistance?: number;
  rotation?: number;
};
export type ArrayLayout = PathLayout | CircleLayout | GridLayout | ScatterLayout;
export type ArrayLayoutType = ArrayLayout["type"];

/**
 * How an array turns each item (plan 10 §3): `fixed` as drawn, `along` its path, `tangent` / `out` / `in` on a
 * circle, or `random`. Along and tangent turn the entity's local +x along the way; out turns it away from the
 * circle's center, in toward it.
 */
export type ArrayFacing = "fixed" | "along" | "tangent" | "out" | "in" | "random";

/**
 * An array (from 10): a node that repeats entities on a layout, live. Its **items** are instances the layout places
 * (virtual, `array_3/7`, drawn and cut like instances in the array's own place in the tree: the array adds no level
 * for holes). `rotation` is added to every item's facing, then the seeded noise (`jitter` meters on the ground,
 * `turnJitter` ± degrees). `skip` lists the item indices left out.
 */
export type ArrayNode = {
  id: string; // "array_1", ...
  type: "array";
  name?: string;
  parent?: string;
  locked?: true;
  hidden?: true;
  entities: ArrayEntity[];
  layout: ArrayLayout;
  facing?: ArrayFacing;
  rotation?: number;
  jitter?: number;
  turnJitter?: number;
  seed?: number;
  skip?: number[];
  scale?: number; // every item's uniform scale, around its pivot (14.3); none = 1
  pitch?: number; // the whole array tilted around the world x axis through its layout's anchor (14.4); none = 0
  roll?: number; // around the world z axis (roll first, then pitch); none = 0
  on?: StandOn; // standing on another node (13.4): each item on its top; on another array, on its item i
  stand?: (StandPose | null)[]; // derived from `on`, by layout index (null: where the layout puts it)
  createdBy: Actor;
};

/** A closed shape: one with a footprint, a kind (room or volume), an elevation and a height. */
export type ClosedShape = Box | Cylinder | Freeform;
/** A solid: a shape with a kind and a mesh, that holes cut (a closed shape or a ramp; only closed shapes are holes). */
export type Solid = ClosedShape | Ramp;
/** Anything drawn: every node that isn't a group. */
export type Shape = ClosedShape | Line | Ramp | Note | Instance | ArrayNode;
export type ShapeType = Shape["type"];

/**
 * A group: a container with no position, size or rotation of its own (Figma-style). Its boxes keep their world
 * coordinates, and its bounds are derived from them. A unit of action: moving or deleting it acts on everything
 * inside, as one step.
 */
export type Group = {
  id: string; // server-assigned, "group_1", ... never reused
  type: "group";
  name?: string;
  description?: string; // what this part of the level is, for people and the agent ("entry hall, safe zone")
  tags?: string[];
  parent?: string;
  locked?: true;
  hidden?: true;
  createdBy: Actor;
};

/** Anything in the scene's flat list. (Not `Node`, which is the DOM's.) */
export type SceneNode = Shape | Group;

/**
 * The shape fields an edit can change. `wall` is for rooms (undefined = the default), `taper` and `bevel` for
 * volumes (undefined = 0), `pitch` and `roll` for box and cylinder volumes (undefined = 0), `sides` for cylinders
 * (undefined = smooth), `points` for free-forms, lines and ramps, `thickness`, `dashed` and `arrow` for lines,
 * `step` and `base` for ramps (whose `width` is their own).
 */
export type ShapePatch = Partial<Pick<Footprinted, "name" | "kind" | "x" | "z" | "y" | "width" | "depth" | "height" | "rotation" | "color" | "wall" | "taper" | "bevel" | "pitch" | "roll">> & {
  sides?: number;
  points?: FootPoint[] | LinePoint[] | RampPoint[];
  step?: number;
  base?: RampBase;
  thickness?: number;
  dashed?: boolean;
  arrow?: LineArrow;
  text?: string;
  label?: string;
  status?: NoteStatus;
  entity?: string;
  // Arrays (from 10).
  entities?: ArrayEntity[];
  layout?: ArrayLayout;
  facing?: ArrayFacing;
  jitter?: number;
  turnJitter?: number;
  seed?: number;
  skip?: number[];
  // An instance's or array's uniform scale (from 14.3).
  scale?: number;
  // Standing on and lines through (from 13.4).
  on?: StandOn;
  stand?: (StandPose | null)[];
  through?: Through;
};
/** What an update op can change on any node: shape fields (shapes only), `description` (groups only), `name` and `parent`. */
export type NodePatch = ShapePatch & { parent?: string; description?: string; tags?: string[]; locked?: true; hidden?: true };

/**
 * What the editor currently shows. The camera looks down at the ground (x/z plane, y up) at a fixed pitch,
 * so the visible ground is a rotated quad; `bounds` is the axis-aligned box around it.
 */
export type View = {
  focus: { x: number; z: number }; // ground point under the screen center
  yaw: number; // degrees, 0..360
  bounds: { x: number; z: number; width: number; depth: number };
  isolated?: string; // the node isolated in the editor (only it and what's in it show); none = everything shows
  walking?: Walking; // while the human walks through the level (09.2)
  pointer?: { x: number; y: number; z: number; id?: string }; // where the human's pointer last rested (14.1)
};

export type Scene = {
  view: View;
  /** IDs of the nodes selected in the editor (last tab to change it wins). Not an edit, not undoable. */
  selection: string[];
  /** Boxes and groups, one flat list; `parent` makes the tree, and the order is the order among siblings. */
  nodes: SceneNode[];
};

/** What the editor needs to show Undo / Redo: whether each is possible, and the label of the step it would revert. */
export type HistorySummary = { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string };

export const DEFAULT_VIEW: View = {
  focus: { x: 0, z: 0 },
  yaw: 45,
  bounds: { x: -30, z: -20, width: 60, depth: 40 },
};
/**
 * The compass: which world axis each direction is, the same for every scene. With y up and +x east, north is -z
 * (at yaw 0 the camera looks north, so north is up the screen).
 */
export const COMPASS = { north: "-z", east: "+x", south: "+z", west: "-x" } as const;
/** The longest description a group can have, in characters. */
export const MAX_DESCRIPTION = 2000;
/** The most tags a node can have. */
export const MAX_TAGS = 20;
/** Ground snap for footprints. */
export const SNAP = 0.5;
/** Vertical snap for heights, and the smallest height a box can have. */
export const HEIGHT_SNAP = 0.05;
export const MIN_HEIGHT = HEIGHT_SNAP;
export const DEFAULT_HEIGHT: Record<ShapeKind, number> = { room: 3, volume: 0.25, hole: 2.2 };
/**
 * A room's walls are this thick unless it sets `wall`, and never thinner than MIN_WALL. They grow inward from the
 * footprint, which is the room's outside.
 */
export const DEFAULT_WALL = 0.2;
export const MIN_WALL = 0.05;
/**
 * Which kinds each kind-specific field is for: a room's walls, a volume's or hole's taper, bevel and tilt. Changing a shape's kind
 * drops the fields its new kind doesn't have.
 */
export const KIND_FIELDS = {
  wall: ["room"],
  taper: ["volume", "hole"],
  bevel: ["volume", "hole"],
  // Rooms tilt too from 14.4 (a whole tilted group of rooms and props).
  pitch: ["room", "volume", "hole"],
  roll: ["room", "volume", "hole"],
} as const satisfies Record<string, readonly ShapeKind[]>;
/** The tilt fields: every closed shape has them (from 14.4; before, only boxes and cylinders). */
export const TILT_FIELDS = ["pitch", "roll"] as const;
export type KindField = keyof typeof KIND_FIELDS;
/** A cylinder's side count, when it has one; without, it's smooth. */
export const MIN_SIDES = 3;
export const MAX_SIDES = 64;
/** How many segments a smooth cylinder is drawn and picked with. */
export const SMOOTH_SEGMENTS = 64;
/** A free-form's outline has at least this many points, and at most this many. */
export const MIN_POINTS = 3;
export const MAX_POINTS = 500;
/** How many straight segments each curved edge of a free-form or a line is drawn, picked and checked with. */
export const CURVE_SEGMENTS = 16;
/** A line has at least this many points (and at most MAX_POINTS). */
export const MIN_LINE_POINTS = 2;
/** A line's thickness in screen pixels. New lines default to black: a near-white line vanishes on the ground. */
export const MIN_THICKNESS = 1;
export const MAX_THICKNESS = 12;
export const DEFAULT_THICKNESS = 3;
export const DEFAULT_LINE_COLOR: ShapeColor = "black";
export const LINE_ARROWS = ["none", "end", "both"] as const;
/** Arrays (plan 10 §3): at most this many items and entities each, and at least this spacing along a path. */
export const MAX_ARRAY_ITEMS = 500;
export const MAX_ARRAY_ENTITIES = 8;
export const MIN_ARRAY_SPACING = 0.1;
export const ARRAY_PLACES = ["spacing", "count", "corners", "midpoints"] as const;
export const ARRAY_FACINGS = ["fixed", "along", "tangent", "out", "in", "random"] as const;
export const ARRAY_LAYOUTS = ["path", "circle", "grid", "scatter"] as const;
/** A ramp is this wide unless it says otherwise, and at least MIN_RAMP_WIDTH. */
export const DEFAULT_RAMP_WIDTH = 1.5;
export const MIN_RAMP_WIDTH = 0.2;
/** The smallest step (riser) a stepped ramp can have. */
export const MIN_STEP = 0.05;
/**
 * A floating ramp's slab under its surface, and how far a solid ramp's flat bottom sits below its lowest point (so
 * a landing on the floor still has some thickness).
 */
export const RAMP_SLAB = 0.2;
export const RAMP_SINK = 0.02;
export const RAMP_BASES = ["solid", "floating"] as const;
export const NOTE_STATUSES = ["open", "done"] as const;
export const DEFAULT_NOTE_COLOR: ShapeColor = "yellow";
/** A note's longest text, and its label's (the letters on its flag). */
export const MAX_NOTE_TEXT = 4000;
export const MAX_NOTE_LABEL = 3;

export const ShapeKindSchema = z.enum(["room", "volume", "hole"]);
export const ShapeColorSchema = z.enum(SHAPE_COLORS);

const field = {
  kind: ShapeKindSchema.describe("room = hollow (floor + walls, no ceiling); volume = solid; hole = cuts the shapes in its group and its sibling groups"),
  x: z.number().describe("Footprint center x, meters"),
  z: z.number().describe("Footprint center z, meters"),
  y: z.number().describe("Elevation of the box's bottom, meters. 0 = on the ground, negative = below ground"),
  width: z.number().positive().describe("Extent along the box's local x (world +x at rotation 0), meters, > 0"),
  depth: z.number().positive().describe("Extent along the box's local z (world +z at rotation 0), meters, > 0"),
  height: z.number().min(MIN_HEIGHT).describe(`Meters, >= ${MIN_HEIGHT}`),
  rotation: z.number().describe("Degrees around the vertical axis through the center, counterclockwise seen from above"),
  color: ShapeColorSchema.describe(`Palette key: ${SHAPE_COLORS.join(", ")}`),
  name: z.string().describe('A label for people, e.g. "lobby". Not unique'),
  tags: z
    .array(z.string())
    .max(MAX_TAGS)
    .describe('Library tag names, without the #, e.g. ["climbable"]. Each must exist in the project library (update_library adds tags)'),
  parent: z.string().describe("ID of the group to put it in, e.g. group_1"),
  sides: z
    .number()
    .int()
    .min(MIN_SIDES)
    .max(MAX_SIDES)
    .describe(`Cylinders only: ${MIN_SIDES}..${MAX_SIDES} sides make a regular polygon (a flat edge faces local +x); omit for a smooth circle or oval`),
  wall: z
    .number()
    .min(MIN_WALL)
    .describe(`Rooms only: the walls' thickness in meters (>= ${MIN_WALL}, default ${DEFAULT_WALL}), grown inward from the footprint`),
  taper: z.number().min(0).max(1).describe("Volumes and holes only: 0 (straight sides, the default) to 1 (the top comes to a point, a pyramid or cone)"),
  bevel: z.number().min(0).max(1).describe("Volumes and holes only: 0 (a sharp top edge, the default) to 1 (the top edge as round as it fits, a dome)"),
  pitch: z
    .number()
    .describe("Closed shapes: degrees around the shape's own x axis through its center (a free-form's: the world's x); + leans the top toward local +z. Default 0"),
  roll: z
    .number()
    .describe("Closed shapes: degrees around the shape's own z axis through its center (a free-form's: the world's z); + leans the top toward local -x. Default 0"),
};

const ActorSchema = z.enum(["human", "agent"]);

const TagsSchema = z.array(z.string());

const footprinted = {
  id: z.string(),
  name: z.string().optional(),
  tags: TagsSchema.optional(),
  parent: z.string().optional(),
  locked: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  kind: ShapeKindSchema,
  x: z.number(),
  z: z.number(),
  y: z.number(),
  width: z.number().positive(),
  depth: z.number().positive(),
  height: z.number().min(MIN_HEIGHT),
  rotation: z.number(),
  color: ShapeColorSchema,
  wall: z.number().min(MIN_WALL).optional(),
  taper: z.number().min(0).max(1).optional(),
  bevel: z.number().min(0).max(1).optional(),
  pitch: z.number().optional(),
  roll: z.number().optional(),
  createdBy: ActorSchema,
};
const OffsetSchema = z.object({ x: z.number(), z: z.number() });
const Offset3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });
const LinePointSchema = z.object({ x: z.number(), y: z.number(), z: z.number(), in: Offset3Schema.optional(), out: Offset3Schema.optional() });
const FootPointSchema = z.object({ x: z.number(), z: z.number(), in: OffsetSchema.optional(), out: OffsetSchema.optional() });
const BoxSchema = z.object({ ...footprinted, type: z.literal("box") });
const CylinderSchema = z.object({ ...footprinted, type: z.literal("cylinder"), sides: z.number().int().min(MIN_SIDES).max(MAX_SIDES).optional() });

const FreeformSchema = z.object({
  id: z.string(),
  type: z.literal("freeform"),
  name: z.string().optional(),
  tags: TagsSchema.optional(),
  parent: z.string().optional(),
  locked: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  kind: ShapeKindSchema,
  y: z.number(),
  height: z.number().min(MIN_HEIGHT),
  color: ShapeColorSchema,
  wall: z.number().min(MIN_WALL).optional(),
  taper: z.number().min(0).max(1).optional(),
  bevel: z.number().min(0).max(1).optional(),
  pitch: z.number().optional(),
  roll: z.number().optional(),
  points: z.array(FootPointSchema).min(MIN_POINTS).max(MAX_POINTS),
  createdBy: ActorSchema,
});

const LineSchema = z.object({
  id: z.string(),
  type: z.literal("line"),
  name: z.string().optional(),
  parent: z.string().optional(),
  locked: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  color: ShapeColorSchema,
  points: z.array(LinePointSchema).min(MIN_LINE_POINTS).max(MAX_POINTS),
  thickness: z.number().min(MIN_THICKNESS).max(MAX_THICKNESS),
  dashed: z.boolean(),
  arrow: z.enum(LINE_ARROWS),
  through: z.object({ stops: z.array(z.string()).min(2).max(MAX_POINTS), style: z.enum(THROUGH_STYLES), apex: z.number().optional() }).optional(),
  createdBy: ActorSchema,
});

const RampPointSchema = z.object({ x: z.number(), y: z.number(), z: z.number(), in: OffsetSchema.optional(), out: OffsetSchema.optional() });
const RampSchema = z.object({
  id: z.string(),
  type: z.literal("ramp"),
  name: z.string().optional(),
  tags: TagsSchema.optional(),
  parent: z.string().optional(),
  locked: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  // 07 let a ramp be a hole: those load as volumes.
  kind: z.enum(["volume", "hole"]).transform((): "volume" => "volume"),
  points: z.array(RampPointSchema).min(MIN_LINE_POINTS).max(MAX_POINTS),
  width: z.number().min(MIN_RAMP_WIDTH),
  step: z.number().min(MIN_STEP).optional(),
  base: z.enum(RAMP_BASES),
  color: ShapeColorSchema,
  createdBy: ActorSchema,
});

const NoteSchema = z.object({
  id: z.string(),
  type: z.literal("note"),
  name: z.string().optional(),
  parent: z.string().optional(),
  locked: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  text: z.string(),
  label: z.string().max(MAX_NOTE_LABEL).optional(),
  color: ShapeColorSchema,
  status: z.enum(NOTE_STATUSES),
  createdBy: ActorSchema,
});

const InstanceSchema = z.object({
  id: z.string(),
  type: z.literal("instance"),
  entity: z.string(),
  name: z.string().optional(),
  parent: z.string().optional(),
  locked: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  rotation: z.number(),
  scale: z.number().min(MIN_SCALE).max(MAX_SCALE).optional(),
  pitch: z.number().optional(),
  roll: z.number().optional(),
  on: z.object({ id: z.string() }).optional(),
  createdBy: ActorSchema,
});

const count = z.number().int().min(1);
const FollowSchema = z.object({ id: z.string(), at: z.enum(["top", "bottom"]).optional(), offset: z.number().optional() });
const ArrayEntitySchema = z.object({ entity: z.string(), weight: z.number().positive().optional() });
/** An array's layout as stored (see `ArrayLayout`). */
export const ArrayLayoutSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("path"),
    points: z.array(LinePointSchema).min(MIN_LINE_POINTS).max(MAX_POINTS * 20),
    closed: z.literal(true).optional(),
    along: FollowSchema.optional(),
    place: z.enum(ARRAY_PLACES),
    spacing: z.number().min(MIN_ARRAY_SPACING).optional(),
    count: count.optional(),
  }),
  z.object({
    type: z.literal("circle"),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    radius: z.number().positive(),
    count,
    start: z.number().optional(),
    sweep: z.number().positive().max(360).optional(),
    rise: z.number().optional(),
  }),
  z.object({
    type: z.literal("grid"),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    rotation: z.number().optional(),
    columns: count,
    rows: count,
    layers: count.optional(),
    spacing: z.object({ x: z.number().min(0), z: z.number().min(0), y: z.number().min(0).optional() }),
    stagger: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("scatter"),
    y: z.number(),
    x: z.number().optional(),
    z: z.number().optional(),
    radius: z.number().positive().optional(),
    area: z.array(FootPointSchema).min(MIN_POINTS).max(MAX_POINTS).optional(),
    count,
    minDistance: z.number().min(0).optional(),
    rotation: z.number().optional(),
  }),
]);

const ArraySchema = z.object({
  id: z.string(),
  type: z.literal("array"),
  name: z.string().optional(),
  parent: z.string().optional(),
  locked: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  entities: z.array(ArrayEntitySchema).min(1).max(MAX_ARRAY_ENTITIES),
  layout: ArrayLayoutSchema,
  facing: z.enum(ARRAY_FACINGS).optional(),
  rotation: z.number().optional(),
  jitter: z.number().min(0).optional(),
  turnJitter: z.number().min(0).max(180).optional(),
  seed: z.number().int().optional(),
  skip: z.array(z.number().int().min(0)).optional(),
  scale: z.number().min(MIN_SCALE).max(MAX_SCALE).optional(),
  pitch: z.number().optional(),
  roll: z.number().optional(),
  on: z.object({ id: z.string() }).optional(),
  stand: z.array(z.object({ x: z.number(), y: z.number(), z: z.number(), rotation: z.number().optional() }).nullable()).optional(),
  createdBy: ActorSchema,
});

const GroupSchema = z.object({
  id: z.string(),
  type: z.literal("group"),
  name: z.string().optional(),
  description: z.string().optional(),
  tags: TagsSchema.optional(),
  parent: z.string().optional(),
  locked: z.literal(true).optional(),
  hidden: z.literal(true).optional(),
  createdBy: ActorSchema,
});

/** A stored node, as in `scene.json` (and on the clipboard). */
export const NodeSchema: z.ZodType<SceneNode> = z.discriminatedUnion("type", [BoxSchema, CylinderSchema, FreeformSchema, LineSchema, RampSchema, NoteSchema, InstanceSchema, ArraySchema, GroupSchema]);

export const BoxInputSchema = z.strictObject({
  kind: field.kind,
  x: field.x,
  z: field.z,
  width: field.width,
  depth: field.depth,
  height: field.height
    .optional()
    .describe(`Meters, >= ${MIN_HEIGHT}. Defaults to ${DEFAULT_HEIGHT.room} for a room, ${DEFAULT_HEIGHT.volume} for a volume`),
  y: field.y.optional().describe("Elevation of the box's bottom, meters. Defaults to 0 (on the ground); negative = below ground"),
  rotation: field.rotation.optional().describe("Degrees, counterclockwise seen from above. Defaults to 0 (grid-aligned)"),
  color: field.color.optional().describe(`Palette key: ${SHAPE_COLORS.join(", ")}. Defaults to ${DEFAULT_COLOR}`),
  wall: field.wall.optional(),
  taper: field.taper.optional(),
  bevel: field.bevel.optional(),
  pitch: field.pitch.optional(),
  roll: field.roll.optional(),
  name: field.name.optional(),
  tags: field.tags.optional(),
  parent: field.parent.optional().describe("ID of the group to put it in, e.g. group_1. Omit for the top level"),
});
export type BoxInput = z.input<typeof BoxInputSchema>;
const OffsetInputSchema = z.strictObject({ x: z.number(), z: z.number() });
const FootPointInputSchema = z.strictObject({
  x: z.number().describe("World x, meters"),
  z: z.number().describe("World z, meters"),
  in: OffsetInputSchema.optional().describe("Bezier handle toward the previous point, as an offset from this point"),
  out: OffsetInputSchema.optional().describe("Bezier handle toward the next point, as an offset from this point"),
});
const PointsSchema = z
  .array(FootPointInputSchema)
  .min(MIN_POINTS)
  .max(MAX_POINTS)
  .describe(`The closed outline, ${MIN_POINTS}..${MAX_POINTS} points in absolute world x/z (the last joins the first); it must not cross itself`);

/** A free-form for `draw_shapes`: its points, kind, and the optional fields a box has, minus the footprint ones. */
export const FreeformInputSchema = z.strictObject({
  type: z.literal("freeform").describe("A closed outline of points, optionally curved with bezier handles"),
  kind: field.kind,
  points: PointsSchema,
  height: BoxInputSchema.shape.height,
  y: BoxInputSchema.shape.y,
  color: BoxInputSchema.shape.color,
  wall: BoxInputSchema.shape.wall,
  taper: BoxInputSchema.shape.taper,
  bevel: BoxInputSchema.shape.bevel,
  pitch: BoxInputSchema.shape.pitch,
  roll: BoxInputSchema.shape.roll,
  name: field.name.optional(),
  tags: field.tags.optional(),
  parent: BoxInputSchema.shape.parent,
});

const Offset3InputSchema = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });
const LinePointInputSchema = z.strictObject({
  x: z.number().describe("World x, meters"),
  y: z.number().describe("World y (height), meters: 0 = the ground, a platform's top to start from it"),
  z: z.number().describe("World z, meters"),
  in: Offset3InputSchema.optional().describe("Bezier handle toward the previous point, as a 3D offset from this point"),
  out: Offset3InputSchema.optional().describe("Bezier handle toward the next point, as a 3D offset from this point"),
});
const lineField = {
  thickness: z.number().min(MIN_THICKNESS).max(MAX_THICKNESS).describe(`Screen pixels, ${MIN_THICKNESS}..${MAX_THICKNESS} (constant at any zoom)`),
  dashed: z.boolean().describe("Dashed instead of solid"),
  arrow: z.enum(LINE_ARROWS).describe("Arrowheads: none, end (at the last point) or both"),
};

/** `through` for a line (plan 13 §7): its points come from stops, kept up to date. */
export const ThroughInputSchema = z
  .strictObject({
    stops: z
      .array(z.string())
      .min(2)
      .max(MAX_POINTS)
      .describe('In order: node IDs (a platform, a room\'s floor, a ramp, an instance), items ("array_3/5"), every item of an array ("array_3/*"), a range ("array_3/2..6"), or earlier entries\' $refs ("$ring/*")'),
    style: z.enum(THROUGH_STYLES).optional().describe("jumps (the default): an arc per hop, peaking apex m above the higher stop; straight: a polyline"),
    apex: z.number().min(0).optional().describe(`Jumps: meters above the higher stop of each hop. Default ${DEFAULT_APEX}`),
  })
  .describe("Instead of points: go through these stops, each the center of its walking surface, kept up to date as they move (a critical path)");

/**
 * A spiral, given instead of points to a ramp, a line or a path layout (plan 13 §5): the server turns it into points,
 * one every 90° at most, with circle handles.
 */
export const SpiralInputSchema = z.strictObject({
  x: z.number().describe("The spiral's center x"),
  z: z.number().describe("The spiral's center z"),
  radius: z.number().positive().describe("The radius, meters (a ramp's centerline)"),
  turn: z.number().describe("Degrees around, counterclockwise seen from above (negative: clockwise); 120 is an arc, 720 two full turns"),
  y: z.number().describe("The start's height"),
  rise: z.number().describe("How much it climbs over the whole turn (negative: descends; 0: a flat arc)"),
  from: z.number().optional().describe("The start's angle in degrees: 0 = east (+x), 90 = north (-z). Default 0"),
});

/** A line for `draw_shapes`: its points (or a spiral), and optional style. */
export const LineInputSchema = z.strictObject({
  type: z.literal("line").describe("An open path of 3D points, for annotations (a route, a jump arc)"),
  points: z
    .array(LinePointInputSchema)
    .min(MIN_LINE_POINTS)
    .max(MAX_POINTS)
    .optional()
    .describe(`The path, ${MIN_LINE_POINTS}..${MAX_POINTS} points in absolute world x/y/z (it doesn't close). Give points or spiral`),
  spiral: SpiralInputSchema.optional().describe("An arc or a spiral instead of points (a curved route, a spine for an array): the server turns it into points"),
  through: ThroughInputSchema.optional(),
  color: field.color.optional().describe(`Palette key: ${SHAPE_COLORS.join(", ")}. Defaults to ${DEFAULT_LINE_COLOR}`),
  thickness: lineField.thickness.optional().describe(`Screen pixels, ${MIN_THICKNESS}..${MAX_THICKNESS}. Defaults to ${DEFAULT_THICKNESS}`),
  dashed: lineField.dashed.optional().describe("Dashed instead of solid. Defaults to false"),
  arrow: lineField.arrow.optional().describe("Arrowheads: none (the default), end (at the last point) or both"),
  name: field.name.optional(),
  parent: BoxInputSchema.shape.parent,
});

const RampPointInputSchema = z.strictObject({
  x: z.number().describe("World x, meters"),
  y: z.number().describe("The surface's height here, meters (a floor's y, a platform's top)"),
  z: z.number().describe("World z, meters"),
  in: OffsetInputSchema.optional().describe("Flat bezier handle toward the previous point, as an offset { x, z } on the ground"),
  out: OffsetInputSchema.optional().describe("Flat bezier handle toward the next point, as an offset { x, z } on the ground"),
});
const rampField = {
  width: z.number().min(MIN_RAMP_WIDTH).describe(`Meters, centered on the path, >= ${MIN_RAMP_WIDTH}. Defaults to ${DEFAULT_RAMP_WIDTH}`),
  step: z.number().min(MIN_STEP).describe(`The riser height in meters (>= ${MIN_STEP}): stairs. Omit for a smooth ramp`),
  base: z.enum(RAMP_BASES).describe("solid (the default) fills down to its lowest point; floating is a slab under the surface"),
};

/**
 * A ramp for `draw_shapes`: its path as points, or as a `spiral` the server turns into points; the rest optional.
 */
export const RampInputSchema = z.strictObject({
  type: z.literal("ramp").describe("A path with a width: a ramp, stairs (with step), a landing, a walkway, a spiral stair"),
  kind: z.enum(["volume", "hole"]).optional().describe("always volume (the default): a ramp is never a hole"),
  points: z
    .array(RampPointInputSchema)
    .min(MIN_LINE_POINTS)
    .max(MAX_POINTS)
    .optional()
    .describe("The centerline, 2 or more points in absolute world x/z with the surface's y at each (give points or spiral)"),
  spiral: SpiralInputSchema.optional().describe("A spiral stair or ramp, instead of points: the server turns it into points (one every 90°)"),
  width: rampField.width.optional(),
  step: rampField.step.optional(),
  base: rampField.base.optional(),
  color: field.color.optional().describe(`Palette key: ${SHAPE_COLORS.join(", ")}. Defaults to ${DEFAULT_COLOR}`),
  name: field.name.optional(),
  tags: field.tags.optional(),
  parent: field.parent.optional().describe("ID of the group to put it in, e.g. group_1. Omit for the top level"),
});

/**
 * A new shape for `draw_shapes`: its `type` (box, the default, cylinder, freeform or line) and that type's fields.
 * Boxes and cylinders share every field; `sides` is for cylinders only (the store rejects it on a box).
 */
const noteField = {
  text: z.string().max(MAX_NOTE_TEXT).describe("What the note says. It can refer to skills (@name) and tags (#name)"),
  label: z.string().trim().max(MAX_NOTE_LABEL).describe(`Up to ${MAX_NOTE_LABEL} characters shown on its flag, e.g. "TK"; without one it's a plain pin`),
  status: z.enum(NOTE_STATUSES).describe("open (a work item, the default) or done (handled)"),
};

/** A note for `draw_shapes`: where it's pinned and what it says. */
export const NoteInputSchema = z.strictObject({
  type: z.literal("note").describe("A post-it pinned to a point: an intent, a question, a work item"),
  x: z.number().describe("World x, meters"),
  z: z.number().describe("World z, meters"),
  y: z.number().optional().describe("The height it stands at: the surface there (a floor's y, a platform's top). Defaults to 0"),
  text: noteField.text,
  label: noteField.label.optional(),
  status: noteField.status.optional(),
  color: field.color.optional().describe(`Palette key: ${SHAPE_COLORS.join(", ")}. Defaults to ${DEFAULT_NOTE_COLOR}`),
  name: field.name.optional(),
  parent: field.parent.optional().describe("ID of the group to put it in (it moves with the group). Omit for the top level"),
});

/** An instance for `draw_shapes`: which entity, and where. */
/** `on` for draw_shapes (plan 13 §7): what an instance or array stands on, kept up to date. */
const StandOnInputSchema = z
  .strictObject({ id: z.string().describe("The node to stand on (a platform, a room, a ramp, an instance, an array or an item), or an earlier entry's $ref") })
  .describe("Stand on another node's walking surface, kept up to date: y is its top under the pivot (instead of giving y). On an array, item by item");

/**
 * An instance's rotation as where it faces (plan 14 §5), worked out once into degrees: its local +x toward a point
 * {x, z} or a node or item, away from one, or along a line or ramp where it's nearest.
 */
const FacingTargetSchema = z.union([z.strictObject({ x: z.number(), z: z.number() }), z.string()]);
export const FacingInputSchema = z.union([
  z.number(),
  z.strictObject({ toward: FacingTargetSchema.describe("A point {x, z} or a node or item ID to face") }),
  z.strictObject({ away: FacingTargetSchema.describe("A point {x, z} or a node or item ID to turn its back on") }),
  z.strictObject({ along: z.string().describe("A line's or ramp's ID: face along it (its direction of travel) where it passes nearest") }),
]);

export const InstanceInputSchema = z.strictObject({
  type: z.literal("instance").describe("A placed copy of a library entity (a prefab): it shows the entity's shapes"),
  entity: z.string().describe('The entity\'s ID, e.g. "tree-tall" (get_library lists them)'),
  x: z.number().describe("Where its pivot (the entity's bottom center) goes: world x, meters"),
  z: z.number().describe("World z, meters"),
  y: z.number().optional().describe("The height its bottom stands at (a floor's y, a platform's top). Defaults to 0"),
  rotation: FacingInputSchema.optional().describe(
    "Degrees, counterclockwise seen from above, around its pivot (default 0); or where it faces (its local +x), worked out once: { toward: {x, z} or an ID }, { away: ... } or { along: a line or ramp }",
  ),
  scale: z.number().min(MIN_SCALE).max(MAX_SCALE).optional().describe("Its entity's shapes scaled uniformly around the pivot (walls and heights too). Default 1"),
  pitch: z.number().optional().describe("Degrees around its own x axis through its pivot (it leans toward its local +z). Default 0"),
  roll: z.number().optional().describe("Degrees around its own z axis through its pivot (roll first, then pitch). Default 0"),
  on: StandOnInputSchema.optional(),
  name: field.name.optional().describe('A name for this one, e.g. "entry_window". Not unique'),
  parent: field.parent.optional().describe("ID of the group to put it in. Omit for the top level"),
});

const arrayCount = z.number().int().min(1).max(MAX_ARRAY_ITEMS);
const FollowInputSchema = z.strictObject({
  id: z.string().describe("A box, cylinder or free-form (its outline), a ramp (its surface) or a line (its path)"),
  at: z.enum(["top", "bottom"]).optional().describe("A closed shape's top (default: its wall top, a volume's top) or bottom (its floor)"),
  offset: z
    .number()
    .optional()
    .describe("A closed shape: meters inward from its outline (default: half a room's wall, on its centerline; 0 for a volume). A ramp or line: meters to the right of travel (default 0)"),
});
/** An array's layout for `draw_shapes` and `update_nodes` (see get_guide arrays). */
export const ArrayLayoutInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("path").describe("Items along a path: a line's points"),
    points: z
      .array(LinePointInputSchema)
      .min(MIN_LINE_POINTS)
      .max(MAX_POINTS)
      .optional()
      .describe("The path, points in absolute world x/y/z as a line's (items stand at the path's height). Give points, spiral or along"),
    spiral: SpiralInputSchema.optional().describe("An arc or a spiral instead of points: items climb with it (a spiral of platforms round a tower)"),
    closed: z.boolean().optional().describe("The last point joins the first (a loop). Default false"),
    along: FollowInputSchema.optional().describe("Instead of points, FOLLOW another node's path, live: its items move when it changes"),
    place: z
      .enum(ARRAY_PLACES)
      .optional()
      .describe("spacing (every `spacing` m, fitted so the items land evenly; the default), count (`count` items evenly), corners (one on every point) or midpoints (one mid-edge)"),
    spacing: z.number().min(MIN_ARRAY_SPACING).optional().describe(`Meters between items (place: spacing), >= ${MIN_ARRAY_SPACING}; fitted to the path's length`),
    count: arrayCount.optional().describe("How many items (place: count), evenly along the path, both ends included on an open path"),
  }),
  z.strictObject({
    type: z.literal("circle").describe("Items on a circle (or an arc)"),
    x: z.number().describe("The center's world x"),
    z: z.number().describe("The center's world z"),
    y: z.number().optional().describe("The height the items stand at. Default 0"),
    radius: z.number().positive().describe("Meters from the center to each item's pivot"),
    count: arrayCount.describe("How many items"),
    start: z.number().optional().describe("The first item's angle in degrees: 0 = east (+x), 90 = north (-z). Default 0"),
    sweep: z.number().positive().max(360).optional().describe("Degrees covered, counterclockwise from start. Default 360 (evenly around); less than 360 puts items at both ends of the arc"),
    rise: z
      .number()
      .optional()
      .describe("Meters the items climb over the sweep, evenly (the last item rise above the first; over a full circle, rise over one turn): a spiral of platforms. Default 0"),
  }),
  z.strictObject({
    type: z.literal("grid").describe("Items in rows and columns (and layers)"),
    x: z.number().describe("The grid's center, world x"),
    z: z.number().describe("The grid's center, world z"),
    y: z.number().optional().describe("The bottom layer's height. Default 0"),
    rotation: z.number().optional().describe("Degrees the grid turns, counterclockwise seen from above. Default 0"),
    columns: arrayCount.describe("Along the grid's local x"),
    rows: arrayCount.describe("Along the grid's local z"),
    layers: arrayCount.optional().describe("Up, default 1"),
    spacing: z
      .strictObject({ x: z.number().min(0), z: z.number().min(0), y: z.number().min(0).optional() })
      .describe("Meters between columns (x), rows (z) and layers (y)"),
    stagger: z.boolean().optional().describe("Every other row offset by half a column (brick). Default false"),
  }),
  z.strictObject({
    type: z.literal("scatter").describe("Items scattered at random in a circle (x, z, radius) or in an area (area), seeded"),
    x: z.number().optional().describe("A circle's center, world x (with z and radius)"),
    z: z.number().optional().describe("A circle's center, world z"),
    radius: z.number().positive().optional().describe("A circle's radius, meters"),
    area: PointsSchema.optional().describe("An area instead of a circle: a closed outline as a free-form's points (absolute world x/z, bezier handles as offsets)"),
    y: z.number().optional().describe("The height the items stand at. Default 0"),
    count: arrayCount.describe("How many items (fewer when they can't all fit minDistance apart: the result says)"),
    minDistance: z.number().min(0).optional().describe("Meters at least between items' pivots. Default: the widest entity's width"),
    rotation: z.number().optional().describe("Degrees the scatter's frame turns (fixed items turn with it). Default 0"),
  }),
]);
const arrayField = {
  entities: z
    .array(z.strictObject({ entity: z.string(), weight: z.number().positive().optional().describe("How often it's chosen, default 1") }))
    .min(1)
    .max(MAX_ARRAY_ENTITIES)
    .describe(`1..${MAX_ARRAY_ENTITIES} entities, each item one of them, chosen by weight (a forest: small 5, big 3, tall 1)`),
  facing: z
    .enum(ARRAY_FACINGS)
    .describe("How each item turns: fixed (as drawn), along (a path's direction), tangent / out / in (a circle), random. Default: along on a path, tangent on a circle, fixed on a grid"),
  rotation: z.number().describe("Degrees added to every item's facing, counterclockwise seen from above. Default 0"),
  jitter: z.number().min(0).describe("Noise: each item moves up to this many meters on the ground. Default 0"),
  turnJitter: z.number().min(0).max(180).describe("Noise: each item turns up to ± this many degrees. Default 0"),
  seed: z.number().int().describe("The noise's and the entity choice's seed: the same seed, the same look. Default 1"),
  skip: z.array(z.number().int().min(0)).describe("Item indices to leave out (0 = the first, in layout order)"),
};

/** An array for `draw_shapes`: its entity (or entities), its layout, and how its items turn and vary. */
export const ArrayInputSchema = z.strictObject({
  type: z.literal("array").describe("Repeats entities on a layout (a path, a circle, a grid or a scatter), live: one node for many items"),
  entity: z.string().optional().describe('The entity to repeat, e.g. "merlon" (or give entities)'),
  entities: arrayField.entities.optional(),
  layout: ArrayLayoutInputSchema.optional().describe("Where its items go (required, unless it stands on another array: then it takes that array's, one item on each of its items)"),
  facing: arrayField.facing.optional(),
  rotation: arrayField.rotation.optional(),
  jitter: arrayField.jitter.optional(),
  turnJitter: arrayField.turnJitter.optional(),
  seed: arrayField.seed.optional(),
  skip: arrayField.skip.optional(),
  scale: z.number().min(MIN_SCALE).max(MAX_SCALE).optional().describe("Every item's entity scaled uniformly around its pivot. Default 1"),
  pitch: z.number().optional().describe("The whole array tilted: degrees around the world x axis through its layout's anchor (a circle's or grid's center). Default 0"),
  roll: z.number().optional().describe("Degrees around the world z axis through the anchor (roll first, then pitch). Default 0"),
  on: StandOnInputSchema.optional(),
  name: field.name.optional(),
  parent: field.parent.optional().describe("ID of the group to put it in (its items cut and are cut as instances there). Omit for the top level"),
});

/** A batch ref's name (plan 13 §6): a letter, then letters, digits, `_` or `-`. */
export const BATCH_REF = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/**
 * A name for a `draw_shapes` entry, so later entries of the same batch can use `$name` where an ID goes (`parent`,
 * `layout.along.id`): the ID it will get, which isn't known yet.
 */
const refField = {
  ref: z
    .string()
    .regex(BATCH_REF)
    .optional()
    .describe('A name for this entry in the batch (e.g. "chamber"): later entries use "$chamber" where an ID goes (parent, along.id). The result maps each ref to its ID'),
};

/** A group for `draw_shapes` (plan 13 §6): made in the batch, so what's drawn into it arrives with it (holes cut from the start). */
export const GroupInputSchema = z.strictObject({
  type: z.literal("group").describe("A group, drawn in the batch: give it a ref, and parent: \"$ref\" on what goes in it"),
  name: field.name.optional(),
  description: z.string().max(MAX_DESCRIPTION).optional().describe('What the group is, e.g. "entry hall, safe zone"'),
  tags: field.tags.optional(),
  parent: field.parent.optional().describe("ID of the group to put it in (or an earlier entry's $ref). Omit for the top level"),
});

export const ShapeInputSchema = z.discriminatedUnion("type", [
  BoxInputSchema.extend({
    type: z.enum(["box", "cylinder"]).optional().describe("box (the default) or cylinder (the ellipse inscribed in width × depth)"),
    sides: field.sides.optional(),
    ...refField,
  }),
  FreeformInputSchema.extend(refField),
  LineInputSchema.extend(refField),
  RampInputSchema.extend(refField),
  NoteInputSchema.extend(refField),
  InstanceInputSchema.extend(refField),
  ArrayInputSchema.extend(refField),
  GroupInputSchema.extend(refField),
]);
export type ShapeInput = z.input<typeof ShapeInputSchema>;

/** A change to an existing node, by ID: any of a shape's editable fields; for a group only `name` and `parent`. */
export const NodeUpdateSchema = z.strictObject({
  id: z.string().describe("ID of an existing node, e.g. box_3 or group_1"),
  type: z
    .literal("freeform")
    .optional()
    .describe("Converts a box or cylinder into a free-form with the same outline and a new freeform_N ID. Give it alone with the id"),
  kind: field.kind.optional(),
  x: field.x.optional(),
  z: field.z.optional(),
  y: field.y.optional(),
  width: field.width.optional().describe("Boxes and cylinders: the local x extent; ramps: the width, meters"),
  depth: field.depth.optional(),
  height: field.height.optional(),
  rotation: FacingInputSchema.optional().describe(
    "Degrees, counterclockwise seen from above; an instance also takes where it faces (its local +x), worked out once: { toward: {x, z} or an ID }, { away: ... } or { along: a line or ramp }",
  ),
  color: field.color.optional(),
  sides: field.sides.nullable().optional().describe(`Cylinders only: ${MIN_SIDES}..${MAX_SIDES} sides, or null to make it smooth`),
  wall: field.wall
    .nullable()
    .optional()
    .describe(`Rooms only: the walls' thickness in meters (>= ${MIN_WALL}), or null for the default ${DEFAULT_WALL}`),
  taper: field.taper.optional(),
  bevel: field.bevel.optional(),
  pitch: field.pitch.optional(),
  roll: field.roll.optional(),
  points: z
    .array(
      z.strictObject({
        x: z.number(),
        y: z.number().optional().describe("Lines only (a free-form's points have none: it has its own y)"),
        z: z.number(),
        in: z.strictObject({ x: z.number(), y: z.number().optional(), z: z.number() }).optional(),
        out: z.strictObject({ x: z.number(), y: z.number().optional(), z: z.number() }).optional(),
      }),
    )
    .min(MIN_LINE_POINTS)
    .max(MAX_POINTS)
    .optional()
    .describe("Free-forms, lines and ramps: the whole new outline or path (it replaces the old one), points as in draw_shapes"),
  step: rampField.step.nullable().optional().describe(`Ramps only: the riser height (>= ${MIN_STEP}), or null for a smooth ramp`),
  base: rampField.base.optional().describe("Ramps only: solid or floating"),
  thickness: lineField.thickness.optional().describe(`Lines only: ${MIN_THICKNESS}..${MAX_THICKNESS} screen pixels`),
  dashed: lineField.dashed.optional().describe("Lines only: dashed or solid"),
  arrow: lineField.arrow.optional().describe("Lines only: none, end or both"),
  name: field.name.optional().describe('A label for people, e.g. "lobby". Not unique. An empty string removes it'),
  tags: field.tags
    .nullable()
    .optional()
    .describe("Groups and closed shapes and ramps: the whole list of library tag names (without #), or null / [] to remove them"),
  text: noteField.text.optional().describe("Notes only: the whole new text"),
  label: noteField.label.nullable().optional().describe(`Notes only: up to ${MAX_NOTE_LABEL} characters on its flag; null or "" removes it`),
  status: noteField.status.optional().describe("Notes only: open or done (mark a note done when it's handled, rather than removing it)"),
  scale: z.number().min(MIN_SCALE).max(MAX_SCALE).optional().describe("Instances and arrays only: the uniform scale of its entity's shapes (1 = as defined)"),
  entity: z.string().optional().describe("Instances only: another entity's ID, to show it instead, in the same place"),
  entities: arrayField.entities.optional().describe("Arrays only: the whole list of entities (with weights)"),
  on: z
    .strictObject({ id: z.string() })
    .nullable()
    .optional()
    .describe("Instances and arrays only: stand on this node, kept up to date; null stops standing (it keeps its height)"),
  through: ThroughInputSchema.nullable()
    .optional()
    .describe("Lines only: go through these stops (the whole new list), kept up to date; null unlinks it (it keeps its points)"),
  layout: z
    .strictObject({
      type: z.enum(ARRAY_LAYOUTS).optional(),
      points: z.array(LinePointInputSchema).min(MIN_LINE_POINTS).max(MAX_POINTS).optional(),
      spiral: SpiralInputSchema.optional(),
      closed: z.boolean().optional(),
      along: z
        .strictObject({ id: z.string().optional(), at: z.enum(["top", "bottom"]).optional(), offset: z.number().nullable().optional() })
        .nullable()
        .optional(),
      place: z.enum(ARRAY_PLACES).optional(),
      spacing: z.union([z.number(), z.strictObject({ x: z.number(), z: z.number(), y: z.number().optional() })]).optional(),
      count: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      radius: z.number().optional(),
      start: z.number().optional(),
      sweep: z.number().optional(),
      rise: z.number().optional(),
      rotation: z.number().optional(),
      columns: z.number().int().optional(),
      rows: z.number().int().optional(),
      layers: z.number().int().optional(),
      stagger: z.boolean().optional(),
      area: z.array(FootPointInputSchema).min(MIN_POINTS).max(MAX_POINTS).optional(),
      minDistance: z.number().optional(),
    })
    .optional()
    .describe("Arrays only: layout fields to change (they merge into the layout); with another `type`, the whole new layout (as in draw_shapes)"),
  facing: arrayField.facing.optional().describe("Arrays only: how each item turns"),
  jitter: arrayField.jitter.optional().describe("Arrays only: position noise, meters"),
  turnJitter: arrayField.turnJitter.optional().describe("Arrays only: turn noise, ± degrees"),
  seed: arrayField.seed.optional().describe("Arrays only: the noise's seed (a new one rerolls)"),
  skip: arrayField.skip.optional().describe("Arrays only: the whole list of item indices left out ([] restores them all)"),
  description: z
    .string()
    .max(MAX_DESCRIPTION)
    .nullable()
    .optional()
    .describe('Groups only: what this part of the level is, e.g. "entry hall, safe zone". An empty string or null removes it'),
  parent: field.parent
    .nullable()
    .optional()
    .describe("ID of the group to move it into, e.g. group_1; null moves it to the top level"),
  locked: z
    .boolean()
    .optional()
    .describe("Any node: true locks it (the human can't pick it or what's in it in the view), false unlocks it"),
  hidden: z
    .boolean()
    .optional()
    .describe("Any node: true hides it and what's in it in the editor (not drawn; a hidden hole cuts nothing), false shows it"),
});
export type NodeUpdate = z.input<typeof NodeUpdateSchema>;

const IdsSchema = z.array(z.string()).min(1);

export const MoveNodesSchema = z.strictObject({
  ids: IdsSchema.describe("IDs of boxes and/or groups; a group moves everything in it"),
  dx: z.number().optional().describe("Meters along +x (east), default 0"),
  dy: z.number().optional().describe("Meters up, default 0"),
  dz: z.number().optional().describe("Meters along +z (south), default 0"),
});
export const MAX_COPIES = 100;
/** Copies nodes (whole groups included) with new IDs; copy i (1..count) is offset by i × (dx, dy, dz). */
export const DuplicateNodesSchema = MoveNodesSchema.extend({
  ids: IdsSchema.describe("IDs of boxes and/or groups; a group is copied with everything in it"),
  count: z.number().int().min(1).max(MAX_COPIES).optional().describe(`How many copies, 1..${MAX_COPIES}, default 1`),
});
export const MAX_PASTE = 1000;
/**
 * Pastes a clipboard snapshot: the nodes get fresh IDs, land centered on `focus` (keeping y), and their roots go
 * into `parent` (null = the top level).
 */
export const PasteNodesSchema = z.strictObject({
  nodes: z.array(NodeSchema).min(1).max(MAX_PASTE, `at most ${MAX_PASTE} nodes per paste`),
  focus: z.object({ x: z.number(), z: z.number() }),
  parent: z.string().nullable(),
});
export const RotateNodesSchema = z.strictObject({
  ids: IdsSchema.describe("IDs of boxes and/or groups; a group turns everything in it"),
  degrees: z.number().describe("Right-handed around the axis: around y, counterclockwise seen from above"),
  axis: z
    .enum(["y", "x", "z"])
    .optional()
    .describe("The world axis to turn around (14.4): y (the default) turns them, x and z tilt them as one (a group leaning): + around x leans the top south, + around z leans it west"),
  pivot: z
    .object({ x: z.number(), y: z.number().optional(), z: z.number() })
    .optional()
    .describe("The point to turn around. Defaults to the center of the nodes' combined bounds (for x and z, at half their height)"),
});
/**
 * One transform of nodes about one pivot (plan 14 §6), as one step: optionally copied first, then scaled, turned and
 * mirrored about the pivot, then moved so the pivot lands on `to` (or by `move`).
 */
export const TransformNodesSchema = z.strictObject({
  ids: IdsSchema.describe("IDs of shapes and/or groups; a group transforms everything in it as a unit"),
  copy: z.boolean().optional().describe("Leave the originals and transform copies of them (new IDs), e.g. the human's sketch made again at scale"),
  scale: z
    .number()
    .min(MIN_SCALE)
    .max(MAX_SCALE)
    .optional()
    .describe("Uniform factor about the pivot: every position and length grows, walls, heights and steps too (2 = twice as big, 0.5 = half)"),
  tilt: z
    .strictObject({
      pitch: z.number().optional().describe("Degrees around the world's x axis through the pivot (+ leans the top south, toward +z)"),
      roll: z.number().optional().describe("Degrees around the world's z axis through the pivot (+ leans the top west, toward -x); roll first, then pitch"),
    })
    .optional()
    .describe("Tilt everything rigidly as one about the pivot (a group of peaks leaning together): each shape's place orbits it and its tilt composes"),
  rotate: z.number().optional().describe("Degrees around the vertical axis through the pivot, counterclockwise seen from above"),
  mirror: z.enum(["x", "z"]).optional().describe("Mirror across the pivot on a world axis: x swaps east and west, z swaps north and south"),
  pivot: z
    .strictObject({ x: z.number(), y: z.number().optional(), z: z.number() })
    .optional()
    .describe("The point it all happens about. Default: the bottom center of the nodes' combined bounds"),
  to: z
    .strictObject({ x: z.number(), y: z.number().optional(), z: z.number() })
    .optional()
    .describe("Then move so the pivot lands here (y left out: stays at its height)"),
  move: z.strictObject({ dx: z.number().optional(), dy: z.number().optional(), dz: z.number().optional() }).optional().describe("Then move by this offset (instead of to)"),
});
export type TransformInput = z.input<typeof TransformNodesSchema>;

/** Converts boxes and cylinders into free-forms with the same outline (new IDs, same place in the list), as one step. */
export const ConvertNodesSchema = z.strictObject({ ids: IdsSchema.describe("IDs of boxes and cylinders") });
export const MirrorNodesSchema = z.strictObject({
  ids: IdsSchema.describe("IDs of boxes and/or groups; a group mirrors everything in it as a unit"),
  axis: z.enum(["x", "z"]).describe("World axis: x swaps east and west, z swaps north and south"),
});
export const GroupNodesSchema = z.strictObject({
  ids: IdsSchema.describe("IDs of the boxes and/or groups to put in a new group"),
  name: field.name.optional(),
  description: z.string().max(MAX_DESCRIPTION).optional().describe('What the group is, e.g. "entry hall, safe zone"'),
  tags: field.tags.optional(),
});
export const UngroupSchema = z.strictObject({ ids: IdsSchema.describe("IDs of groups to dissolve; their contents stay") });
/** The outliner's drag and drop: put nodes in `parent` (null = top level), just before sibling `before` (null = last). */
export const PlaceNodesSchema = z.strictObject({
  ids: IdsSchema,
  parent: z.string().nullable(),
  before: z.string().nullable(),
});

/** A walk's preset (09.2): the same walk with a first-person or a third-person camera. */
export const WalkPresetSchema = z.enum(["first", "third"]);
export type WalkPreset = z.infer<typeof WalkPresetSchema>;

/**
 * Where the human is walking (09.2): the eye (at eye height above the feet), where it looks (`yaw` as the editor's:
 * 0 looks north, counterclockwise seen from above; `pitch` up), and the horizontal field of view.
 */
export const WalkingSchema = z.object({
  preset: WalkPresetSchema,
  eye: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  yaw: z.number(),
  pitch: z.number().min(-90).max(90),
  fov: z.number().min(10).max(150),
});
export type Walking = z.infer<typeof WalkingSchema>;

export const ViewSchema = z.object({
  focus: z.object({ x: z.number(), z: z.number() }),
  yaw: z.number(),
  bounds: z.object({ x: z.number(), z: z.number(), width: z.number().positive(), depth: z.number().positive() }),
  // The node the human has isolated (only it and what's in it show), if any.
  isolated: z.string().optional(),
  // While the human walks through the level (09.2).
  walking: WalkingSchema.optional(),
  // Where the human's pointer last rested (14.1): on a shape (its node's id) or on the ground.
  pointer: z.object({ x: z.number(), y: z.number(), z: z.number(), id: z.string().optional() }).optional(),
});

/**
 * The player camera (plan 09 §3): the project's walk settings, shared by the human's walks and the agent's eye and
 * walk renders. Meters, m/s and degrees (the field of view is horizontal, across the frame). A third-person camera
 * sits `distance` behind the eye, `height` above it and `shoulder` to its right, and `avatar` draws the human.
 */
export const PlayerCameraSchema = z.object({
  eyeHeight: z.number().min(0.2).max(10).default(1.65),
  speed: z.number().min(0.5).max(20).default(4),
  first: z.object({ fov: z.number().min(30).max(150).default(90) }).prefault({}),
  third: z
    .object({
      fov: z.number().min(30).max(150).default(60),
      distance: z.number().min(0).max(20).default(3),
      height: z.number().min(-5).max(10).default(0.4),
      shoulder: z.number().min(-5).max(5).default(0.5),
      avatar: z.boolean().default(true),
    })
    .prefault({}),
});
export type PlayerCamera = z.infer<typeof PlayerCameraSchema>;
export const DEFAULT_PLAYER: PlayerCamera = PlayerCameraSchema.parse({});

/** A project or scene name: trimmed, not empty. */
export const NameSchema = z.string().trim().min(1, "a name is required").max(80, "80 characters at most");
export const DEFAULT_SCENE_NAME = "Scene 1";

/** Creates a project with its first scene, and opens that scene. */
export const CreateProjectSchema = z.strictObject({
  name: NameSchema,
  description: z.string().trim().max(2000).optional(),
  sceneName: NameSchema.optional(),
});

export const UpdateProjectSchema = z.strictObject({
  project: z.string(),
  name: NameSchema.optional(),
  description: z.string().trim().max(2000).optional(),
});
/** Creates an empty scene in a project, and opens it. */
export const CreateSceneSchema = z.strictObject({ project: z.string(), name: NameSchema });
export const RenameSceneSchema = z.strictObject({ project: z.string(), scene: z.string(), name: NameSchema });
/** Copies a scene (state and history) and opens the copy. The name defaults to "<name> copy". */
export const DuplicateSceneSchema = z.strictObject({ project: z.string(), scene: z.string(), name: NameSchema.optional() });
export const OpenSceneSchema = z.strictObject({ project: z.string(), scene: z.string() });

/** A project in the picker's list, with its scenes in creation order. `error`: its files didn't load. */
export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  scenes: { id: string; name: string; error?: string }[];
  error?: string;
};

/** Which scene the server has open (for every tab and the agent), or null for none. */
export type OpenScene = {
  project: { id: string; name: string; description: string };
  scene: { id: string; name: string };
  /** While an entity is being edited (08.5): which one. The store holds its definition; `scene` is where Back goes. */
  entity?: { id: string; name: string };
};

/** The editor's camera (see `src/web/camera.ts`): saved per scene in `editor.json`, restored when the scene opens. */
export const CameraSchema = z.object({
  focus: z.object({ x: z.number(), z: z.number() }),
  yaw: z.number(),
  distance: z.number().positive(),
});
export type Camera = z.infer<typeof CameraSchema>;

/** A shot's caption: one line, a sentence or two. */
export const MAX_SHOT_CAPTION = 300;
/** The largest image a shot keeps, in pixels on its long edge. */
export const MAX_SHOT_SIZE = 4096;

/**
 * The camera a shot was taken with (plan 09 §3): the editor's (its focus, yaw and distance), or a walk's pose (09.2:
 * the eye, where it looks, the field of view, and for third person the boom behind the eye).
 */
export const ShotCameraSchema = z.discriminatedUnion("kind", [
  CameraSchema.extend({ kind: z.literal("editor") }),
  z.object({
    kind: z.literal("walk"),
    preset: WalkPresetSchema,
    eye: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    yaw: z.number(),
    pitch: z.number().min(-90).max(90),
    fov: z.number().min(10).max(150),
    boom: z.object({ distance: z.number().min(0), height: z.number(), shoulder: z.number() }).optional(),
  }),
]);
export type ShotCamera = z.infer<typeof ShotCameraSchema>;

/**
 * A shot (plan 09 §3): a capture of the view, kept with the camera that took it, in the document it was taken in.
 * `seq` is the document's history step when it was taken, so what changed since can be told. The image is
 * `<id>.png` next to the records.
 */
export const ShotRecordSchema = z.object({
  id: z.string().regex(/^shot_\d+$/),
  caption: z.string().max(MAX_SHOT_CAPTION).optional(),
  createdBy: z.enum(["human", "agent"]),
  createdAt: z.string(),
  seq: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  camera: ShotCameraSchema,
});
export type ShotRecord = z.infer<typeof ShotRecordSchema>;
/** A shot as the editor gets it: its record and where its image is served. */
export type ShotView = ShotRecord & { url: string };

/** The views `render_view` renders (plan 09 §6). */
export const RENDER_VIEWS = ["sheet", "plan", "node", "eye", "walk", "shot", "shots", "entities"] as const;
export type RenderViewKind = (typeof RENDER_VIEWS)[number];
/** At most this many shots are re-checked in one image, and this many entities in a model sheet. */
export const MAX_RECHECKED_SHOTS = 6;
export const MAX_MODEL_SHEET = 24;
/** An image's long edge, in pixels: the largest the model reads without scaling it down. */
export const MIN_RENDER_SIZE = 256;
export const MAX_RENDER_SIZE = 1568;
export const DEFAULT_RENDER_SIZE = 1024;

const RenderPointSchema = z.object({ x: z.number(), y: z.number().optional(), z: z.number() });
/** What the agent asks `render_view` for (see the tool's description). */
export const RenderRequestSchema = z.object({
  view: z.enum(RENDER_VIEWS).default("sheet"),
  ids: z.array(z.string()).min(1).optional(),
  from: z.union([RenderPointSchema, z.literal("human")]).optional(),
  at: z.union([z.object({ x: z.number(), y: z.number(), z: z.number() }), z.string()]).optional(),
  yaw: z.number().optional(),
  pitch: z.number().min(-89).max(89).optional(),
  path: z.union([z.string(), z.array(RenderPointSchema).min(2)]).optional(),
  frames: z.number().int().min(3).max(8).optional(),
  preset: WalkPresetSchema.optional(),
  shot: z.string().optional(),
  shots: z.array(z.string()).min(1).max(MAX_RECHECKED_SHOTS).optional(),
  labels: z.boolean().optional(),
  size: z.number().int().min(MIN_RENDER_SIZE).max(MAX_RENDER_SIZE).optional(),
  save: z.boolean().optional(),
  // For this render only (13.6): nodes left out (with what's in them; a hidden hole cuts nothing), and a height
  // everything above is cut away at.
  hide: z.array(z.string()).min(1).optional(),
  clip: z.number().optional(),
  // A plan cut at heights (14.7): each solid's outline there, and the gaps between them (up to `gap` m wide).
  slice: z.union([z.number(), z.array(z.number()).min(1).max(4)]).optional(),
  gap: z.number().positive().optional(),
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;
/** A shot to take again beside its image as taken (`view: "shots"`), with the steps since it was taken. */
export type RecheckedShot = { id: string; caption?: string; url: string; camera: ShotCamera; width: number; height: number; since: number };
/**
 * What the editor renders: the request, with what only the server knows (where the human walks, a shot's camera, the
 * shots to re-check, the entities of a model sheet).
 */
/** A section at a height, for a slice render (14.7): outlines on the ground by owner, and the gaps between them. */
export type RenderSection = {
  y: number;
  outlines: { owner: string; hole: boolean; loops: { x: number; z: number }[][] }[];
  gaps: { between: [string, string]; width: number; at: { x: number; z: number } }[];
};

export type RenderJob = RenderRequest & {
  /** A slice render's sections (14.7), worked out by the server. */
  sections?: RenderSection[];
  /** The document to draw, when no tab shows it (14.5: the agent's own scene); else the tab draws its own. */
  nodes?: SceneNode[];
  human?: Walking;
  shotCamera?: { camera: ShotCamera; width: number; height: number };
  pairs?: RecheckedShot[];
  entities?: { id: string; name: string; tags?: string[] }[];
};
/** What the editor sends back: the PNG (base64), what it shows (the text result), and its camera when it has one. */
export const RenderResultSchema = z.object({
  image: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  text: z.string(),
  camera: ShotCameraSchema.optional(),
});
export type RenderResult = z.infer<typeof RenderResultSchema>;

/** What a tab restores when a scene opens (or when it connects): the scene's saved camera (null = keep its own) and selection. */
export type EditorRestore = { camera: Camera | null; selection: string[] };

export const ClientMessageSchema = z.discriminatedUnion("type", [
  CreateProjectSchema.extend({ type: z.literal("create_project") }),
  UpdateProjectSchema.extend({ type: z.literal("update_project") }),
  CreateSceneSchema.extend({ type: z.literal("create_scene") }),
  RenameSceneSchema.extend({ type: z.literal("rename_scene") }),
  DuplicateSceneSchema.extend({ type: z.literal("duplicate_scene") }),
  OpenSceneSchema.extend({ type: z.literal("open_scene") }),
  // Work with agent (14.5): the open scene becomes the agent's; `stop_agent` ends the invitation.
  z.object({ type: z.literal("invite_agent") }),
  z.object({ type: z.literal("stop_agent") }),
  z.object({ type: z.literal("add_shapes"), shapes: z.array(ShapeInputSchema).min(1) }),
  z.object({ type: z.literal("update_nodes"), changes: z.array(NodeUpdateSchema).min(1) }),
  // `cut`: the same removal, labeled "Cut" (the editor put the nodes on the clipboard first).
  z.object({ type: z.literal("remove_nodes"), ids: IdsSchema, cut: z.boolean().optional() }),
  MoveNodesSchema.extend({ type: z.literal("move_nodes") }),
  DuplicateNodesSchema.extend({ type: z.literal("duplicate_nodes") }),
  RotateNodesSchema.extend({ type: z.literal("rotate_nodes") }),
  MirrorNodesSchema.extend({ type: z.literal("mirror_nodes") }),
  TransformNodesSchema.extend({ type: z.literal("transform_nodes") }),
  ConvertNodesSchema.extend({ type: z.literal("convert_nodes") }),
  PasteNodesSchema.extend({ type: z.literal("paste_nodes") }),
  GroupNodesSchema.extend({ type: z.literal("group_nodes") }),
  UngroupSchema.extend({ type: z.literal("ungroup") }),
  PlaceNodesSchema.extend({ type: z.literal("place_nodes") }),
  z.object({ type: z.literal("set_selection"), ids: z.array(z.string()) }),
  z.object({ type: z.literal("clear") }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("redo") }),
  z.object({ type: z.literal("set_view"), view: ViewSchema, camera: CameraSchema }),
  LibraryEditSchema.extend({ type: z.literal("update_library") }),
  z.object({ type: z.literal("library_undo") }),
  z.object({ type: z.literal("library_redo") }),
  z.object({
    type: z.literal("make_entity"),
    ids: IdsSchema,
    name: z.string().max(80).optional(),
    description: z.string().max(MAX_DESCRIPTION).optional(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("detach_instances"), ids: IdsSchema }),
  // The inspector's Array button (10.1): an instance becomes an array.
  z.object({ type: z.literal("make_array"), id: z.string() }),
  z.object({ type: z.literal("open_entity"), entity: z.string() }),
  z.object({ type: z.literal("close_entity") }),
  // A shot (09.1): the image as base64 PNG, checked and saved by the server, which gives it its ID.
  z.object({
    type: z.literal("add_shot"),
    camera: ShotCameraSchema,
    width: z.number().int().positive().max(MAX_SHOT_SIZE),
    height: z.number().int().positive().max(MAX_SHOT_SIZE),
    caption: z.string().max(MAX_SHOT_CAPTION).optional(),
    image: z.string().min(1),
  }),
  z.object({ type: z.literal("update_shot"), id: z.string(), caption: z.string().max(MAX_SHOT_CAPTION) }),
  z.object({ type: z.literal("remove_shot"), id: z.string() }),
  // The pause menu's player camera (09.2), saved for the project.
  z.object({ type: z.literal("set_player"), player: PlayerCameraSchema }),
  // Whether this tab can render for the agent (09.3): shown (not in the background) and when it last had focus.
  z.object({ type: z.literal("tab"), visible: z.boolean(), focused: z.boolean() }),
  // A render the server asked for (09.3): its image and text, or why it failed.
  z.object({ type: z.literal("rendered"), requestId: z.number().int(), result: RenderResultSchema.optional(), error: z.string().optional() }),
  // The Unity export (15.2): pick the project's folder (the server opens the system's folder dialog), whether the
  // open scene is exported after every step, and Export now.
  z.object({ type: z.literal("pick_export_folder") }),
  // The folder as a path ("" clears it): what the dialog sets, for scripts and tools with no dialog to click.
  z.object({ type: z.literal("set_export_folder"), dir: z.string().max(1000) }),
  z.object({ type: z.literal("set_export_auto"), auto: z.boolean() }),
  z.object({ type: z.literal("export_scene") }),
]);
export type ClientMessage = z.input<typeof ClientMessageSchema>;

/** What an export wrote (15.2): node counts by type, array items, entities, distinct meshes, the binary's size. */
export type ExportSummary = {
  dir: string;
  exportId: number;
  nodes: Record<string, number>;
  items: number;
  entities: number;
  meshes: number;
  bytes: number;
  ms: number;
  warnings: string[];
};

/**
 * The open scene's Unity export (15.2): the project's folder ("" when none is picked), the scene's own folder in it,
 * whether the scene is exported after every step, whether a folder dialog or an export is running, and how the last
 * export went (this server's run).
 */
export type ExportStatus = {
  project: string;
  scene: string;
  dir: string;
  sceneDir: string;
  auto: boolean;
  picking: boolean;
  running: boolean;
  last?: { at: string; summary?: ExportSummary; error?: string };
};

/**
 * Work with agent (14.5): the scene the human invited the agent to, its name, and whether the agent has it in a store
 * of its own (the human is in another scene) or shares the human's.
 */
export type AgentInfo = { project: string; scene: string; name: string; apart: boolean };

export type ServerMessage =
  // `seq`: the open document's history step (09.1: a shot taken at an earlier one shows the level changed since).
  | { type: "scene"; scene: Scene; history: HistorySummary; seq?: number }
  | { type: "projects"; projects: ProjectSummary[] }
  // `restore` only when a scene opens and on connect; a rename re-sends `opened` without it.
  | { type: "opened"; open: OpenScene | null; restore?: EditorRestore }
  | { type: "error"; message: string }
  // The open project's library (null with nothing open), its own undo state, and where its tags and skills are used.
  | { type: "library"; library: Library | null; history: HistorySummary; uses: Uses }
  // The open project's entity definitions, by ID (every one, as nodes around the pivot).
  | { type: "entities"; definitions: Record<string, SceneNode[]> }
  // The open document's shots (09.1), newest last: on open and after every change.
  | { type: "shots"; shots: ShotView[] }
  // The open project's player camera (09.2): on connect, when a project opens and after every change.
  | { type: "player"; player: PlayerCamera }
  // The agent's render_view (09.3), for this tab to render and answer with `rendered`.
  | { type: "render"; requestId: number; job: RenderJob }
  // The scene the agent works in (14.5): on connect and when it changes; null when it follows the human's.
  | { type: "agent"; agent: AgentInfo | null }
  // The open scene's export for Unity (15.2): on connect, when a scene opens, and when its settings or an export change.
  | { type: "export"; export: ExportStatus | null };

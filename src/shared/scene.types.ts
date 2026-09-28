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
  pitch?: undefined; // a free-form never tilts (its points are on the ground)
  roll?: undefined;
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
  createdBy: Actor;
};

/** One of an array's entities, and how often it's chosen among them (default 1). */
export type ArrayEntity = { entity: string; weight?: number };

/** How a path array spaces its items: every `spacing` meters (fitted), `count` evenly, on every point, or mid-edge. */
export type ArrayPlace = "spacing" | "count" | "corners" | "midpoints";

/**
 * Where an array's items go (plan 10 §3). A path is a line's points (absolute world x/y/z, 3D handles), open or
 * closed; a circle is a center, a radius and angles (from 0 = east, counterclockwise seen from above); a grid is a
 * center and a turn, with columns along its local x, rows along its local z and layers up.
 */
export type PathLayout = {
  type: "path";
  points: LinePoint[];
  closed?: true;
  place: ArrayPlace;
  spacing?: number; // place: spacing, meters (the real spacing is fitted to the path)
  count?: number; // place: count
};
export type CircleLayout = { type: "circle"; x: number; y: number; z: number; radius: number; count: number; start?: number; sweep?: number };
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
export type ArrayLayout = PathLayout | CircleLayout | GridLayout;
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
  pitch: ["volume", "hole"],
  roll: ["volume", "hole"],
} as const satisfies Record<string, readonly ShapeKind[]>;
/** The tilt fields: only boxes and cylinders have them (a free-form's points are on the ground). */
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
export const ARRAY_LAYOUTS = ["path", "circle", "grid"] as const;
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
    .describe("Box and cylinder volumes and holes only: degrees around the shape's own x axis through its center; + leans the top toward local +z. Default 0"),
  roll: z
    .number()
    .describe("Box and cylinder volumes and holes only: degrees around the shape's own z axis through its center; + leans the top toward local -x. Default 0"),
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
  createdBy: ActorSchema,
});

const count = z.number().int().min(1);
const ArrayEntitySchema = z.object({ entity: z.string(), weight: z.number().positive().optional() });
/** An array's layout as stored (see `ArrayLayout`). */
export const ArrayLayoutSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("path"),
    points: z.array(LinePointSchema).min(MIN_LINE_POINTS).max(MAX_POINTS),
    closed: z.literal(true).optional(),
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

/** A line for `draw_shapes`: its points, and optional style. */
export const LineInputSchema = z.strictObject({
  type: z.literal("line").describe("An open path of 3D points, for annotations (a route, a jump arc)"),
  points: z
    .array(LinePointInputSchema)
    .min(MIN_LINE_POINTS)
    .max(MAX_POINTS)
    .describe(`The path, ${MIN_LINE_POINTS}..${MAX_POINTS} points in absolute world x/y/z (it doesn't close)`),
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
  spiral: z
    .strictObject({
      x: z.number().describe("The spiral's center x"),
      z: z.number().describe("The spiral's center z"),
      radius: z.number().positive().describe("The centerline's radius, meters"),
      turn: z.number().describe("Degrees around, counterclockwise seen from above (negative: clockwise)"),
      y: z.number().describe("The start's height"),
      rise: z.number().describe("How much it climbs over the whole turn (negative: descends)"),
      from: z.number().optional().describe("The start's angle in degrees: 0 = east (+x), 90 = north (-z). Default 0"),
    })
    .optional()
    .describe("A spiral stair or ramp, instead of points: the server turns it into points (one every 90°)"),
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
export const InstanceInputSchema = z.strictObject({
  type: z.literal("instance").describe("A placed copy of a library entity (a prefab): it shows the entity's shapes"),
  entity: z.string().describe('The entity\'s ID, e.g. "tree-tall" (get_library lists them)'),
  x: z.number().describe("Where its pivot (the entity's bottom center) goes: world x, meters"),
  z: z.number().describe("World z, meters"),
  y: z.number().optional().describe("The height its bottom stands at (a floor's y, a platform's top). Defaults to 0"),
  rotation: z.number().optional().describe("Degrees, counterclockwise seen from above, around its pivot. Defaults to 0"),
  name: field.name.optional().describe('A name for this one, e.g. "entry_window". Not unique'),
  parent: field.parent.optional().describe("ID of the group to put it in. Omit for the top level"),
});

const arrayCount = z.number().int().min(1).max(MAX_ARRAY_ITEMS);
/** An array's layout for `draw_shapes` and `update_nodes` (see get_guide arrays). */
export const ArrayLayoutInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("path").describe("Items along a path: a line's points"),
    points: z
      .array(LinePointInputSchema)
      .min(MIN_LINE_POINTS)
      .max(MAX_POINTS)
      .describe("The path, points in absolute world x/y/z as a line's (items stand at the path's height)"),
    closed: z.boolean().optional().describe("The last point joins the first (a loop). Default false"),
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
  type: z.literal("array").describe("Repeats entities on a layout (a path, a circle or a grid), live: one node for many items"),
  entity: z.string().optional().describe('The entity to repeat, e.g. "merlon" (or give entities)'),
  entities: arrayField.entities.optional(),
  layout: ArrayLayoutInputSchema,
  facing: arrayField.facing.optional(),
  rotation: arrayField.rotation.optional(),
  jitter: arrayField.jitter.optional(),
  turnJitter: arrayField.turnJitter.optional(),
  seed: arrayField.seed.optional(),
  skip: arrayField.skip.optional(),
  name: field.name.optional(),
  parent: field.parent.optional().describe("ID of the group to put it in (its items cut and are cut as instances there). Omit for the top level"),
});

export const ShapeInputSchema = z.discriminatedUnion("type", [
  BoxInputSchema.extend({
    type: z.enum(["box", "cylinder"]).optional().describe("box (the default) or cylinder (the ellipse inscribed in width × depth)"),
    sides: field.sides.optional(),
  }),
  FreeformInputSchema,
  LineInputSchema,
  RampInputSchema,
  NoteInputSchema,
  InstanceInputSchema,
  ArrayInputSchema,
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
  rotation: field.rotation.optional(),
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
  entity: z.string().optional().describe("Instances only: another entity's ID, to show it instead, in the same place"),
  entities: arrayField.entities.optional().describe("Arrays only: the whole list of entities (with weights)"),
  layout: z
    .strictObject({
      type: z.enum(ARRAY_LAYOUTS).optional(),
      points: z.array(LinePointInputSchema).min(MIN_LINE_POINTS).max(MAX_POINTS).optional(),
      closed: z.boolean().optional(),
      place: z.enum(ARRAY_PLACES).optional(),
      spacing: z.union([z.number(), z.strictObject({ x: z.number(), z: z.number(), y: z.number().optional() })]).optional(),
      count: z.number().int().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      radius: z.number().optional(),
      start: z.number().optional(),
      sweep: z.number().optional(),
      rotation: z.number().optional(),
      columns: z.number().int().optional(),
      rows: z.number().int().optional(),
      layers: z.number().int().optional(),
      stagger: z.boolean().optional(),
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
  degrees: z.number().describe("Counterclockwise seen from above"),
  pivot: z
    .object({ x: z.number(), z: z.number() })
    .optional()
    .describe("The ground point to turn around. Defaults to the center of the nodes' combined bounds"),
});
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
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;
/** A shot to take again beside its image as taken (`view: "shots"`), with the steps since it was taken. */
export type RecheckedShot = { id: string; caption?: string; url: string; camera: ShotCamera; width: number; height: number; since: number };
/**
 * What the editor renders: the request, with what only the server knows (where the human walks, a shot's camera, the
 * shots to re-check, the entities of a model sheet).
 */
export type RenderJob = RenderRequest & {
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
  z.object({ type: z.literal("add_shapes"), shapes: z.array(ShapeInputSchema).min(1) }),
  z.object({ type: z.literal("update_nodes"), changes: z.array(NodeUpdateSchema).min(1) }),
  // `cut`: the same removal, labeled "Cut" (the editor put the nodes on the clipboard first).
  z.object({ type: z.literal("remove_nodes"), ids: IdsSchema, cut: z.boolean().optional() }),
  MoveNodesSchema.extend({ type: z.literal("move_nodes") }),
  DuplicateNodesSchema.extend({ type: z.literal("duplicate_nodes") }),
  RotateNodesSchema.extend({ type: z.literal("rotate_nodes") }),
  MirrorNodesSchema.extend({ type: z.literal("mirror_nodes") }),
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
]);
export type ClientMessage = z.input<typeof ClientMessageSchema>;

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
  | { type: "render"; requestId: number; job: RenderJob };

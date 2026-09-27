import { z } from "zod";

export type Actor = "human" | "agent";

/** A room is hollow (floor and walls, no ceiling); a volume is solid (something you stand on or bump into). */
export type BoxKind = "room" | "volume";

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
export type BoxColor = keyof typeof PALETTE;
export const BOX_COLORS = Object.keys(PALETTE) as [BoxColor, ...BoxColor[]];
export const DEFAULT_COLOR: BoxColor = "almost-white";

/**
 * Meters, y up. The footprint is centered at `x, z` on the ground plane, with `width` along the box's local x and
 * `depth` along its local z. It rises from its elevation `y` (its bottom; 0 = on the ground, negative = below) to
 * `y + height`. `rotation` turns it around the vertical axis through its center, in degrees, counterclockwise seen
 * from above (a right-handed turn about +y); 0 = grid-aligned.
 */
export type Box = {
  id: string; // server-assigned, "box_1", "box_2", ... never reused
  type: "box";
  name?: string; // for people and the agent ("lobby"); not unique
  parent?: string; // the group it's in; none = top level
  kind: BoxKind;
  x: number;
  z: number;
  y: number;
  width: number; // > 0
  depth: number; // > 0
  height: number; // >= MIN_HEIGHT
  rotation: number; // degrees, 0..360
  color: BoxColor;
  createdBy: Actor;
};

/**
 * A group: a container with no position, size or rotation of its own (Figma-style). Its boxes keep their world
 * coordinates, and its bounds are derived from them. A unit of action: moving or deleting it acts on everything
 * inside, as one step.
 */
export type Group = {
  id: string; // server-assigned, "group_1", ... never reused
  type: "group";
  name?: string;
  parent?: string;
  createdBy: Actor;
};

/** Anything in the scene's flat list. (Not `Node`, which is the DOM's.) */
export type SceneNode = Box | Group;

/** The box fields an edit can change. */
export type BoxPatch = Partial<Pick<Box, "name" | "kind" | "x" | "z" | "y" | "width" | "depth" | "height" | "rotation" | "color">>;
/** What an update op can change on any node: box fields (boxes only), `name` and `parent`. */
export type NodePatch = BoxPatch & { parent?: string };

/**
 * What the editor currently shows. The camera looks down at the ground (x/z plane, y up) at a fixed pitch,
 * so the visible ground is a rotated quad; `bounds` is the axis-aligned box around it.
 */
export type View = {
  focus: { x: number; z: number }; // ground point under the screen center
  yaw: number; // degrees, 0..360
  bounds: { x: number; z: number; width: number; depth: number };
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
/** Ground snap for footprints. */
export const SNAP = 0.5;
/** Vertical snap for heights, and the smallest height a box can have. */
export const HEIGHT_SNAP = 0.05;
export const MIN_HEIGHT = HEIGHT_SNAP;
export const DEFAULT_HEIGHT: Record<BoxKind, number> = { room: 3, volume: 0.25 };
/** Room walls are this thick, centered on the footprint edge. Rendering and picking only: the data stores the centerline. */
export const WALL_THICKNESS = 0.2;

export const BoxKindSchema = z.enum(["room", "volume"]);
export const BoxColorSchema = z.enum(BOX_COLORS);

const field = {
  kind: BoxKindSchema.describe("room = hollow (floor + walls, no ceiling); volume = solid"),
  x: z.number().describe("Footprint center x, meters"),
  z: z.number().describe("Footprint center z, meters"),
  y: z.number().describe("Elevation of the box's bottom, meters. 0 = on the ground, negative = below ground"),
  width: z.number().positive().describe("Extent along the box's local x (world +x at rotation 0), meters, > 0"),
  depth: z.number().positive().describe("Extent along the box's local z (world +z at rotation 0), meters, > 0"),
  height: z.number().min(MIN_HEIGHT).describe(`Meters, >= ${MIN_HEIGHT}`),
  rotation: z.number().describe("Degrees around the vertical axis through the center, counterclockwise seen from above"),
  color: BoxColorSchema.describe(`Palette key: ${BOX_COLORS.join(", ")}`),
  name: z.string().describe('A label for people, e.g. "lobby". Not unique'),
  parent: z.string().describe("ID of the group to put it in, e.g. group_1"),
};

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
  color: field.color.optional().describe(`Palette key: ${BOX_COLORS.join(", ")}. Defaults to ${DEFAULT_COLOR}`),
  name: field.name.optional(),
  parent: field.parent.optional().describe("ID of the group to put it in, e.g. group_1. Omit for the top level"),
});
export type BoxInput = z.input<typeof BoxInputSchema>;

/** A change to an existing node, by ID: any of a box's editable fields; for a group only `name` and `parent`. */
export const NodeUpdateSchema = z.strictObject({
  id: z.string().describe("ID of an existing node, e.g. box_3 or group_1"),
  kind: field.kind.optional(),
  x: field.x.optional(),
  z: field.z.optional(),
  y: field.y.optional(),
  width: field.width.optional(),
  depth: field.depth.optional(),
  height: field.height.optional(),
  rotation: field.rotation.optional(),
  color: field.color.optional(),
  name: field.name.optional().describe('A label for people, e.g. "lobby". Not unique. An empty string removes it'),
  parent: field.parent
    .nullable()
    .optional()
    .describe("ID of the group to move it into, e.g. group_1; null moves it to the top level"),
});
export type NodeUpdate = z.input<typeof NodeUpdateSchema>;

const IdsSchema = z.array(z.string()).min(1);

export const MoveNodesSchema = z.strictObject({
  ids: IdsSchema.describe("IDs of boxes and/or groups; a group moves everything in it"),
  dx: z.number().optional().describe("Meters along +x (east), default 0"),
  dy: z.number().optional().describe("Meters up, default 0"),
  dz: z.number().optional().describe("Meters along +z, default 0"),
});
export const MAX_COPIES = 100;
/** Copies nodes (whole groups included) with new IDs; copy i (1..count) is offset by i × (dx, dy, dz). */
export const DuplicateNodesSchema = MoveNodesSchema.extend({
  ids: IdsSchema.describe("IDs of boxes and/or groups; a group is copied with everything in it"),
  count: z.number().int().min(1).max(MAX_COPIES).optional().describe(`How many copies, 1..${MAX_COPIES}, default 1`),
});
export const RotateNodesSchema = z.strictObject({
  ids: IdsSchema.describe("IDs of boxes and/or groups; a group turns everything in it"),
  degrees: z.number().describe("Counterclockwise seen from above, around the center of the nodes' combined bounds"),
});
export const GroupNodesSchema = z.strictObject({
  ids: IdsSchema.describe("IDs of the boxes and/or groups to put in a new group"),
  name: field.name.optional(),
});
export const UngroupSchema = z.strictObject({ ids: IdsSchema.describe("IDs of groups to dissolve; their contents stay") });
/** The outliner's drag and drop: put nodes in `parent` (null = top level), just before sibling `before` (null = last). */
export const PlaceNodesSchema = z.strictObject({
  ids: IdsSchema,
  parent: z.string().nullable(),
  before: z.string().nullable(),
});

export const ViewSchema = z.object({
  focus: z.object({ x: z.number(), z: z.number() }),
  yaw: z.number(),
  bounds: z.object({ x: z.number(), z: z.number(), width: z.number().positive(), depth: z.number().positive() }),
});

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
};

/** The editor's camera (see `src/web/camera.ts`): saved per scene in `editor.json`, restored when the scene opens. */
export const CameraSchema = z.object({
  focus: z.object({ x: z.number(), z: z.number() }),
  yaw: z.number(),
  distance: z.number().positive(),
});
export type Camera = z.infer<typeof CameraSchema>;

/** What a tab restores when a scene opens (or when it connects): the scene's saved camera (null = keep its own) and selection. */
export type EditorRestore = { camera: Camera | null; selection: string[] };

export const ClientMessageSchema = z.discriminatedUnion("type", [
  CreateProjectSchema.extend({ type: z.literal("create_project") }),
  UpdateProjectSchema.extend({ type: z.literal("update_project") }),
  CreateSceneSchema.extend({ type: z.literal("create_scene") }),
  RenameSceneSchema.extend({ type: z.literal("rename_scene") }),
  DuplicateSceneSchema.extend({ type: z.literal("duplicate_scene") }),
  OpenSceneSchema.extend({ type: z.literal("open_scene") }),
  z.object({ type: z.literal("add_boxes"), boxes: z.array(BoxInputSchema).min(1) }),
  z.object({ type: z.literal("update_nodes"), changes: z.array(NodeUpdateSchema).min(1) }),
  z.object({ type: z.literal("remove_nodes"), ids: IdsSchema }),
  MoveNodesSchema.extend({ type: z.literal("move_nodes") }),
  DuplicateNodesSchema.extend({ type: z.literal("duplicate_nodes") }),
  RotateNodesSchema.extend({ type: z.literal("rotate_nodes") }),
  GroupNodesSchema.extend({ type: z.literal("group_nodes") }),
  UngroupSchema.extend({ type: z.literal("ungroup") }),
  PlaceNodesSchema.extend({ type: z.literal("place_nodes") }),
  z.object({ type: z.literal("set_selection"), ids: z.array(z.string()) }),
  z.object({ type: z.literal("clear") }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("redo") }),
  z.object({ type: z.literal("set_view"), view: ViewSchema, camera: CameraSchema }),
]);
export type ClientMessage = z.input<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "scene"; scene: Scene; history: HistorySummary }
  | { type: "projects"; projects: ProjectSummary[] }
  // `restore` only when a scene opens and on connect; a rename re-sends `opened` without it.
  | { type: "opened"; open: OpenScene | null; restore?: EditorRestore }
  | { type: "error"; message: string };

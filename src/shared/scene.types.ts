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

/** The fields an update can change. */
export type BoxPatch = Partial<Pick<Box, "name" | "kind" | "x" | "z" | "y" | "width" | "depth" | "height" | "rotation" | "color">>;

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
  /** IDs of the boxes selected in the editor (last tab to change it wins). Not an edit, not undoable. */
  selection: string[];
  boxes: Box[];
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
});
export type BoxInput = z.input<typeof BoxInputSchema>;

/** A change to an existing box, by ID: any of its editable fields. */
export const NodeUpdateSchema = z.strictObject({
  id: z.string().describe("ID of an existing box, e.g. box_3"),
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
});
export type NodeUpdate = z.input<typeof NodeUpdateSchema>;

export const ViewSchema = z.object({
  focus: z.object({ x: z.number(), z: z.number() }),
  yaw: z.number(),
  bounds: z.object({ x: z.number(), z: z.number(), width: z.number().positive(), depth: z.number().positive() }),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  // `requestId` lets the editor select the boxes it just drew: the server answers with `created`.
  z.object({ type: z.literal("add_boxes"), requestId: z.string().optional(), boxes: z.array(BoxInputSchema).min(1) }),
  z.object({ type: z.literal("update_nodes"), changes: z.array(NodeUpdateSchema).min(1) }),
  z.object({ type: z.literal("remove_nodes"), ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("set_selection"), ids: z.array(z.string()) }),
  z.object({ type: z.literal("clear") }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("redo") }),
  z.object({ type: z.literal("set_view"), view: ViewSchema }),
]);
export type ClientMessage = z.input<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "scene"; scene: Scene; history: HistorySummary }
  | { type: "created"; requestId: string; ids: string[] }
  | { type: "error"; message: string };

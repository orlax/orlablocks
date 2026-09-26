import { z } from "zod";

export type Actor = "human" | "agent";

/** A room is hollow (floor and walls, no ceiling); a volume is solid (something you stand on or bump into). */
export type BoxKind = "room" | "volume";

/**
 * Meters, y up. A box stands on the ground (y = 0): its footprint is on the x/z plane with `x, z` at the
 * min corner, `width` along +x and `depth` along +z, and it rises to `height`.
 */
export type Box = {
  id: string; // server-assigned, per kind: "room_1", "volume_1", ...
  kind: BoxKind;
  x: number;
  z: number;
  width: number; // > 0
  depth: number; // > 0
  height: number; // >= MIN_HEIGHT
  createdBy: Actor;
};

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
  boxes: Box[];
};

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

export const BoxKindSchema = z.enum(["room", "volume"]);

export const BoxInputSchema = z.object({
  kind: BoxKindSchema.describe("room = hollow (floor + walls, no ceiling); volume = solid"),
  x: z.number().describe("Footprint min-corner x, meters"),
  z: z.number().describe("Footprint min-corner z, meters"),
  width: z.number().positive().describe("Extent along +x, meters, > 0"),
  depth: z.number().positive().describe("Extent along +z, meters, > 0"),
  height: z
    .number()
    .min(MIN_HEIGHT)
    .optional()
    .describe(`Meters, >= ${MIN_HEIGHT}. Defaults to ${DEFAULT_HEIGHT.room} for a room, ${DEFAULT_HEIGHT.volume} for a volume`),
});
export type BoxInput = z.input<typeof BoxInputSchema>;

export const ViewSchema = z.object({
  focus: z.object({ x: z.number(), z: z.number() }),
  yaw: z.number(),
  bounds: z.object({ x: z.number(), z: z.number(), width: z.number().positive(), depth: z.number().positive() }),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_boxes"), boxes: z.array(BoxInputSchema).min(1) }),
  z.object({ type: z.literal("clear") }),
  z.object({ type: z.literal("set_view"), view: ViewSchema }),
]);
export type ClientMessage = z.input<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "scene"; scene: Scene }
  | { type: "error"; message: string };

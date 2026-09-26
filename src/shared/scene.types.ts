import { z } from "zod";

export type Actor = "human" | "agent";

/** World units (u). At default zoom 1 u = 20 px; the data never stores pixels. */
export type Rect = {
  id: string;
  x: number; // top-left corner, +x right
  y: number; // top-left corner, +y down
  width: number; // > 0
  height: number; // > 0
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
  rects: Rect[];
};

export const DEFAULT_VIEW: View = {
  focus: { x: 0, z: 0 },
  yaw: 45,
  bounds: { x: -30, z: -20, width: 60, depth: 40 },
};
export const SNAP = 0.5;

export const RectInputSchema = z.object({
  x: z.number().describe("Top-left x in world units"),
  y: z.number().describe("Top-left y in world units (+y is down)"),
  width: z.number().positive().describe("Width in world units, > 0"),
  height: z.number().positive().describe("Height in world units, > 0"),
});
export type RectInput = z.input<typeof RectInputSchema>;

export const ViewSchema = z.object({
  focus: z.object({ x: z.number(), z: z.number() }),
  yaw: z.number(),
  bounds: z.object({ x: z.number(), z: z.number(), width: z.number().positive(), depth: z.number().positive() }),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_rects"), rects: z.array(RectInputSchema).min(1) }),
  z.object({ type: z.literal("clear") }),
  z.object({ type: z.literal("set_view"), view: ViewSchema }),
]);
export type ClientMessage = z.input<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "scene"; scene: Scene }
  | { type: "error"; message: string };

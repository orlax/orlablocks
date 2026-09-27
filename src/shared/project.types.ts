import { z } from "zod";
import { BoxColorSchema, BoxKindSchema, CameraSchema, MIN_HEIGHT, type SceneNode } from "./scene.types";

/**
 * The files in the data folder (plan 04 §3). Every file is checked with these on load, and a file that fails is
 * never written over. No format versions: new fields are optional, with defaults.
 */

const ActorSchema = z.enum(["human", "agent"]);

const BoxSchema = z.object({
  id: z.string(),
  type: z.literal("box"),
  name: z.string().optional(),
  parent: z.string().optional(),
  kind: BoxKindSchema,
  x: z.number(),
  z: z.number(),
  y: z.number(),
  width: z.number().positive(),
  depth: z.number().positive(),
  height: z.number().min(MIN_HEIGHT),
  rotation: z.number(),
  color: BoxColorSchema,
  createdBy: ActorSchema,
});

const GroupSchema = z.object({
  id: z.string(),
  type: z.literal("group"),
  name: z.string().optional(),
  parent: z.string().optional(),
  createdBy: ActorSchema,
});

export const NodeSchema: z.ZodType<SceneNode> = z.discriminatedUnion("type", [BoxSchema, GroupSchema]);

/** The next number for each kind of ID. Saved, because IDs are never reused and history can hold removed nodes. */
export const NextIdSchema = z.object({ box: z.number().int().min(1), group: z.number().int().min(1) });
export type NextId = z.infer<typeof NextIdSchema>;

/** `project.json` */
export const ProjectFileSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  createdAt: z.string(),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/** `scenes/<id>/scene.json`: written in full after every change to the nodes. */
export const SceneFileSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  seq: z.number().int().min(0), // the last history step this state includes
  nextId: NextIdSchema,
  nodes: z.array(NodeSchema),
});
export type SceneFile = z.infer<typeof SceneFileSchema>;

/** `scenes/<id>/editor.json`: the editor's state for the scene. Not design data, not undoable. */
export const EditorFileSchema = z.object({
  camera: CameraSchema.nullable().default(null),
  selection: z.array(z.string()).default([]),
});
export type EditorFile = z.infer<typeof EditorFileSchema>;

/** `app.json`: the server-level state. */
export const AppFileSchema = z.object({
  lastOpen: z.object({ project: z.string(), scene: z.string() }).nullable().default(null),
});
export type AppFile = z.infer<typeof AppFileSchema>;

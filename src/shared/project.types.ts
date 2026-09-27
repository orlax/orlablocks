import { z } from "zod";
import { CameraSchema, NodeSchema } from "./scene.types";

/**
 * The files in the data folder (plan 04 §3). Every file is checked with these on load, and a file that fails is
 * never written over. No format versions: new fields are optional, with defaults.
 */

/**
 * The next number for each node type's IDs (`box_3`, `cylinder_1`, ...). Saved, because IDs are never reused and
 * history can hold removed nodes. Types added later default to 1, so older scenes load unchanged.
 */
const counter = z.number().int().min(1);
export const NextIdSchema = z.object({ box: counter, group: counter, cylinder: counter.default(1), freeform: counter.default(1) });
export type NextId = z.infer<typeof NextIdSchema>;
/** A new scene's counters. */
export const firstIds = (): NextId => ({ box: 1, group: 1, cylinder: 1, freeform: 1 });

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

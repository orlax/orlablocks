import { z } from "zod";
import { EntityMetaSchema, SkillSchema, TagSchema } from "./library";
import { CameraSchema, NodeSchema, ShotRecordSchema } from "./scene.types";

/**
 * The files in the data folder (plan 04 §3). Every file is checked with these on load, and a file that fails is
 * never written over. No format versions: new fields are optional, with defaults.
 */

/**
 * The next number for each node type's IDs (`box_3`, `cylinder_1`, ...). Saved, because IDs are never reused and
 * history can hold removed nodes. Types added later default to 1, so older scenes load unchanged.
 */
const counter = z.number().int().min(1);
export const NextIdSchema = z.object({ box: counter, group: counter, cylinder: counter.default(1), freeform: counter.default(1), line: counter.default(1), ramp: counter.default(1), note: counter.default(1), instance: counter.default(1), array: counter.default(1) });
export type NextId = z.infer<typeof NextIdSchema>;
/** A new scene's counters. */
export const firstIds = (): NextId => ({ box: 1, group: 1, cylinder: 1, freeform: 1, line: 1, ramp: 1, note: 1, instance: 1, array: 1 });

/** `project.json` */
export const ProjectFileSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  createdAt: z.string(),
  // The Unity export (15.2): the folder the human picked for the project (each scene exports into a folder of its own
  // in it, named by the scene's ID), and the scenes exported after every step.
  unity: z.object({ dir: z.string(), auto: z.array(z.string()).optional() }).optional(),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/**
 * `library.json`: the project's tags and skills (plan 08 §5), written in full after every library step. The design
 * guide's text is in `rules/design-guide.md`. `seeded` lists the defaults the project was given ("guide"), so a
 * default it deleted doesn't come back.
 */
export const LibraryFileSchema = z.object({
  seq: z.number().int().min(0),
  tags: z.array(TagSchema).default([]),
  skills: z.array(SkillSchema).default([]),
  entities: z.array(EntityMetaSchema).default([]),
  seeded: z.array(z.string()).default([]),
});
export type LibraryFile = z.infer<typeof LibraryFileSchema>;

/**
 * `entities/<id>/entity.json`: an entity's definition (plan 08 §7), laid out like a scene: its nodes around the pivot
 * (the origin, at its bottom center), its ID counters, and the step its history is at. Its name, description and
 * tags are in the library.
 */
export const EntityFileSchema = z.object({
  createdAt: z.string(),
  seq: z.number().int().min(0),
  nextId: NextIdSchema,
  nodes: z.array(NodeSchema),
});
export type EntityFile = z.infer<typeof EntityFileSchema>;

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

/**
 * `shots/shots.json`, in a scene's or an entity's folder (plan 09 §3): the next shot number and every shot's record,
 * oldest first. The images are `shots/<id>.png`.
 */
export const ShotsFileSchema = z.object({
  nextId: z.number().int().min(1),
  shots: z.array(ShotRecordSchema),
});
export type ShotsFile = z.infer<typeof ShotsFileSchema>;

/** `app.json`: the server-level state. */
export const AppFileSchema = z.object({
  lastOpen: z.object({ project: z.string(), scene: z.string() }).nullable().default(null),
  // The scene the human invited the agent to (14.5: Work with agent), kept across restarts.
  agentScene: z.object({ project: z.string(), scene: z.string() }).nullable().default(null),
});
export type AppFile = z.infer<typeof AppFileSchema>;

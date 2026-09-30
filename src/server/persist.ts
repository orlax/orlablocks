import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AppFileSchema,
  EditorFileSchema,
  EntityFileSchema,
  firstIds,
  LibraryFileSchema,
  ProjectFileSchema,
  SceneFileSchema,
  ShotsFileSchema,
  type AppFile,
  type EditorFile,
  type EntityFile,
  type LibraryFile,
  type ProjectFile,
  type SceneFile,
  type ShotsFile,
} from "../shared/project.types";
import { DEFAULT_PLAYER, NodeSchema, PlayerCameraSchema, type Actor, type NodePatch, type PlayerCamera, type ProjectSummary } from "../shared/scene.types";
import { LibraryOpSchema, type LibraryOp } from "../shared/library";
import type { Op } from "./commands";

/**
 * File access for the data folder (plan 04 §3), and nothing else: no scene logic. Writes are synchronous and
 * atomic (a temp file, then a rename), so a crash never leaves half a file.
 */

/** The folders a project holds for the semantic layer: entity definitions (08.4) and the design guide. */
export const SEMANTIC_FOLDERS = ["entities", "rules"] as const;

export class LockedError extends Error {}

/**
 * One line of `history.jsonl`: a new step with its ops and inverse, or an undo / redo of an existing one. `seq`
 * counts every line, so it matches `scene.json`'s `seq` once that step is saved there.
 */
export type HistoryLine = { seq: number; at: number } & (
  | { type: "commit"; label: string; actor: Actor; ops: Op[]; inverse: Op[] }
  | { type: "undo" }
  | { type: "redo" }
);

/** One line of `library-history.jsonl`: like a scene's, with library ops. */
export type LibraryHistoryLine = { seq: number; at: number } & (
  | { type: "commit"; label: string; actor: Actor; ops: LibraryOp[]; inverse: LibraryOp[] }
  | { type: "undo" }
  | { type: "redo" }
);

const LibraryHistoryLineSchema = z.discriminatedUnion("type", [
  z.object({
    seq: z.number().int().min(1),
    at: z.number(),
    type: z.literal("commit"),
    label: z.string(),
    actor: z.enum(["human", "agent"]),
    ops: z.array(LibraryOpSchema),
    inverse: z.array(LibraryOpSchema),
  }),
  z.object({ seq: z.number().int().min(1), at: z.number(), type: z.literal("undo") }),
  z.object({ seq: z.number().int().min(1), at: z.number(), type: z.literal("redo") }),
]);

/** Reads a JSON-lines log, checking each line with `schema`. Null if the file doesn't exist. */
function readLines<T extends z.ZodType>(file: string, schema: T): z.output<T>[] | null {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((text, i) => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`${file} line ${i + 1}: ${(err as Error).message}`);
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(`${file} line ${i + 1}: ${issue.path.map(String).join(".") || "(line)"}: ${issue.message}`);
    }
    return result.data;
  });
}

/**
 * In an update patch, a key set to undefined removes that field (e.g. undoing a first rename removes the name).
 * JSON drops undefined keys, so the log writes them as null and reads null back as undefined.
 */
const PatchSchema = z
  .record(z.string(), z.unknown())
  .transform((patch) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === null ? undefined : v])) as NodePatch);

const encodePatch = (patch: NodePatch) =>
  Object.fromEntries(Object.keys(patch).map((k) => [k, (patch as Record<string, unknown>)[k] ?? null]));
const encodeOps = (ops: Op[]) =>
  ops.map((op) => (op.op === "update" ? { ...op, changes: op.changes.map((c) => ({ id: c.id, patch: encodePatch(c.patch) })) } : op));

const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), nodes: z.array(NodeSchema), indices: z.array(z.number().int().min(0)).optional() }),
  z.object({ op: z.literal("remove"), ids: z.array(z.string()) }),
  z.object({ op: z.literal("update"), changes: z.array(z.object({ id: z.string(), patch: PatchSchema })) }),
  z.object({ op: z.literal("order"), ids: z.array(z.string()) }),
]);

const HistoryLineSchema = z.discriminatedUnion("type", [
  z.object({
    seq: z.number().int().min(1),
    at: z.number(),
    type: z.literal("commit"),
    label: z.string(),
    actor: z.enum(["human", "agent"]),
    ops: z.array(OpSchema),
    inverse: z.array(OpSchema),
  }),
  z.object({ seq: z.number().int().min(1), at: z.number(), type: z.literal("undo") }),
  z.object({ seq: z.number().int().min(1), at: z.number(), type: z.literal("redo") }),
]);

/** A document that has shots (plan 09 §3): a scene, or an entity (shots taken in Edit entity mode). */
export type DocumentRef = { kind: "scene" | "entity"; id: string };

/** A shot's ID as it may appear in a file name. */
export const SHOT_ID = /^shot_\d+$/;

/** "Castle Dungeon!" → "castle-dungeon". Accents are dropped; anything left empty becomes `fallback`. */
export function slugify(name: string, fallback: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** `slug`, or `slug-2`, `slug-3`... whichever isn't a folder in `parent` yet. */
function freeSlug(parent: string, slug: string): string {
  if (!fs.existsSync(path.join(parent, slug))) return slug;
  for (let n = 2; ; n++) if (!fs.existsSync(path.join(parent, `${slug}-${n}`))) return `${slug}-${n}`;
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Reads and checks a JSON file. Throws an Error naming the file and what's wrong. */
function readJson<T extends z.ZodType>(file: string, schema: T): z.output<T> {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.map(String).join(".") || "(file)"}: ${i.message}`);
    throw new Error(`${file}: ${issues.slice(0, 3).join("; ")}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ""}`);
  }
  return result.data;
}

/** The subfolders of `dir` (none if it doesn't exist). */
function subfolders(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
}

/** Whether a process with this PID is running. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Opens the data folder: creates it if needed and takes its lock, so no second server can use it. Throws a
 * LockedError if a running process holds the lock. A lock left by a process that's gone is taken over.
 */
export function openDataDir(root: string) {
  const projectsDir = path.join(root, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });

  const lockFile = path.join(root, ".lock");
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
      throw new LockedError(`${root} is in use by another server (PID ${pid}). Stop it, or set DATA_DIR to another folder.`);
    }
    fs.rmSync(lockFile);
  }
  fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });

  const projectDir = (project: string) => path.join(projectsDir, project);
  const scenesDir = (project: string) => path.join(projectDir(project), "scenes");
  const sceneFile = (project: string, scene: string) => path.join(scenesDir(project), scene, "scene.json");
  const historyFile = (project: string, scene: string) => path.join(scenesDir(project), scene, "history.jsonl");
  const editorFile = (project: string, scene: string) => path.join(scenesDir(project), scene, "editor.json");
  const libraryFile = (project: string) => path.join(projectDir(project), "library.json");
  const libraryHistoryFile = (project: string) => path.join(projectDir(project), "library-history.jsonl");
  const guideFile = (project: string) => path.join(projectDir(project), "rules", "design-guide.md");
  const entitiesDir = (project: string) => path.join(projectDir(project), "entities");
  const entityFile = (project: string, entity: string) => path.join(entitiesDir(project), entity, "entity.json");
  const appFile = path.join(root, "app.json");
  const shotsDir = (project: string, doc: DocumentRef) =>
    path.join(doc.kind === "scene" ? scenesDir(project) : entitiesDir(project), doc.id, "shots");

  return {
    root,

    /** Gives the lock back (on shutdown). */
    release(): void {
      try {
        if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.rmSync(lockFile);
      } catch {
        // Already gone.
      }
    },

    /** `app.json`, or the defaults if it's missing. Throws if it exists but doesn't load. */
    readApp(): AppFile {
      return fs.existsSync(appFile) ? readJson(appFile, AppFileSchema) : AppFileSchema.parse({});
    },

    writeApp(app: AppFile): void {
      writeJson(appFile, app);
    },

    /** Every project with its scenes (in creation order), sorted by name. Files that don't load are reported, not thrown. */
    listProjects(): ProjectSummary[] {
      return subfolders(projectsDir)
        .map((id): ProjectSummary => {
          let project: ProjectFile;
          try {
            project = readJson(path.join(projectDir(id), "project.json"), ProjectFileSchema);
          } catch (err) {
            return { id, name: id, description: "", scenes: [], error: (err as Error).message };
          }
          const scenes = subfolders(scenesDir(id)).map((sceneId) => {
            try {
              const scene = readJson(sceneFile(id, sceneId), SceneFileSchema);
              return { id: sceneId, name: scene.name, createdAt: scene.createdAt };
            } catch (err) {
              return { id: sceneId, name: sceneId, createdAt: "", error: (err as Error).message };
            }
          });
          // Creation order; scenes that don't load (no date) go last.
          scenes.sort((a, b) => Number(!a.createdAt) - Number(!b.createdAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          return {
            id,
            name: project.name,
            description: project.description,
            scenes: scenes.map(({ createdAt: _createdAt, ...s }) => s),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },

    /** Makes the project's folder (with `scenes/` and the semantic folders) and `project.json`. Returns its ID. */
    createProject(name: string, description: string): string {
      const id = freeSlug(projectsDir, slugify(name, "project"));
      fs.mkdirSync(scenesDir(id), { recursive: true });
      for (const folder of SEMANTIC_FOLDERS) fs.mkdirSync(path.join(projectDir(id), folder));
      writeJson(path.join(projectDir(id), "project.json"), { name, description, createdAt: new Date().toISOString() });
      return id;
    },

    readProject(project: string): ProjectFile {
      return readJson(path.join(projectDir(project), "project.json"), ProjectFileSchema);
    },

    /** Changes a project's name, description or export folders. Throws (writing nothing) if `project.json` doesn't load. */
    updateProject(project: string, changes: Partial<Omit<ProjectFile, "createdAt">>): void {
      const file = readJson(path.join(projectDir(project), "project.json"), ProjectFileSchema);
      writeJson(path.join(projectDir(project), "project.json"), { ...file, ...changes });
    },

    projectExists(project: string): boolean {
      return fs.existsSync(path.join(projectDir(project), "project.json"));
    },

    /** Makes an empty scene in the project. Returns its ID. */
    createScene(project: string, name: string): string {
      const id = freeSlug(scenesDir(project), slugify(name, "scene"));
      fs.mkdirSync(path.join(scenesDir(project), id), { recursive: true });
      const file: SceneFile = { name, createdAt: new Date().toISOString(), seq: 0, nextId: firstIds(), nodes: [] };
      writeJson(sceneFile(project, id), file);
      return id;
    },

    /** Whether the scene's folder exists (a folder deleted by hand is simply gone). */
    sceneExists(project: string, scene: string): boolean {
      return fs.existsSync(path.join(scenesDir(project), scene));
    },

    /**
     * Copies a scene's folder (state, history and editor state) into a new scene named `name`, with a new
     * creation time. Throws, copying nothing, if the source doesn't load. Returns the copy's ID.
     */
    duplicateScene(project: string, scene: string, name: string): string {
      const source = readJson(sceneFile(project, scene), SceneFileSchema);
      const id = freeSlug(scenesDir(project), slugify(name, "scene"));
      fs.cpSync(path.join(scenesDir(project), scene), path.join(scenesDir(project), id), { recursive: true });
      writeJson(sceneFile(project, id), { ...source, name, createdAt: new Date().toISOString() });
      return id;
    },

    readScene(project: string, scene: string): SceneFile {
      return readJson(sceneFile(project, scene), SceneFileSchema);
    },

    writeScene(project: string, scene: string, file: SceneFile): void {
      writeJson(sceneFile(project, scene), file);
    },

    /** The scene's `editor.json`, or null if it has none. Throws if it doesn't load. */
    readEditor(project: string, scene: string): EditorFile | null {
      const file = editorFile(project, scene);
      return fs.existsSync(file) ? readJson(file, EditorFileSchema) : null;
    },

    writeEditor(project: string, scene: string, file: EditorFile): void {
      writeJson(editorFile(project, scene), file);
    },

    /** Adds one line to the scene's history log. Lines are never rewritten. */
    appendHistory(project: string, scene: string, line: HistoryLine): void {
      const encoded = line.type === "commit" ? { ...line, ops: encodeOps(line.ops), inverse: encodeOps(line.inverse) } : line;
      fs.appendFileSync(historyFile(project, scene), `${JSON.stringify(encoded)}\n`);
    },

    /**
     * The scene's history log, or null if it has none (a new scene, or one saved before the log existed). Throws
     * an Error naming the first line that doesn't load.
     */
    readHistory(project: string, scene: string): HistoryLine[] | null {
      return readLines(historyFile(project, scene), HistoryLineSchema) as HistoryLine[] | null;
    },

    /**
     * The project's library: `library.json` (null if it has none yet) and the design guide's text (null if
     * `rules/design-guide.md` doesn't exist). Throws if `library.json` exists but doesn't load.
     */
    readLibrary(project: string): { file: LibraryFile | null; guide: string | null } {
      const file = fs.existsSync(libraryFile(project)) ? readJson(libraryFile(project), LibraryFileSchema) : null;
      const guide = fs.existsSync(guideFile(project)) ? fs.readFileSync(guideFile(project), "utf8") : null;
      return { file, guide };
    },

    /** Writes `library.json`, and the design guide when `guide` is given (the guide first: the file's seq says the step is saved). */
    writeLibrary(project: string, file: LibraryFile, guide?: string): void {
      if (guide !== undefined) {
        fs.mkdirSync(path.dirname(guideFile(project)), { recursive: true });
        const tmp = `${guideFile(project)}.tmp`;
        fs.writeFileSync(tmp, guide);
        fs.renameSync(tmp, guideFile(project));
      }
      writeJson(libraryFile(project), file);
    },

    /**
     * Every entity definition in the project, by its ID (its folder), including ones the library no longer lists (a
     * deleted entity keeps its folder, so undoing the delete brings it back). Ones that don't load are reported.
     */
    readEntities(project: string): { entities: Record<string, EntityFile>; errors: string[] } {
      const entities: Record<string, EntityFile> = {};
      const errors: string[] = [];
      for (const id of subfolders(entitiesDir(project))) {
        if (!fs.existsSync(entityFile(project, id))) continue;
        try {
          entities[id] = readJson(entityFile(project, id), EntityFileSchema);
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
      return { entities, errors };
    },

    /** Makes an entity's folder and `entity.json`; its ID is a free slug of `name`. Returns the ID. */
    createEntity(project: string, name: string, file: EntityFile): string {
      fs.mkdirSync(entitiesDir(project), { recursive: true });
      const id = freeSlug(entitiesDir(project), slugify(name, "entity"));
      fs.mkdirSync(path.join(entitiesDir(project), id));
      writeJson(entityFile(project, id), file);
      return id;
    },

    writeEntity(project: string, entity: string, file: EntityFile): void {
      writeJson(entityFile(project, entity), file);
    },

    readEntity(project: string, entity: string): EntityFile {
      return readJson(entityFile(project, entity), EntityFileSchema);
    },

    /** Adds one line to an entity's own history log (08.5: its edits, apart from every scene's). */
    appendEntityHistory(project: string, entity: string, line: HistoryLine): void {
      const encoded = line.type === "commit" ? { ...line, ops: encodeOps(line.ops), inverse: encodeOps(line.inverse) } : line;
      fs.appendFileSync(path.join(entitiesDir(project), entity, "history.jsonl"), `${JSON.stringify(encoded)}\n`);
    },

    readEntityHistory(project: string, entity: string): HistoryLine[] | null {
      return readLines(path.join(entitiesDir(project), entity, "history.jsonl"), HistoryLineSchema) as HistoryLine[] | null;
    },

    /** An entity's `editor.json` (the camera and selection it was left with), or null. */
    readEntityEditor(project: string, entity: string): EditorFile | null {
      const file = path.join(entitiesDir(project), entity, "editor.json");
      return fs.existsSync(file) ? readJson(file, EditorFileSchema) : null;
    },

    writeEntityEditor(project: string, entity: string, file: EditorFile): void {
      writeJson(path.join(entitiesDir(project), entity, "editor.json"), file);
    },

    /** The project's `player.json` (09.2), or the defaults if it has none. Throws if it exists but doesn't load. */
    readPlayer(project: string): PlayerCamera {
      const file = path.join(projectDir(project), "player.json");
      return fs.existsSync(file) ? readJson(file, PlayerCameraSchema) : DEFAULT_PLAYER;
    },

    writePlayer(project: string, player: PlayerCamera): void {
      writeJson(path.join(projectDir(project), "player.json"), player);
    },

    /** A document's `shots/shots.json`, or null if it has no shots yet. Throws if it exists but doesn't load. */
    readShots(project: string, doc: DocumentRef): ShotsFile | null {
      const file = path.join(shotsDir(project, doc), "shots.json");
      return fs.existsSync(file) ? readJson(file, ShotsFileSchema) : null;
    },

    writeShots(project: string, doc: DocumentRef, file: ShotsFile): void {
      fs.mkdirSync(shotsDir(project, doc), { recursive: true });
      writeJson(path.join(shotsDir(project, doc), "shots.json"), file);
    },

    /** Writes a shot's image (atomically, like every file here). */
    writeShotImage(project: string, doc: DocumentRef, id: string, png: Buffer): void {
      if (!SHOT_ID.test(id)) throw new Error(`Not a shot ID: ${id}`);
      fs.mkdirSync(shotsDir(project, doc), { recursive: true });
      const file = path.join(shotsDir(project, doc), `${id}.png`);
      fs.writeFileSync(`${file}.tmp`, png);
      fs.renameSync(`${file}.tmp`, file);
    },

    removeShotImage(project: string, doc: DocumentRef, id: string): void {
      if (!SHOT_ID.test(id)) return;
      fs.rmSync(path.join(shotsDir(project, doc), `${id}.png`), { force: true });
    },

    /**
     * Where a shot's image is on disk, or null if there's none. Every part must be a plain folder or shot name, so a
     * path from a URL can't reach outside the data folder.
     */
    shotImageFile(project: string, doc: DocumentRef, id: string): string | null {
      const plain = /^[a-z0-9][a-z0-9-]*$/;
      if (!plain.test(project) || !plain.test(doc.id) || !SHOT_ID.test(id)) return null;
      const file = path.join(shotsDir(project, doc), `${id}.png`);
      return fs.existsSync(file) ? file : null;
    },

    /** When the design guide last changed on disk, or null if the project has none. */
    guideChangedAt(project: string): Date | null {
      return fs.existsSync(guideFile(project)) ? fs.statSync(guideFile(project)).mtime : null;
    },

    /** Adds one line to the library's history log. */
    appendLibraryHistory(project: string, line: LibraryHistoryLine): void {
      fs.appendFileSync(libraryHistoryFile(project), `${JSON.stringify(line)}\n`);
    },

    /** The library's history log, or null if it has none. Throws an Error naming the first line that doesn't load. */
    readLibraryHistory(project: string): LibraryHistoryLine[] | null {
      return readLines(libraryHistoryFile(project), LibraryHistoryLineSchema) as LibraryHistoryLine[] | null;
    },
  };
}

export type DataDir = ReturnType<typeof openDataDir>;

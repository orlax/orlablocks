import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { AppFileSchema, ProjectFileSchema, SceneFileSchema, type AppFile, type ProjectFile, type SceneFile } from "../shared/project.types";
import type { ProjectSummary } from "../shared/scene.types";

/**
 * File access for the data folder (plan 04 §3), and nothing else: no scene logic. Writes are synchronous and
 * atomic (a temp file, then a rename), so a crash never leaves half a file.
 */

/** The folders a project holds for the semantic layer. Created empty for now. */
export const SEMANTIC_FOLDERS = ["abilities", "entities", "rules"] as const;

export class LockedError extends Error {}

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
  const appFile = path.join(root, "app.json");

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

    /** Makes an empty scene in the project. Returns its ID. */
    createScene(project: string, name: string): string {
      const id = freeSlug(scenesDir(project), slugify(name, "scene"));
      fs.mkdirSync(path.join(scenesDir(project), id), { recursive: true });
      const file: SceneFile = { name, createdAt: new Date().toISOString(), seq: 0, nextId: { box: 1, group: 1 }, nodes: [] };
      writeJson(sceneFile(project, id), file);
      return id;
    },

    /** Whether the scene's folder exists (a folder deleted by hand is simply gone). */
    sceneExists(project: string, scene: string): boolean {
      return fs.existsSync(path.join(scenesDir(project), scene));
    },

    readScene(project: string, scene: string): SceneFile {
      return readJson(sceneFile(project, scene), SceneFileSchema);
    },

    writeScene(project: string, scene: string, file: SceneFile): void {
      writeJson(sceneFile(project, scene), file);
    },
  };
}

export type DataDir = ReturnType<typeof openDataDir>;

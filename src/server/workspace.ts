import { z } from "zod";
import {
  CreateProjectSchema,
  CreateSceneSchema,
  DEFAULT_SCENE_NAME,
  DuplicateSceneSchema,
  OpenSceneSchema,
  RenameSceneSchema,
  UpdateProjectSchema,
  type Camera,
  type EditorRestore,
  type OpenScene,
  type ProjectSummary,
  type View,
} from "../shared/scene.types";
import { round2 } from "../shared/geometry";
import type { NextId, SceneFile } from "../shared/project.types";
import { applyOp, createHistory, type HistoryEntry } from "./commands";
import type { DataDir, HistoryLine } from "./persist";
import { createSceneStore, SceneError, type SceneStore, type Step } from "./scene";

/** Parses with a zod schema or throws a SceneError starting with `failure`. */
function parse<T extends z.ZodType>(schema: T, input: unknown, failure: string): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new SceneError(`${failure}\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Runs a file operation, turning a file that doesn't load into a SceneError starting with `failure`. */
function fileOp<T>(failure: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SceneError) throw err;
    throw new SceneError(`${failure}\n${(err as Error).message}`);
  }
}

/** `editor.json` is written this long after the last camera or selection change (once it stops, not while it moves). */
export const EDITOR_SAVE_DELAY_MS = 500;

export const NO_SCENE_OPEN = "No scene is open. Ask the human to create or open a project in the editor.";

/** The history step a log line records. */
const stepOf = (line: HistoryLine) =>
  line.type === "commit"
    ? { type: "commit" as const, entry: { label: line.label, actor: line.actor, at: line.at, ops: line.ops, inverse: line.inverse } }
    : { type: line.type };

/** The log line for a step the store just took. */
const lineOf = (seq: number, step: Step): HistoryLine =>
  step.type === "commit" ? { seq, type: "commit", ...step.entry } : { seq, type: step.type, at: Date.now() };

/** ID counters raised past every node an entry adds (for a step `scene.json` missed). */
function raisedNextId(nextId: NextId, entry: HistoryEntry): NextId {
  const next = { ...nextId };
  for (const op of [...entry.ops, ...entry.inverse]) {
    if (op.op !== "add") continue;
    for (const node of op.nodes) {
      const match = /^(box|group)_(\d+)$/.exec(node.id);
      if (match) {
        const kind = match[1] as keyof NextId;
        next[kind] = Math.max(next[kind], Number(match[2]) + 1);
      }
    }
  }
  return next;
}

/**
 * Rebuilds the history from the log and checks it against `scene.json`. They agree when the log ends at the
 * scene's `seq`. A crash between the two writes leaves the log exactly one step ahead: that step is applied to the
 * nodes here (`caughtUp`). Anything else is an Error, and the scene doesn't open.
 */
export function restoreScene(file: SceneFile, lines: HistoryLine[] | null) {
  const history = createHistory();
  let { nodes, nextId, seq } = file;
  if (!lines || lines.length === 0) return { nodes, nextId, seq, history, caughtUp: false };

  lines.forEach((line, i) => {
    if (i > 0 && line.seq !== lines[i - 1].seq + 1) {
      throw new Error(`history.jsonl: step ${line.seq} follows step ${lines[i - 1].seq}`);
    }
  });
  const last = lines.at(-1)!.seq;
  if (last !== file.seq && last !== file.seq + 1) {
    throw new Error(`history.jsonl ends at step ${last}, but scene.json is at step ${file.seq}`);
  }
  for (const line of lines) {
    let entry: HistoryEntry;
    try {
      entry = history.replay(stepOf(line));
    } catch (err) {
      throw new Error(`history.jsonl step ${line.seq}: ${(err as Error).message}`);
    }
    if (line.seq > file.seq) {
      nodes = (line.type === "undo" ? entry.inverse : entry.ops).reduce(applyOp, nodes);
      nextId = raisedNextId(nextId, entry);
      seq = line.seq;
    }
  }
  return { nodes, nextId, seq, history, caughtUp: seq !== file.seq };
}

/**
 * The open scene (plan 04 §4): one per server, shared by every tab and the agent, or none. Loads a scene's files
 * into the store when it opens, and writes `scene.json` after every step.
 */
export function createWorkspace(data: DataDir) {
  const store = createSceneStore();
  let open: (OpenScene & { createdAt: string; seq: number; camera: Camera | null }) | null = null;
  const openedListeners = new Set<(open: OpenScene | null, restore?: EditorRestore) => void>();
  const projectsListeners = new Set<(projects: ProjectSummary[]) => void>();

  const publicOpen = (): OpenScene | null => (open ? { project: open.project, scene: open.scene } : null);

  const writeScene = () => {
    if (!open) return;
    data.writeScene(open.project.id, open.scene.id, {
      name: open.scene.name,
      createdAt: open.createdAt,
      seq: open.seq,
      nextId: store.getNextId(),
      nodes: store.getScene().nodes,
    });
  };

  // The log first, then the state: a crash in between leaves the log one step ahead, which opening repairs.
  store.onStep((step) => {
    if (!open) return;
    open.seq += 1;
    try {
      data.appendHistory(open.project.id, open.scene.id, lineOf(open.seq, step));
      writeScene();
    } catch (err) {
      console.error("Saving the scene failed", err);
      throw new SceneError(`The change was made but not saved: ${(err as Error).message}`);
    }
  });

  const projectsChanged = () => {
    const projects = data.listProjects();
    projectsListeners.forEach((l) => l(projects));
  };
  const openedChanged = (restore?: EditorRestore) => {
    const current = publicOpen();
    openedListeners.forEach((l) => l(current, restore));
  };

  const restoreOf = (): EditorRestore | undefined =>
    open ? { camera: open.camera, selection: store.getScene().selection } : undefined;

  // editor.json: debounced, so a pan writes once, after it stops.
  let editorTimer: ReturnType<typeof setTimeout> | null = null;
  const flushEditor = () => {
    if (!editorTimer) return;
    clearTimeout(editorTimer);
    editorTimer = null;
    if (!open) return;
    try {
      data.writeEditor(open.project.id, open.scene.id, restoreOf()!);
    } catch (err) {
      console.error("Saving the editor state failed", err);
    }
  };
  const editorChanged = () => {
    if (!open) return;
    if (editorTimer) clearTimeout(editorTimer);
    editorTimer = setTimeout(flushEditor, EDITOR_SAVE_DELAY_MS);
    editorTimer.unref?.();
  };

  const requireProject = (project: string, failure: string) => {
    if (!data.projectExists(project)) throw new SceneError(`${failure}\nNo project "${project}"`);
  };
  const requireSceneFolder = (project: string, scene: string, failure: string) => {
    if (!data.sceneExists(project, scene)) throw new SceneError(`${failure}\nNo scene "${scene}" in project "${project}"`);
  };

  /** Loads a scene into the store and makes it the open one. Throws a SceneError if it's missing or doesn't load. */
  const openScene = (project: string, scene: string) => {
    if (!data.sceneExists(project, scene)) throw new SceneError(`No scene "${scene}" in project "${project}"`);
    // The scene being left keeps its last camera and selection.
    flushEditor();
    let loaded;
    try {
      const file = data.readScene(project, scene);
      loaded = { project: data.readProject(project), file, ...restoreScene(file, data.readHistory(project, scene)) };
    } catch (err) {
      throw new SceneError(`The scene didn't load, so it wasn't opened:\n${(err as Error).message}`);
    }
    // Editor state holds no work: if it doesn't load, the scene opens without it and it's replaced on the next change.
    let editor = null;
    try {
      editor = data.readEditor(project, scene);
    } catch (err) {
      console.warn(`Ignoring the editor state: ${(err as Error).message}`);
    }
    open = {
      project: { id: project, name: loaded.project.name, description: loaded.project.description },
      scene: { id: scene, name: loaded.file.name },
      createdAt: loaded.file.createdAt,
      seq: loaded.seq,
      camera: editor?.camera ?? null,
    };
    store.load({ nodes: loaded.nodes, nextId: loaded.nextId, history: loaded.history });
    store.setSelection(editor?.selection ?? []);
    if (loaded.caughtUp) {
      console.warn(`${project}/${scene}: scene.json missed the last step in history.jsonl; applied it`);
      writeScene();
    }
    data.writeApp({ lastOpen: { project, scene } });
    openedChanged(restoreOf());
  };

  return {
    /** The store behind the open scene. Always exists (view and selection reports go to it even with nothing open). */
    store,

    getOpen: publicOpen,

    /** The open scene's camera and selection, for a tab that just connected. */
    getRestore: restoreOf,

    /** The editor's view (for the agent) and camera (saved for the scene). Not edits: no broadcast, no history. */
    setView(view: View, camera: Camera): void {
      store.setView(view);
      if (!open) return;
      const next = { focus: { x: round2(camera.focus.x), z: round2(camera.focus.z) }, yaw: round2(camera.yaw), distance: round2(camera.distance) };
      if (JSON.stringify(next) === JSON.stringify(open.camera)) return;
      open.camera = next;
      editorChanged();
    },

    /** The editor's selection (for the agent, and saved for the scene). */
    setSelection(ids: string[]): void {
      const before = store.getScene().selection.join(",");
      store.setSelection(ids);
      if (store.getScene().selection.join(",") !== before) editorChanged();
    },

    /** Writes a pending editor state now (the server is stopping). */
    flush(): void {
      flushEditor();
    },

    projects(): ProjectSummary[] {
      return data.listProjects();
    },

    /** The store, for reading or editing the open scene. Throws a SceneError while nothing is open. */
    requireScene(): SceneStore {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      return store;
    },

    /** Reopens the scene that was open when the server stopped, if it's still there and loads. */
    restore(): void {
      let lastOpen;
      try {
        lastOpen = data.readApp().lastOpen;
      } catch (err) {
        console.warn(`Not reopening the last scene: ${(err as Error).message}`);
        return;
      }
      if (!lastOpen) return;
      try {
        openScene(lastOpen.project, lastOpen.scene);
      } catch (err) {
        console.warn(`Not reopening ${lastOpen.project}/${lastOpen.scene}: ${(err as Error).message}`);
      }
    },

    /** Creates a project and its first scene, and opens that scene. */
    createProject(input: z.input<typeof CreateProjectSchema>): OpenScene {
      const { name, description = "", sceneName = DEFAULT_SCENE_NAME } = parse(CreateProjectSchema, input, "The project wasn't created.");
      const project = data.createProject(name, description);
      const scene = data.createScene(project, sceneName);
      projectsChanged();
      openScene(project, scene);
      return publicOpen()!;
    },

    /** Renames a project and/or changes its description. The folder keeps its slug. */
    updateProject(input: z.input<typeof UpdateProjectSchema>): void {
      const failure = "The project wasn't changed.";
      const { project, ...changes } = parse(UpdateProjectSchema, input, failure);
      requireProject(project, failure);
      if (changes.name === undefined && changes.description === undefined) return;
      fileOp(failure, () => data.updateProject(project, changes));
      projectsChanged();
      if (open?.project.id === project) {
        open.project = { ...open.project, ...changes };
        openedChanged();
      }
    },

    /** Creates an empty scene in a project, and opens it. Returns its ID. */
    createScene(input: z.input<typeof CreateSceneSchema>): string {
      const failure = "The scene wasn't created.";
      const { project, name } = parse(CreateSceneSchema, input, failure);
      requireProject(project, failure);
      const scene = data.createScene(project, name);
      projectsChanged();
      openScene(project, scene);
      return scene;
    },

    /** Renames a scene. Not a history step. The folder keeps its slug. */
    renameScene(input: z.input<typeof RenameSceneSchema>): void {
      const failure = "The scene wasn't renamed.";
      const { project, scene, name } = parse(RenameSceneSchema, input, failure);
      requireSceneFolder(project, scene, failure);
      if (open?.project.id === project && open.scene.id === scene) {
        // The open scene's state is in memory: write it with the new name.
        open.scene = { ...open.scene, name };
        writeScene();
        openedChanged();
      } else {
        fileOp(failure, () => data.writeScene(project, scene, { ...data.readScene(project, scene), name }));
      }
      projectsChanged();
    },

    /** Copies a scene, history included, and opens the copy. Returns its ID. */
    duplicateScene(input: z.input<typeof DuplicateSceneSchema>): string {
      const failure = "The scene wasn't duplicated.";
      const { project, scene, name } = parse(DuplicateSceneSchema, input, failure);
      requireSceneFolder(project, scene, failure);
      // The copy starts from the open scene's latest camera.
      flushEditor();
      const copy = fileOp(failure, () => {
        const source = data.readScene(project, scene);
        return data.duplicateScene(project, scene, name ?? `${source.name} copy`.slice(0, 80));
      });
      projectsChanged();
      openScene(project, copy);
      return copy;
    },

    openScene(input: z.input<typeof OpenSceneSchema>): void {
      const { project, scene } = parse(OpenSceneSchema, input, "The scene wasn't opened.");
      openScene(project, scene);
    },

    /** When the open scene changes (with `restore`), or its project or name does (without). */
    onOpened(listener: (open: OpenScene | null, restore?: EditorRestore) => void): () => void {
      openedListeners.add(listener);
      return () => openedListeners.delete(listener);
    },

    onProjectsChanged(listener: (projects: ProjectSummary[]) => void): () => void {
      projectsListeners.add(listener);
      return () => projectsListeners.delete(listener);
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

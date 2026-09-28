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
import { applyLibraryOp, entityMeta, findRefs, resolveRef, type EntityMeta, type Library, type LibraryEdit, type Uses } from "../shared/library";
import { allDefinitions, setDefinition, setDefinitions } from "../shared/entities";
import { firstIds, type LibraryFile, type NextId, type SceneFile } from "../shared/project.types";
import { isGroup, tagsOf } from "../shared/tree";
import type { SceneNode } from "../shared/scene.types";
import { applyOp, createHistory, type HistoryEntry } from "./commands";
import { DEFAULT_GUIDE } from "./defaultGuide";
import { createLibraryStore, newLibraryHistory, type LibraryEntry, type LibraryStep, type LibraryStore } from "./library";
import type { DataDir, HistoryLine, LibraryHistoryLine } from "./persist";
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
      const match = /^([a-z]+)_(\d+)$/.exec(node.id);
      if (match && match[1] in next) {
        const type = match[1] as keyof NextId;
        next[type] = Math.max(next[type], Number(match[2]) + 1);
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
 * Rebuilds the library's history from its log and checks it against `library.json`, as `restoreScene` does for a
 * scene: a log one step ahead (a crash between the two writes) has that step applied here.
 */
export function restoreLibrary(file: LibraryFile | null, guide: string | null, lines: LibraryHistoryLine[] | null) {
  const history = newLibraryHistory();
  let library: Library = { tags: file?.tags ?? [], skills: file?.skills ?? [], entities: file?.entities ?? [], guide: guide ?? "" };
  let seq = file?.seq ?? 0;
  const start = seq;
  if (!lines || lines.length === 0) return { library, seq, history, caughtUp: false };
  lines.forEach((line, i) => {
    if (i > 0 && line.seq !== lines[i - 1].seq + 1) throw new Error(`library-history.jsonl: step ${line.seq} follows step ${lines[i - 1].seq}`);
  });
  const last = lines.at(-1)!.seq;
  if (last !== start && last !== start + 1) throw new Error(`library-history.jsonl ends at step ${last}, but library.json is at step ${start}`);
  for (const line of lines) {
    let entry: LibraryEntry;
    try {
      entry = history.replay(
        line.type === "commit"
          ? { type: "commit", entry: { label: line.label, actor: line.actor, at: line.at, ops: line.ops, inverse: line.inverse } }
          : { type: line.type },
      );
    } catch (err) {
      throw new Error(`library-history.jsonl step ${line.seq}: ${(err as Error).message}`);
    }
    if (line.seq > start) {
      library = (line.type === "undo" ? entry.inverse : entry.ops).reduce(applyLibraryOp, library);
      seq = line.seq;
    }
  }
  return { library, seq, history, caughtUp: seq !== start };
}

/**
 * How many nodes in `nodes` use each tag and skill (carrying the tag, an instance through its entity's, or naming it
 * in a group's description or a note), and each entity (its instances).
 */
export function countUses(library: Library, nodes: SceneNode[]): { tags: Map<string, number>; skills: Map<string, number>; entities: Map<string, number> } {
  const tags = new Map<string, number>();
  const skills = new Map<string, number>();
  const entities = new Map<string, number>();
  for (const n of nodes) {
    const used = { tag: new Set<string>(), skill: new Set<string>() };
    if (n.type === "instance") entities.set(n.entity, (entities.get(n.entity) ?? 0) + 1);
    const carried = n.type === "instance" ? entityMeta(library, n.entity)?.tags : tagsOf(n);
    for (const t of carried ?? []) {
      const tag = resolveRef(library, "tag", t);
      if (tag) used.tag.add(tag.name);
    }
    const text = isGroup(n) ? n.description : n.type === "note" ? n.text : undefined;
    if (text) {
      for (const r of findRefs(text)) {
        const found = resolveRef(library, r.kind, r.name);
        if (found) used[r.kind].add(found.name);
      }
    }
    used.tag.forEach((t) => tags.set(t, (tags.get(t) ?? 0) + 1));
    used.skill.forEach((k) => skills.set(k, (skills.get(k) ?? 0) + 1));
  }
  return { tags, skills, entities };
}

/**
 * The open scene (plan 04 §4): one per server, shared by every tab and the agent, or none. Loads a scene's files
 * into the store when it opens, and writes `scene.json` after every step.
 */
export function createWorkspace(data: DataDir) {
  const library: LibraryStore = createLibraryStore();
  const store = createSceneStore({
    resolveTag: (name) => resolveRef(library.get(), "tag", name)?.name,
    entityName: (id) => entityMeta(library.get(), id)?.name,
  });
  const entitiesListeners = new Set<(definitions: Record<string, SceneNode[]>) => void>();
  const entitiesChanged = () => entitiesListeners.forEach((l) => l(allDefinitions()));
  // The library open with the scene: its project, the step it's saved at, and the defaults it was given.
  let openLibrary: { project: string; seq: number; seeded: string[] } | null = null;
  // Each other scene's nodes in the open project, for counting uses (read when the library loads or changes).
  let otherScenes: { name: string; nodes: SceneNode[] }[] = [];
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

  const libraryFile = (): LibraryFile => ({
    seq: openLibrary!.seq,
    tags: library.get().tags,
    skills: library.get().skills,
    entities: library.get().entities,
    seeded: openLibrary!.seeded,
  });

  const readOtherScenes = () => {
    if (!open) return void (otherScenes = []);
    const project = data.listProjects().find((p) => p.id === open!.project.id);
    otherScenes = (project?.scenes ?? [])
      .filter((sc) => sc.id !== open!.scene.id && !sc.error)
      .flatMap((sc) => {
        try {
          return [{ name: sc.name, nodes: data.readScene(open!.project.id, sc.id).nodes }];
        } catch {
          return [];
        }
      });
  };

  // The log first, then the state (the guide before library.json), as for a scene.
  library.onStep((step: LibraryStep) => {
    if (!openLibrary) return;
    openLibrary.seq += 1;
    const line: LibraryHistoryLine = step.type === "commit" ? { seq: openLibrary.seq, type: "commit", ...step.entry } : { seq: openLibrary.seq, type: step.type, at: Date.now() };
    const touchesGuide = step.entry.ops.some((op) => op.op === "guide");
    try {
      data.appendLibraryHistory(openLibrary.project, line);
      data.writeLibrary(openLibrary.project, libraryFile(), touchesGuide ? library.get().guide : undefined);
    } catch (err) {
      console.error("Saving the library failed", err);
      throw new SceneError(`The change was made but not saved: ${(err as Error).message}`);
    }
  });

  /** Loads a project's library into its store (when a scene of another project opens), seeding the default guide once. */
  const loadLibrary = (project: string) => {
    if (openLibrary?.project === project) return;
    let restored;
    let file: LibraryFile | null;
    try {
      const read = data.readLibrary(project);
      file = read.file;
      restored = restoreLibrary(read.file, read.guide, data.readLibraryHistory(project));
    } catch (err) {
      throw new SceneError(`The project's library didn't load, so the scene wasn't opened:\n${(err as Error).message}`);
    }
    const seeded = [...(file?.seeded ?? [])];
    let { library: loaded } = restored;
    const seed = !seeded.includes("guide");
    if (seed) {
      if (!loaded.guide) loaded = { ...loaded, guide: DEFAULT_GUIDE };
      seeded.push("guide");
    }
    // The definitions, for every instance in the project's scenes (a folder that doesn't load shows as missing).
    const { entities, errors } = data.readEntities(project);
    errors.forEach((e) => console.warn(`Skipping an entity that didn't load: ${e}`));
    setDefinitions(Object.fromEntries(Object.entries(entities).map(([id, f]) => [id, f.nodes])));
    openLibrary = { project, seq: restored.seq, seeded };
    library.load({ library: loaded, history: restored.history });
    entitiesChanged();
    if (seed || restored.caughtUp || !file) data.writeLibrary(project, libraryFile(), seed || restored.caughtUp ? loaded.guide : undefined);
  };

  /** How many nodes use each tag, skill and entity, and in which of the project's scenes (the open one live). */
  const usesNow = (): Uses => {
    const lib = library.get();
    const result: Uses = { tags: {}, skills: {}, entities: {} };
    const scenes = open ? [{ name: open.scene.name, nodes: store.getScene().nodes }, ...otherScenes] : [];
    for (const { name: sceneName, nodes } of scenes) {
      const counts = countUses(lib, nodes);
      for (const kind of ["tags", "skills"] as const) {
        for (const [name, n] of counts[kind]) {
          const u = (result[kind][name] ??= { nodes: 0, scenes: 0 });
          u.nodes += n;
          u.scenes += 1;
        }
      }
      for (const [id, n] of counts.entities) {
        const u = (result.entities[id] ??= { nodes: 0, scenes: 0, sceneNames: [] });
        u.nodes += n;
        u.scenes += 1;
        u.sceneNames.push(sceneName);
      }
    }
    return result;
    };

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
    loadLibrary(project);
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
    readOtherScenes();
    openedChanged(restoreOf());
  };

  return {
    /** The store behind the open scene. Always exists (view and selection reports go to it even with nothing open). */
    store,

    /** The store behind the open project's library (empty until a scene opens). */
    library,

    /** The library, for reading or editing. Throws a SceneError while nothing is open. */
    requireLibrary(): LibraryStore {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      return library;
    },

    /**
     * Edits the open project's library as one step (see the library store's `edit`). An entity that's placed in any
     * of the project's scenes can't be deleted: the error names the scenes.
     */
    editLibrary(input: LibraryEdit, actor: "human" | "agent") {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      const uses = usesNow().entities;
      const placed = (input.remove ?? []).filter((r) => r.kind === "entity" && uses[r.name]);
      if (placed.length > 0) {
        const lines = placed.map((r) => {
          const u = uses[r.name];
          return `${entityMeta(library.get(), r.name)?.name ?? r.name} is placed ${u.nodes} time${u.nodes === 1 ? "" : "s"}, in ${u.sceneNames.join(", ")}`;
        });
        throw new SceneError(`The library wasn't changed: remove or detach an entity's instances before deleting it.\n${lines.join("\n")}`);
      }
      return library.edit(input, actor);
    },

    /**
     * Make entity (plan 08 §7): the nodes become a new entity's definition (moved so its pivot, their bottom center,
     * is at the origin), and one instance of it takes their place in the scene, as one scene step. The entity itself
     * is created like a scene is (not an undo step): undoing puts the nodes back, and the entity stays in the
     * library. A single group gives the entity its name, description and tags unless they're given.
     */
    makeEntity(input: { ids: string[]; name?: string; description?: string; tags?: string[] }, actor: "human" | "agent") {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      const prepared = store.prepareEntity(input.ids);
      const name = (input.name ?? prepared.from?.name ?? "").trim() || "entity";
      const description = (input.description ?? prepared.from?.description ?? "").trim();
      const tagNames = input.tags ?? prepared.from?.tags ?? [];
      const missing = tagNames.filter((t) => !resolveRef(library.get(), "tag", t));
      if (missing.length > 0) throw new SceneError(`tags: no tag ${missing.map((t) => `#${t}`).join(", ")} in the project library. No entity was made.`);
      const tags = [...new Set(tagNames.map((t) => resolveRef(library.get(), "tag", t)!.name))];
      const nextId = raisedNextId(firstIds(), { label: "", actor, at: 0, ops: [{ op: "add", nodes: prepared.nodes }], inverse: [] });
      const id = fileOp("No entity was made.", () =>
        data.createEntity(open!.project.id, name, { createdAt: new Date().toISOString(), seq: 0, nextId, nodes: prepared.nodes }),
      );
      const meta: EntityMeta = { id, name, ...(description ? { description } : {}), ...(tags.length > 0 ? { tags } : {}) };
      setDefinition(id, prepared.nodes);
      library.addEntityQuietly(meta);
      data.writeLibrary(open.project.id, libraryFile());
      entitiesChanged();
      const instance = store.commitEntity(prepared, id, name, actor);
      return { entity: meta, instance };
    },

    /** Every definition in the open project (for the editor). */
    definitions: () => allDefinitions(),

    /** When a definition is added or the project changes. */
    onEntitiesChanged(listener: (definitions: Record<string, SceneNode[]>) => void): () => void {
      entitiesListeners.add(listener);
      return () => entitiesListeners.delete(listener);
    },

    /** When the open project's design guide last changed, or null if it has none. */
    guideChangedAt(): Date | null {
      return open ? data.guideChangedAt(open.project.id) : null;
    },

    /** How many nodes use each tag, skill and entity, and in how many of the project's scenes (the open one live). */
    uses: (): Uses => usesNow(),

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

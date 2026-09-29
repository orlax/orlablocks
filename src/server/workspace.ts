import { z } from "zod";
import {
  CreateProjectSchema,
  CreateSceneSchema,
  DEFAULT_PLAYER,
  DEFAULT_SCENE_NAME,
  DuplicateSceneSchema,
  OpenSceneSchema,
  RenameSceneSchema,
  UpdateProjectSchema,
  type Camera,
  type EditorRestore,
  type OpenScene,
  type PlayerCamera,
  type ProjectSummary,
  type View,
} from "../shared/scene.types";
import { arrayItems } from "../shared/arrays";
import { boundsOf, round2 } from "../shared/geometry";
import { applyLibraryOp, entityMeta, findRefs, resolveRef, type EntityMeta, type Library, type LibraryEdit, type Uses } from "../shared/library";
import { allDefinitions, setDefinition, setDefinitions } from "../shared/entities";
import { firstIds, type AppFile, type LibraryFile, type NextId, type SceneFile } from "../shared/project.types";
import { isGroup, tagsOf } from "../shared/tree";
import type { AgentInfo, SceneNode, Shape, ShapeInput } from "../shared/scene.types";
import { applyOp, createHistory, type HistoryEntry } from "./commands";
import { DEFAULT_GUIDE } from "./defaultGuide";
import { HUMAN, HUMAN_DESCRIPTION } from "./defaultEntities";
import { createLibraryStore, newLibraryHistory, type LibraryEntry, type LibraryStep, type LibraryStore } from "./library";
import type { DataDir, HistoryLine, LibraryHistoryLine } from "./persist";
import { createSceneStore, SceneError, type SceneStore, type Step } from "./scene";
import { createShotStore, type NewShot, type ShotStore } from "./shots";

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

/** Where the camera starts in an entity opened for the first time: its pivot, the origin, from close by. */
const ENTITY_CAMERA: Camera = { focus: { x: 0, z: 0 }, yaw: 45, distance: 18 };

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
    // An array places its entities once per item.
    if (n.type === "array") {
      const items = arrayItems(n);
      for (const item of items) entities.set(item.entity, (entities.get(item.entity) ?? 0) + 1);
      // An entity the array lists but no item shows yet still counts as used (it can't be deleted from under it).
      for (const { entity } of n.entities) if (!items.some((i) => i.entity === entity)) entities.set(entity, (entities.get(entity) ?? 0) + 1);
    }
    const carried =
      n.type === "instance" ? entityMeta(library, n.entity)?.tags : n.type === "array" ? n.entities.flatMap((e) => entityMeta(library, e.entity)?.tags ?? []) : tagsOf(n);
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
/**
 * Where an entity's shapes are centered on the ground (14.2), for the off-center warning: their bounds' middle, with
 * each box's and cylinder's bounds made symmetric about its own center first, so a 7-sided cylinder (whose bounds
 * lean toward its pointed side) centered on the origin counts as centered.
 */
export function entityMiddle(shapes: Shape[]): { x: number; z: number } {
  let [minX, maxX, minZ, maxZ] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const s of shapes) {
    const b = boundsOf([s]);
    if (s.type === "box" || s.type === "cylinder") {
      const hx = Math.max(s.x - b.minX, b.maxX - s.x);
      const hz = Math.max(s.z - b.minZ, b.maxZ - s.z);
      [minX, maxX, minZ, maxZ] = [Math.min(minX, s.x - hx), Math.max(maxX, s.x + hx), Math.min(minZ, s.z - hz), Math.max(maxZ, s.z + hz)];
    } else {
      [minX, maxX, minZ, maxZ] = [Math.min(minX, b.minX), Math.max(maxX, b.maxX), Math.min(minZ, b.minZ), Math.max(maxZ, b.maxZ)];
    }
  }
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}

export function createWorkspace(data: DataDir) {
  const library: LibraryStore = createLibraryStore();
  const store = createSceneStore({
    resolveTag: (name) => resolveRef(library.get(), "tag", name)?.name,
    entityName: (id) => entityMeta(library.get(), id)?.name,
  });
  const shots: ShotStore = createShotStore(data);
  // The open project's player camera (09.2): its settings for walks, and whether its file loaded (one that didn't
  // is never written over).
  let player: { project: string; camera: PlayerCamera; broken: boolean } | null = null;
  const playerListeners = new Set<(player: PlayerCamera) => void>();
  const loadPlayer = (project: string) => {
    if (player?.project === project) return;
    try {
      player = { project, camera: data.readPlayer(project), broken: false };
    } catch (err) {
      console.warn(`Using the default player camera: ${(err as Error).message}`);
      player = { project, camera: DEFAULT_PLAYER, broken: true };
    }
    playerListeners.forEach((l) => l(player!.camera));
  };
  const entitiesListeners = new Set<(definitions: Record<string, SceneNode[]>) => void>();
  const entitiesChanged = () => entitiesListeners.forEach((l) => l(allDefinitions()));
  // The library open with the scene: its project, the step it's saved at, and the defaults it was given.
  let openLibrary: { project: string; seq: number; seeded: string[] } | null = null;
  // Each other scene's nodes in the open project, for counting uses (read when the library loads or changes).
  let otherScenes: { id: string; name: string; nodes: SceneNode[] }[] = [];
  let open:
    | (Omit<OpenScene, "entity"> & {
        createdAt: string;
        seq: number;
        camera: Camera | null;
        // While an entity is being edited (08.5): its file's fields and camera. The scene stays as where Back goes.
        entity?: { id: string; createdAt: string; seq: number; camera: Camera | null };
      })
    | null = null;
  const openedListeners = new Set<(open: OpenScene | null, restore?: EditorRestore) => void>();
  const projectsListeners = new Set<(projects: ProjectSummary[]) => void>();

  const publicOpen = (): OpenScene | null =>
    open
      ? {
          project: open.project,
          scene: open.scene,
          ...(open.entity ? { entity: { id: open.entity.id, name: entityMeta(library.get(), open.entity.id)?.name ?? open.entity.id } } : {}),
        }
      : null;

  const writeScene = () => {
    if (!open) return;
    if (open.entity) {
      // An entity's step: its file, and its definition for every instance (live, in every tab).
      const nodes = store.getScene().nodes;
      data.writeEntity(open.project.id, open.entity.id, { createdAt: open.entity.createdAt, seq: open.entity.seq, nextId: store.getNextId(), nodes });
      setDefinition(open.entity.id, nodes);
      entitiesChanged();
      return;
    }
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
    try {
      if (open.entity) {
        open.entity.seq += 1;
        data.appendEntityHistory(open.project.id, open.entity.id, lineOf(open.entity.seq, step));
      } else {
        open.seq += 1;
        data.appendHistory(open.project.id, open.scene.id, lineOf(open.seq, step));
      }
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

  /**
   * A new entity in the open project from its definition's nodes (around its pivot): its folder and file, the
   * library's entry (not an undo step, as a scene isn't), and every tab told. Tags must exist in the library.
   */
  const createEntity = (input: { name?: string; description?: string; tags?: string[] }, nodes: SceneNode[], actor: "human" | "agent"): EntityMeta => {
    const name = (input.name ?? "").trim() || "entity";
    const description = (input.description ?? "").trim();
    const tagNames = input.tags ?? [];
    const missing = tagNames.filter((t) => !resolveRef(library.get(), "tag", t));
    if (missing.length > 0) throw new SceneError(`tags: no tag ${missing.map((t) => `#${t}`).join(", ")} in the project library. No entity was made.`);
    const tags = [...new Set(tagNames.map((t) => resolveRef(library.get(), "tag", t)!.name))];
    const nextId = raisedNextId(firstIds(), { label: "", actor, at: 0, ops: [{ op: "add", nodes }], inverse: [] });
    const id = fileOp("No entity was made.", () => data.createEntity(open!.project.id, name, { createdAt: new Date().toISOString(), seq: 0, nextId, nodes }));
    const meta: EntityMeta = { id, name, ...(description ? { description } : {}), ...(tags.length > 0 ? { tags } : {}) };
    setDefinition(id, nodes);
    library.addEntityQuietly(meta);
    data.writeLibrary(open!.project.id, libraryFile());
    entitiesChanged();
    return meta;
  };

  const readOtherScenes = () => {
    if (!open) return void (otherScenes = []);
    const project = data.listProjects().find((p) => p.id === open!.project.id);
    otherScenes = (project?.scenes ?? [])
      .filter((sc) => (open!.entity || sc.id !== open!.scene.id) && !sc.error)
      .flatMap((sc) => {
        try {
          return [{ id: sc.id, name: sc.name, nodes: data.readScene(open!.project.id, sc.id).nodes }];
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
    const seedGuide = !seeded.includes("guide");
    if (seedGuide) {
      if (!loaded.guide) loaded = { ...loaded, guide: DEFAULT_GUIDE };
      seeded.push("guide");
    }
    // The default entities (08.5): a person for scale. Once per project, so one it deleted stays deleted.
    const seedHuman = !seeded.includes("human");
    if (seedHuman) {
      const id = data.createEntity(project, "human", { createdAt: new Date().toISOString(), seq: 0, nextId: raisedNextId(firstIds(), { label: "", actor: "human", at: 0, ops: [{ op: "add", nodes: HUMAN }], inverse: [] }), nodes: HUMAN });
      loaded = applyLibraryOp(loaded, { op: "entity", name: id, value: { id, name: "human", description: HUMAN_DESCRIPTION } });
      seeded.push("human");
    }
    const seed = seedGuide || seedHuman;
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
    // While an entity is open, the store holds it, and every scene (the one to go back to included) is read from disk.
    // The agent's own scene (14.5), live too.
    const others = agentDoc ? [...otherScenes.filter((sc) => sc.id !== agentDoc!.scene.id), { id: agentDoc.scene.id, name: agentDoc.scene.name, nodes: agentDoc.store.getScene().nodes }] : otherScenes;
    const scenes = open && !open.entity ? [{ name: open.scene.name, nodes: store.getScene().nodes }, ...others] : others;
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
    open ? { camera: open.entity ? open.entity.camera : open.camera, selection: store.getScene().selection } : undefined;

  // editor.json: debounced, so a pan writes once, after it stops.
  let editorTimer: ReturnType<typeof setTimeout> | null = null;
  const flushEditor = () => {
    if (!editorTimer) return;
    clearTimeout(editorTimer);
    editorTimer = null;
    if (!open) return;
    try {
      if (open.entity) data.writeEntityEditor(open.project.id, open.entity.id, restoreOf()!);
      else data.writeEditor(open.project.id, open.scene.id, restoreOf()!);
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

  /**
   * Work with agent (plan 14 §8). `agentScene` is the scene the human invited the agent to, or null (the agent works
   * in whatever the human has open, as before). While the human has that scene open, the two share the one store; when
   * the human opens another scene of the project (or an entity), the agent's scene is loaded into a store of its own
   * (`agentDoc`, from disk: every step is saved), which saves itself after every step. Opening it again rejoins it.
   * Opening another project ends the invitation, and the agent's next call is told once (`agentEnded`).
   */
  let agentScene: { project: string; scene: string } | null = null;
  let agentEnded: string | null = null;
  type AgentDoc = {
    project: OpenScene["project"];
    scene: OpenScene["scene"];
    createdAt: string;
    seq: number;
    store: SceneStore;
    shots: ShotStore;
    stop: () => void;
  };
  let agentDoc: AgentDoc | null = null;
  const agentListeners = new Set<(agent: AgentInfo | null) => void>();
  const agentInfo = (): AgentInfo | null => {
    if (!agentScene) return null;
    const name = agentDoc?.scene.name ?? (open && open.scene.id === agentScene.scene ? open.scene.name : agentScene.scene);
    return { project: agentScene.project, scene: agentScene.scene, name, apart: !!agentDoc };
  };
  const agentChanged = () => agentListeners.forEach((l) => l(agentInfo()));
  const writeAppFile = () =>
    data.writeApp({ lastOpen: open ? { project: open.project.id, scene: open.scene.id } : null, ...(agentScene ? { agentScene } : {}) } as AppFile);

  const writeAgentScene = (doc: AgentDoc) =>
    data.writeScene(doc.project.id, doc.scene.id, { name: doc.scene.name, createdAt: doc.createdAt, seq: doc.seq, nextId: doc.store.getNextId(), nodes: doc.store.getScene().nodes });

  /** Loads the agent's scene into a store of its own (from disk), saving it after every step. */
  const loadAgentDoc = (project: string, scene: string) => {
    const file = data.readScene(project, scene);
    const restored = restoreScene(file, data.readHistory(project, scene));
    const own = createSceneStore({
      resolveTag: (name) => resolveRef(library.get(), "tag", name)?.name,
      entityName: (id) => entityMeta(library.get(), id)?.name,
    });
    own.load({ nodes: restored.nodes, nextId: restored.nextId, history: restored.history });
    const docShots = createShotStore(data);
    docShots.load(project, { kind: "scene", id: scene });
    const projectFile = data.readProject(project);
    const doc: AgentDoc = {
      project: { id: project, name: projectFile.name, description: projectFile.description },
      scene: { id: scene, name: file.name },
      createdAt: file.createdAt,
      seq: restored.seq,
      store: own,
      shots: docShots,
      stop: () => {},
    };
    doc.stop = own.onStep((step) => {
      try {
        doc.seq += 1;
        data.appendHistory(project, scene, lineOf(doc.seq, step));
        writeAgentScene(doc);
      } catch (err) {
        console.error("Saving the agent's scene failed", err);
        throw new SceneError(`The change was made but not saved: ${(err as Error).message}`);
      }
    });
    agentDoc = doc;
  };
  const dropAgentDoc = () => {
    agentDoc?.stop();
    agentDoc = null;
  };
  const endInvitation = (why: string) => {
    if (!agentScene) return;
    agentEnded = why;
    agentScene = null;
    dropAgentDoc();
    writeAppFile();
    agentChanged();
  };
  /** Before the human's store leaves `open` for `next` (a scene, or null for an entity): where the agent's scene goes. */
  const beforeHumanMoves = (next: { project: string; scene: string } | null) => {
    if (!agentScene) return;
    if (next && next.project !== agentScene.project) {
      const name = agentInfo()?.name ?? agentScene.scene;
      endInvitation(`The human ended your invitation to "${name}": they opened another project. Your tools now act on the scene they have open.`);
      return;
    }
    if (next && next.scene === agentScene.scene) {
      // The human rejoins the agent's scene: one store again, loaded from disk (the agent's store saved every step).
      dropAgentDoc();
      return;
    }
    // The human leaves the agent's scene (for another scene or an entity): the agent keeps it in a store of its own.
    if (!agentDoc && open && !open.entity && open.scene.id === agentScene.scene) loadAgentDoc(agentScene.project, agentScene.scene);
  };

  /** Loads a scene into the store and makes it the open one. Throws a SceneError if it's missing or doesn't load. */
  const openScene = (project: string, scene: string) => {
    if (!data.sceneExists(project, scene)) throw new SceneError(`No scene "${scene}" in project "${project}"`);
    beforeHumanMoves({ project, scene });
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
    loadPlayer(project);
    open = {
      project: { id: project, name: loaded.project.name, description: loaded.project.description },
      scene: { id: scene, name: loaded.file.name },
      createdAt: loaded.file.createdAt,
      seq: loaded.seq,
      camera: editor?.camera ?? null,
    };
    store.load({ nodes: loaded.nodes, nextId: loaded.nextId, history: loaded.history });
    store.setSelection(editor?.selection ?? []);
    shots.load(project, { kind: "scene", id: scene });
    if (loaded.caughtUp) {
      console.warn(`${project}/${scene}: scene.json missed the last step in history.jsonl; applied it`);
      writeScene();
    }
    writeAppFile();
    readOtherScenes();
    openedChanged(restoreOf());
    agentChanged();
  };

  return {
    /** The store behind the open scene. Always exists (view and selection reports go to it even with nothing open). */
    store,

    /** The open project's player camera (09.2), or the defaults with nothing open. */
    player(): PlayerCamera {
      return player?.camera ?? DEFAULT_PLAYER;
    },

    /** Saves the open project's player camera (not an edit: no history). */
    setPlayer(camera: PlayerCamera): void {
      if (!open || !player) throw new SceneError(NO_SCENE_OPEN);
      if (player.broken) throw new SceneError("The player camera wasn't saved: the project's player.json didn't load.");
      if (JSON.stringify(camera) === JSON.stringify(player.camera)) return;
      player = { ...player, camera };
      data.writePlayer(open.project.id, camera);
      playerListeners.forEach((l) => l(camera));
    },

    /** When the player camera changes, or another project's is loaded. */
    onPlayerChanged(listener: (player: PlayerCamera) => void): () => void {
      playerListeners.add(listener);
      return () => playerListeners.delete(listener);
    },

    /** The open document's shots (09.1). */
    shots,

    /** Saves a shot of the open document, at its current history step. */
    addShot(shot: NewShot, actor: "human" | "agent") {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      return shots.add(shot, actor, open.entity ? open.entity.seq : open.seq);
    },

    /** The open document's history step (how far it has changed: a shot's `seq` is where it was). */
    documentSeq(): number | null {
      return open ? (open.entity ? open.entity.seq : open.seq) : null;
    },

    /** Where a shot's image is on disk, for the HTTP route (null if there's none). */
    shotImageFile(project: string, kind: "scenes" | "entities", doc: string, id: string): string | null {
      return data.shotImageFile(project, { kind: kind === "scenes" ? "scene" : "entity", id: doc }, id);
    },

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
      if (open.entity && (input.remove ?? []).some((r) => r.kind === "entity" && r.name === open!.entity!.id)) {
        throw new SceneError("The library wasn't changed: that entity is open for editing. Go back to the scene first.");
      }
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
    makeEntity(input: { ids: string[]; name?: string; description?: string; tags?: string[]; keep?: boolean }, actor: "human" | "agent") {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      const prepared = store.prepareEntity(input.ids);
      const meta = createEntity(
        { name: input.name ?? prepared.from?.name, description: input.description ?? prepared.from?.description, tags: input.tags ?? prepared.from?.tags },
        prepared.nodes,
        actor,
      );
      // keep: false (plan 13 §6): the shapes become the entity and leave nothing in their place.
      const instance = store.commitEntity(prepared, meta.id, meta.name, actor, input.keep ?? true);
      return { entity: meta, ...(instance ? { instance } : {}) };
    },

    /**
     * Define entity (plan 13 §6): a new entity from shapes given around its pivot (the bottom center at the origin),
     * without drawing them in the scene: no scene step, no instance. The shapes are checked as a definition's (no
     * instances, arrays or notes), with batch refs and groups as in draw_shapes. Returns the entity and warnings
     * when its bottom isn't at y 0 or its middle is off the origin (instances would float or sit off their point).
     */
    defineEntity(input: { name: string; description?: string; tags?: string[]; shapes: ShapeInput[] }, actor: "human" | "agent") {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      const scratch = createSceneStore({ resolveTag: (t) => resolveRef(library.get(), "tag", t)?.name });
      scratch.load({ document: "entity", nodes: [], nextId: firstIds() });
      let nodes: SceneNode[];
      try {
        nodes = scratch.drawShapes(input.shapes, actor);
      } catch (err) {
        if (err instanceof SceneError) throw new SceneError(err.message.replace("Nothing was drawn.", "No entity was made."));
        throw err;
      }
      const shapes = nodes.filter((n): n is Shape => !isGroup(n));
      if (shapes.length === 0) throw new SceneError("shapes: an entity needs at least one shape. No entity was made.");
      const meta = createEntity(input, nodes, actor);
      const b = boundsOf(shapes);
      const middle = entityMiddle(shapes);
      const warnings = [
        ...(round2(b.minY) !== 0 ? [`its bottom is at y ${round2(b.minY)}, not 0: instances will stand ${round2(b.minY)} m off their y`] : []),
        ...(Math.hypot(middle.x, middle.z) > 0.5
          ? [`its middle is at x ${round2(middle.x)}, z ${round2(middle.z)}: instances will sit that far off their point (build it around the origin)`]
          : []),
      ];
      return { entity: meta, ...(warnings.length > 0 ? { warnings } : {}) };
    },

    /**
     * Edit entity (08.5): opens an entity's definition in the store, as the open document, with its own history
     * (`entities/<id>/history.jsonl`) and camera. Every step saves it and redraws every instance. The scene stays
     * as where closeEntity goes back to.
     */
    openEntity(entity: string): void {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      const meta = entityMeta(library.get(), entity);
      if (!meta) throw new SceneError(`No entity "${entity}" in the project library.`);
      flushEditor();
      beforeHumanMoves(null);
      let loaded;
      try {
        const file = data.readEntity(open.project.id, entity);
        loaded = { file, ...restoreScene({ ...file, name: meta.name }, data.readEntityHistory(open.project.id, entity)) };
      } catch (err) {
        throw new SceneError(`The entity didn't load, so it wasn't opened:\n${(err as Error).message}`);
      }
      let editor = null;
      try {
        editor = data.readEntityEditor(open.project.id, entity);
      } catch (err) {
        console.warn(`Ignoring the entity's editor state: ${(err as Error).message}`);
      }
      open = { ...open, entity: { id: entity, createdAt: loaded.file.createdAt, seq: loaded.seq, camera: editor?.camera ?? ENTITY_CAMERA } };
      store.load({ nodes: loaded.nodes, nextId: loaded.nextId, history: loaded.history, document: "entity" });
      store.setSelection(editor?.selection ?? []);
      shots.load(open.project.id, { kind: "entity", id: entity });
      if (loaded.caughtUp) writeScene();
      readOtherScenes();
      openedChanged(restoreOf());
    },

    /** Leaves Edit entity: reopens the scene it was opened from. Nothing to do when no entity is open. */
    closeEntity(): void {
      if (!open?.entity) return;
      flushEditor();
      openScene(open.project.id, open.scene.id);
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
      const holder = open.entity ?? open;
      if (JSON.stringify(next) === JSON.stringify(holder.camera)) return;
      holder.camera = next;
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

    /**
     * The store the agent works in (14.5): its own scene's while the human is elsewhere, else the human's (as
     * requireScene). Once after the invitation ended, it throws to say so.
     */
    requireAgentScene(): SceneStore {
      if (agentEnded) {
        const why = agentEnded;
        agentEnded = null;
        throw new SceneError(why);
      }
      return agentDoc?.store ?? this.requireScene();
    },

    /** The document the agent works in: its own scene, or the human's open document. */
    agentOpen(): OpenScene | null {
      return agentDoc ? { project: agentDoc.project, scene: agentDoc.scene } : publicOpen();
    },

    /** Whether the agent has a scene of its own right now (the human is in another one), and which the human is in. */
    agentApart(): { humanIn: string } | null {
      return agentDoc ? { humanIn: open ? (open.entity ? `the entity ${open.entity.id}` : `"${open.scene.name}"`) : "nothing" } : null;
    },

    /** The agent's document's shots, and its history step (as `shots` and `documentSeq`, for its own scene). */
    agentShots(): ShotStore {
      return agentDoc?.shots ?? shots;
    },
    agentSeq(): number | null {
      return agentDoc ? agentDoc.seq : open ? (open.entity ? open.entity.seq : open.seq) : null;
    },
    /** Saves a shot of the agent's document (a render kept with save: true). */
    addAgentShot(shot: NewShot, actor: "human" | "agent") {
      if (agentDoc) return agentDoc.shots.add(shot, actor, agentDoc.seq);
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      return shots.add(shot, actor, open.entity ? open.entity.seq : open.seq);
    },

    /** Work with agent (14.5): the open scene becomes the agent's, wherever the human goes in the project. */
    inviteAgent(): void {
      if (!open) throw new SceneError(NO_SCENE_OPEN);
      if (open.entity) throw new SceneError("Open a scene to work with the agent in (this is an entity).");
      dropAgentDoc();
      agentScene = { project: open.project.id, scene: open.scene.id };
      agentEnded = null;
      writeAppFile();
      agentChanged();
    },

    /** Ends the invitation: the agent works in whatever the human has open again (told once, on its next call). */
    stopAgent(): void {
      const name = agentInfo()?.name;
      if (name !== undefined) endInvitation(`The human stopped working with you in "${name}". Your tools now act on the scene they have open.`);
    },

    /** The agent's scene, or null. */
    getAgent: (): AgentInfo | null => agentInfo(),

    onAgentChanged(listener: (agent: AgentInfo | null) => void): () => void {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },

    /** Reopens the scene that was open when the server stopped, if it's still there and loads. */
    restore(): void {
      let lastOpen;
      let invited: { project: string; scene: string } | null = null;
      try {
        ({ lastOpen, agentScene: invited } = data.readApp());
      } catch (err) {
        console.warn(`Not reopening the last scene: ${(err as Error).message}`);
        return;
      }
      if (!lastOpen) return;
      try {
        openScene(lastOpen.project, lastOpen.scene);
      } catch (err) {
        console.warn(`Not reopening ${lastOpen.project}/${lastOpen.scene}: ${(err as Error).message}`);
        return;
      }
      // The agent's scene (14.5), if it was invited to one of this project's (read before reopening wrote app.json).
      if (!invited || invited.project !== lastOpen.project || !data.sceneExists(invited.project, invited.scene)) return;
      agentScene = invited;
      try {
        if (invited.scene !== lastOpen.scene) loadAgentDoc(invited.project, invited.scene);
      } catch (err) {
        console.warn(`Not reopening the agent's scene: ${(err as Error).message}`);
        agentScene = null;
      }
      writeAppFile();
      agentChanged();
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
      } else if (agentDoc && agentDoc.project.id === project && agentDoc.scene.id === scene) {
        // So is the agent's own (14.5).
        agentDoc.scene = { ...agentDoc.scene, name };
        writeAgentScene(agentDoc);
        agentChanged();
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

import { z } from "zod";
import { CreateProjectSchema, DEFAULT_SCENE_NAME, type OpenScene, type ProjectSummary } from "../shared/scene.types";
import type { DataDir } from "./persist";
import { createSceneStore, SceneError, type SceneStore } from "./scene";

export const NO_SCENE_OPEN = "No scene is open. Ask the human to create or open a project in the editor.";

/**
 * The open scene (plan 04 §4): one per server, shared by every tab and the agent, or none. Loads a scene's files
 * into the store when it opens, and writes `scene.json` after every step.
 */
export function createWorkspace(data: DataDir) {
  const store = createSceneStore();
  let open: (OpenScene & { createdAt: string; seq: number }) | null = null;
  const openedListeners = new Set<(open: OpenScene | null) => void>();
  const projectsListeners = new Set<(projects: ProjectSummary[]) => void>();

  const publicOpen = (): OpenScene | null => (open ? { project: open.project, scene: open.scene } : null);

  store.onStep(() => {
    if (!open) return;
    open.seq += 1;
    const { nodes } = store.getScene();
    try {
      data.writeScene(open.project.id, open.scene.id, {
        name: open.scene.name,
        createdAt: open.createdAt,
        seq: open.seq,
        nextId: store.getNextId(),
        nodes,
      });
    } catch (err) {
      console.error("Saving the scene failed", err);
      throw new SceneError(`The change was made but not saved: ${(err as Error).message}`);
    }
  });

  const projectsChanged = () => {
    const projects = data.listProjects();
    projectsListeners.forEach((l) => l(projects));
  };

  /** Loads a scene into the store and makes it the open one. Throws a SceneError if it's missing or doesn't load. */
  const openScene = (project: string, scene: string) => {
    if (!data.sceneExists(project, scene)) throw new SceneError(`No scene "${scene}" in project "${project}"`);
    let loaded;
    try {
      loaded = { project: data.readProject(project), scene: data.readScene(project, scene) };
    } catch (err) {
      throw new SceneError(`The scene didn't load, so it wasn't opened:\n${(err as Error).message}`);
    }
    open = {
      project: { id: project, name: loaded.project.name, description: loaded.project.description },
      scene: { id: scene, name: loaded.scene.name },
      createdAt: loaded.scene.createdAt,
      seq: loaded.scene.seq,
    };
    store.load({ nodes: loaded.scene.nodes, nextId: loaded.scene.nextId });
    data.writeApp({ lastOpen: { project, scene } });
    const current = publicOpen();
    openedListeners.forEach((l) => l(current));
  };

  return {
    /** The store behind the open scene. Always exists (view and selection reports go to it even with nothing open). */
    store,

    getOpen: publicOpen,

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
      const result = CreateProjectSchema.safeParse(input);
      if (!result.success) throw new SceneError(`The project wasn't created.\n${z.prettifyError(result.error)}`);
      const { name, description = "", sceneName = DEFAULT_SCENE_NAME } = result.data;
      const project = data.createProject(name, description);
      const scene = data.createScene(project, sceneName);
      projectsChanged();
      openScene(project, scene);
      return publicOpen()!;
    },

    openScene(project: string, scene: string): void {
      openScene(project, scene);
    },

    onOpened(listener: (open: OpenScene | null) => void): () => void {
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

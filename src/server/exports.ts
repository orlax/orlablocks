import fs from "node:fs";
import path from "node:path";
import type { ExportStatus, ExportSummary } from "../shared/scene.types";
import { buildExport, exportScene } from "./export";
import { glbFromExport } from "./gltf";
import { loadManifold } from "./manifold";
import type { DataDir } from "./persist";
import { pickFolder } from "./picker";
import { SceneError } from "./scene";
import type { Workspace } from "./workspace";

/**
 * Exports (15.2). **Unity:** the project's folder (picked by the human in the system's folder dialog, kept in
 * `project.json`), each scene exported into a folder of its own in it (named by the scene's ID, which a rename
 * keeps), now or about a second after every step for the scenes that ask (never two at once for a scene: a step
 * during one exports again after it). The editor sees the open scene's status; the agent exports its own scene.
 * **A 3D file:** the open scene as one `.glb`, which the editor saves where the human says.
 */

/** How long after the last step an auto export runs. */
export const AUTO_EXPORT_DELAY_MS = 1000;

export const NO_EXPORT_FOLDER = "No Unity export folder for this project. Ask the human to choose one in the editor (Export → Unity).";

export function createExports(workspace: Workspace, data: DataDir) {
  const key = (project: string, scene: string) => `${project}/${scene}`;
  const last = new Map<string, NonNullable<ExportStatus["last"]>>();
  const running = new Set<string>();
  const again = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(status: ExportStatus | null) => void>();
  let picking = false;

  const settingsOf = (project: string) => {
    try {
      return data.readProject(project).unity ?? null;
    } catch {
      return null;
    }
  };
  const isAuto = (project: string, scene: string) => !!settingsOf(project)?.auto?.includes(scene);

  /** The human's open scene's status (while an entity is edited, its scene's). */
  const status = (): ExportStatus | null => {
    const open = workspace.getOpen();
    if (!open) return null;
    const [project, scene] = [open.project.id, open.scene.id];
    const dir = settingsOf(project)?.dir ?? "";
    const k = key(project, scene);
    return {
      project,
      scene,
      dir,
      sceneDir: dir ? path.join(dir, scene) : "",
      auto: isAuto(project, scene),
      picking,
      running: running.has(k),
      ...(last.has(k) ? { last: last.get(k)! } : {}),
    };
  };
  const broadcast = () => listeners.forEach((l) => l(status()));
  const changed = (project: string, scene: string) => {
    const open = workspace.getOpen();
    if (open && open.project.id === project && open.scene.id === scene) broadcast();
  };

  const run = async (project: string, scene: string): Promise<ExportSummary> => {
    const dir = settingsOf(project)?.dir;
    if (!dir) throw new SceneError(NO_EXPORT_FOLDER);
    const k = key(project, scene);
    if (running.has(k)) {
      again.add(k);
      throw new SceneError("An export of this scene is running; it exports again when it's done.");
    }
    running.add(k);
    changed(project, scene);
    try {
      const snap = workspace.sceneSnapshot(project, scene);
      const summary = await exportScene({ dir: path.join(dir, scene), project: snap.project, scene: snap.scene, seq: snap.seq, nodes: snap.nodes, library: workspace.library.get() });
      last.set(k, { at: new Date().toISOString(), summary });
      return summary;
    } catch (err) {
      const message = (err as Error).message;
      last.set(k, { at: new Date().toISOString(), error: message });
      throw err instanceof SceneError ? err : new SceneError(`The export failed: ${message}`);
    } finally {
      running.delete(k);
      changed(project, scene);
      if (again.delete(k)) schedule(project, scene);
    }
  };

  const schedule = (project: string, scene: string) => {
    if (!isAuto(project, scene) || !settingsOf(project)?.dir) return;
    const k = key(project, scene);
    if (running.has(k)) return void again.add(k);
    clearTimeout(timers.get(k));
    timers.set(
      k,
      setTimeout(() => {
        timers.delete(k);
        run(project, scene).catch((err) => console.warn(`Auto export of ${k}: ${(err as Error).message}`));
      }, AUTO_EXPORT_DELAY_MS),
    );
  };

  workspace.onSceneChanged(schedule);
  workspace.onOpened(broadcast);

  const requireOpen = () => {
    const open = workspace.getOpen();
    if (!open) throw new SceneError("No scene is open.");
    return open;
  };

  return {
    status,

    onStatus(listener: (status: ExportStatus | null) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Sets the open project's Unity folder (absolute; "" clears it). The scenes exported after every step export to it. */
    setFolder(dir: string): void {
      const open = requireOpen();
      const folder = dir.trim();
      if (folder && !path.isAbsolute(folder)) throw new SceneError(`The export folder must be an absolute path (${folder} isn't).`);
      if (folder && !(fs.existsSync(folder) && fs.statSync(folder).isDirectory())) throw new SceneError(`There's no folder ${folder}.`);
      const project = open.project.id;
      const was = settingsOf(project);
      data.updateProject(project, { unity: folder ? { dir: folder, ...(was?.auto?.length ? { auto: was.auto } : {}) } : undefined });
      broadcast();
      if (folder && folder !== was?.dir) for (const scene of was?.auto ?? []) schedule(project, scene);
    },

    /** Opens the system's folder dialog (on the server's machine: the human's) and sets what's picked. Cancel changes nothing. */
    async pickFolder(): Promise<void> {
      const open = requireOpen();
      if (picking) return;
      picking = true;
      broadcast();
      try {
        const dir = await pickFolder(settingsOf(open.project.id)?.dir);
        if (dir) this.setFolder(dir);
      } catch (err) {
        throw new SceneError(`The folder dialog didn't open: ${(err as Error).message}`);
      } finally {
        picking = false;
        broadcast();
      }
    },

    /** Whether the open scene is exported after every step. Turning it on exports right away. */
    setAuto(auto: boolean): void {
      const open = requireOpen();
      const [project, scene] = [open.project.id, open.scene.id];
      const s = settingsOf(project);
      if (!s?.dir) throw new SceneError("Choose the export folder first.");
      const others = (s.auto ?? []).filter((id) => id !== scene);
      data.updateProject(project, { unity: { dir: s.dir, ...(auto || others.length ? { auto: auto ? [...others, scene] : others } : {}) } });
      broadcast();
      if (auto) schedule(project, scene);
    },

    /** Exports the human's open scene to Unity now. */
    exportOpen(): Promise<ExportSummary> {
      const open = workspace.getOpen();
      if (!open) return Promise.reject(new SceneError("No scene is open."));
      return run(open.project.id, open.scene.id);
    },

    /** Exports the agent's scene to Unity now (its own, or the human's open one). */
    exportAgent(): Promise<ExportSummary> {
      const open = workspace.agentOpen();
      if (!open) return Promise.reject(new SceneError("No scene is open. Ask the human to create or open a project in the editor."));
      return run(open.project.id, open.scene.id);
    },

    /** The human's open scene as one glTF binary (`.glb`), and a file name for it. */
    async glbOpen(): Promise<{ name: string; glb: Buffer }> {
      const open = requireOpen();
      await loadManifold();
      const snap = workspace.sceneSnapshot(open.project.id, open.scene.id);
      const { manifest, binary } = buildExport({ project: snap.project, scene: snap.scene, seq: snap.seq, nodes: snap.nodes, library: workspace.library.get() });
      return { name: `${snap.scene.id}.glb`, glb: glbFromExport(manifest, binary) };
    },

    /** Stops pending auto exports (the server is closing, or a test ends). */
    stop(): void {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    },
  };
}

export type Exports = ReturnType<typeof createExports>;

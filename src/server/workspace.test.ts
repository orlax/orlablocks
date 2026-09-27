import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDataDir } from "./persist";
import { SceneError } from "./scene";
import { createWorkspace, NO_SCENE_OPEN } from "./workspace";

const roots: string[] = [];
const releases: (() => void)[] = [];
afterEach(() => {
  releases.splice(0).forEach((r) => r());
  roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
});

/** A server start on `root`: take the folder, reopen the last scene. `stop` is the server stopping. */
function start(root: string) {
  const data = openDataDir(root);
  releases.push(data.release);
  const workspace = createWorkspace(data);
  workspace.restore();
  return { workspace, stop: () => data.release() };
}
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dd-workspace-"));
  roots.push(root);
  return root;
};
const sceneDir = (root: string) => path.join(root, "projects", "castle", "scenes", "entrance");
const sceneJson = (root: string, project: string, scene: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "projects", project, "scenes", scene, "scene.json"), "utf8"));
const logLines = (root: string) =>
  fs.readFileSync(path.join(sceneDir(root), "history.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));

/** A server start with Castle ▸ Entrance created and open. */
function startWithScene(root: string) {
  const s = start(root);
  s.workspace.createProject({ name: "Castle", sceneName: "Entrance" });
  return { ...s, store: s.workspace.requireScene() };
}
const quietly = <T>(fn: () => T): T => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return fn();
  } finally {
    warn.mockRestore();
  }
};

describe("workspace", () => {
  it("starts with nothing open, and refuses scene work until a project exists", () => {
    const { workspace } = start(tempRoot());
    expect(workspace.getOpen()).toBeNull();
    expect(() => workspace.requireScene()).toThrow(NO_SCENE_OPEN);
    expect(workspace.projects()).toEqual([]);
  });

  it("creating a project creates its first scene and opens it", () => {
    const root = tempRoot();
    const { workspace } = start(root);
    const opened = vi.fn();
    workspace.onOpened(opened);
    workspace.createProject({ name: " Castle ", description: "Dungeon one", sceneName: "Entrance" });
    const open = { project: { id: "castle", name: "Castle", description: "Dungeon one" }, scene: { id: "entrance", name: "Entrance" } };
    expect(workspace.getOpen()).toEqual(open);
    expect(opened).toHaveBeenCalledWith(open, { camera: null, selection: [] });
    expect(JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"))).toEqual({ lastOpen: { project: "castle", scene: "entrance" } });
  });

  it("names the first scene Scene 1 by default", () => {
    const { workspace } = start(tempRoot());
    workspace.createProject({ name: "Castle" });
    expect(workspace.getOpen()!.scene).toEqual({ id: "scene-1", name: "Scene 1" });
  });

  it("rejects an empty project name", () => {
    const { workspace } = start(tempRoot());
    expect(() => workspace.createProject({ name: "   " })).toThrow(SceneError);
    expect(workspace.projects()).toEqual([]);
  });

  it("writes scene.json after every step: commit, undo and redo", () => {
    const root = tempRoot();
    const { workspace } = start(root);
    workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    const store = workspace.requireScene();
    store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
    expect(sceneJson(root, "castle", "entrance")).toMatchObject({ seq: 1, nextId: { box: 2, group: 1 } });
    expect(sceneJson(root, "castle", "entrance").nodes).toHaveLength(1);
    store.undo();
    expect(sceneJson(root, "castle", "entrance")).toMatchObject({ seq: 2, nodes: [] });
    store.redo();
    expect(sceneJson(root, "castle", "entrance")).toMatchObject({ seq: 3 });
    expect(sceneJson(root, "castle", "entrance").nodes).toHaveLength(1);
  });

  it("reopens the last scene on restart, and new IDs continue after deleted ones", () => {
    const root = tempRoot();
    const first = start(root);
    first.workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    const store = first.workspace.requireScene();
    store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }, { kind: "volume", x: 5, z: 0, width: 1, depth: 1 }], "agent");
    store.removeNodes(["box_2"], "human");
    first.stop();

    const second = start(root);
    expect(second.workspace.getOpen()!.scene.name).toBe("Entrance");
    const reopened = second.workspace.requireScene();
    expect(reopened.getScene().nodes.map((n) => n.id)).toEqual(["box_1"]);
    expect(reopened.getScene().nodes[0]).toMatchObject({ kind: "room", width: 6, createdBy: "agent" });
    const [box] = reopened.drawShapes([{ kind: "room", x: 10, z: 0, width: 2, depth: 2 }], "human");
    expect(box.id).toBe("box_3");
  });

  it("starts with nothing open when the last scene's folder was deleted by hand", () => {
    const root = tempRoot();
    const first = start(root);
    first.workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    first.stop();
    fs.rmSync(path.join(root, "projects", "castle"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = start(root);
    expect(second.workspace.getOpen()).toBeNull();
    warn.mockRestore();
  });

  it("doesn't open a scene whose file doesn't load, and never writes over it", () => {
    const root = tempRoot();
    const first = start(root);
    first.workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    first.stop();
    const file = path.join(root, "projects", "castle", "scenes", "entrance", "scene.json");
    fs.writeFileSync(file, '{"name": "Entrance", "nodes": "broken"}');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = start(root);
    expect(second.workspace.getOpen()).toBeNull();
    expect(() => second.workspace.openScene({ project: "castle", scene: "entrance" })).toThrow(/didn't load/);
    expect(fs.readFileSync(file, "utf8")).toBe('{"name": "Entrance", "nodes": "broken"}');
    warn.mockRestore();
  });

  describe("history log", () => {
    it("appends one line per commit, undo and redo, numbered like scene.json", () => {
      const root = tempRoot();
      const { store } = startWithScene(root);
      store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "agent");
      store.undo();
      store.redo();
      const lines = logLines(root);
      expect(lines.map((l) => [l.seq, l.type])).toEqual([[1, "commit"], [2, "undo"], [3, "redo"]]);
      expect(lines[0]).toMatchObject({ label: "Agent: draw box_1", actor: "agent" });
      expect(sceneJson(root, "castle", "entrance").seq).toBe(3);
    });

    it("keeps undo and redo across a restart, labels included", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      first.store.moveNodes({ ids: ["box_1"], dx: 2 }, "agent");
      first.store.drawShapes([{ kind: "volume", x: 9, z: 0, width: 1, depth: 1 }], "human");
      first.store.undo();
      first.stop();

      const { workspace } = start(root);
      const store = workspace.requireScene();
      expect(store.getHistory()).toEqual({ canUndo: true, canRedo: true, undoLabel: "Agent: move box_1", redoLabel: "Draw box_2" });
      store.redo();
      expect(store.getScene().nodes.map((n) => n.id)).toEqual(["box_1", "box_2"]);
      store.undo();
      store.undo();
      expect(store.getScene().nodes[0]).toMatchObject({ x: 0 });
      store.undo();
      expect(store.getScene().nodes).toEqual([]);
      expect(store.getHistory().canUndo).toBe(false);
    });

    it("undoing a first rename or a grouping after a restart removes the name and the parent", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }, { kind: "room", x: 8, z: 0, width: 4, depth: 4 }], "human");
      first.store.updateNodes([{ id: "box_1", name: "lobby" }], "human");
      first.store.groupNodes({ ids: ["box_1", "box_2"] }, "human");
      first.stop();

      const store = start(root).workspace.requireScene();
      store.undo();
      expect(store.getScene().nodes.map((n) => n.id)).toEqual(["box_1", "box_2"]);
      expect(store.getScene().nodes[0]).not.toHaveProperty("parent");
      store.undo();
      expect(store.getScene().nodes[0]).not.toHaveProperty("name");
    });

    it("applies the last step when a crash left scene.json one step behind the log", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      const before = fs.readFileSync(path.join(sceneDir(root), "scene.json"), "utf8");
      first.store.drawShapes([{ kind: "room", x: 8, z: 0, width: 4, depth: 4 }], "agent");
      first.stop();
      // The crash: the log got step 2, scene.json didn't.
      fs.writeFileSync(path.join(sceneDir(root), "scene.json"), before);

      const { workspace } = quietly(() => start(root));
      const store = workspace.requireScene();
      expect(store.getScene().nodes.map((n) => n.id)).toEqual(["box_1", "box_2"]);
      expect(sceneJson(root, "castle", "entrance")).toMatchObject({ seq: 2, nextId: { box: 3, group: 1 } });
      expect(store.drawShapes([{ kind: "room", x: 20, z: 0, width: 2, depth: 2 }], "human")[0].id).toBe("box_3");
      store.undo();
      store.undo();
      expect(store.getScene().nodes.map((n) => n.id)).toEqual(["box_1"]);
    });

    it("catches up a missed undo too", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      const before = fs.readFileSync(path.join(sceneDir(root), "scene.json"), "utf8");
      first.store.undo();
      first.stop();
      fs.writeFileSync(path.join(sceneDir(root), "scene.json"), before);

      const store = quietly(() => start(root)).workspace.requireScene();
      expect(store.getScene().nodes).toEqual([]);
      expect(store.getHistory()).toMatchObject({ canUndo: false, canRedo: true });
    });

    it("refuses to open when the log is behind scene.json, and writes over neither file", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      first.store.drawShapes([{ kind: "room", x: 8, z: 0, width: 4, depth: 4 }], "human");
      first.stop();
      const log = path.join(sceneDir(root), "history.jsonl");
      const shortLog = `${fs.readFileSync(log, "utf8").split("\n")[0]}\n`;
      fs.writeFileSync(log, shortLog);
      const sceneBefore = fs.readFileSync(path.join(sceneDir(root), "scene.json"), "utf8");

      const { workspace } = quietly(() => start(root));
      expect(workspace.getOpen()).toBeNull();
      expect(() => workspace.openScene({ project: "castle", scene: "entrance" })).toThrow(/ends at step 1, but scene.json is at step 2/);
      expect(fs.readFileSync(log, "utf8")).toBe(shortLog);
      expect(fs.readFileSync(path.join(sceneDir(root), "scene.json"), "utf8")).toBe(sceneBefore);
    });

    it("refuses to open when a log line doesn't load", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      first.stop();
      fs.appendFileSync(path.join(sceneDir(root), "history.jsonl"), '{"seq": 2, "type": "und');
      const { workspace } = quietly(() => start(root));
      expect(() => workspace.openScene({ project: "castle", scene: "entrance" })).toThrow(/history\.jsonl line 2/);
    });

    it("opens a scene saved before the log existed, with an empty history that continues from its seq", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      first.stop();
      fs.rmSync(path.join(sceneDir(root), "history.jsonl"));

      const store = start(root).workspace.requireScene();
      expect(store.getScene().nodes).toHaveLength(1);
      expect(store.getHistory().canUndo).toBe(false);
      store.drawShapes([{ kind: "room", x: 8, z: 0, width: 4, depth: 4 }], "human");
      expect(logLines(root).map((l) => l.seq)).toEqual([2]);
    });
  });

  describe("projects and scenes", () => {
    it("creates and opens a second scene, and each scene keeps its own nodes and history", () => {
      const root = tempRoot();
      const { workspace, store } = startWithScene(root);
      store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      expect(workspace.createScene({ project: "castle", name: "Crypt" })).toBe("crypt");
      expect(workspace.getOpen()!.scene).toEqual({ id: "crypt", name: "Crypt" });
      expect(store.getScene().nodes).toEqual([]);
      expect(store.getHistory().canUndo).toBe(false);
      store.drawShapes([{ kind: "volume", x: 1, z: 1, width: 1, depth: 1 }], "human");

      workspace.openScene({ project: "castle", scene: "entrance" });
      expect(store.getScene().nodes.map((n) => n.type === "box" && n.kind)).toEqual(["room"]);
      expect(store.getHistory().undoLabel).toBe("Draw box_1");
      expect(workspace.projects()[0].scenes.map((s) => s.name)).toEqual(["Entrance", "Crypt"]);
    });

    it("renames the open scene and another one, keeping their folders", () => {
      const root = tempRoot();
      const { workspace, store } = startWithScene(root);
      workspace.createScene({ project: "castle", name: "Crypt" });
      store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      const opened = vi.fn();
      workspace.onOpened(opened);

      workspace.renameScene({ project: "castle", scene: "crypt", name: "Catacombs" });
      expect(opened).toHaveBeenCalledWith(expect.objectContaining({ scene: { id: "crypt", name: "Catacombs" } }), undefined);
      workspace.renameScene({ project: "castle", scene: "entrance", name: "Gate" });
      expect(sceneJson(root, "castle", "crypt")).toMatchObject({ name: "Catacombs", seq: 1 });
      expect(sceneJson(root, "castle", "entrance")).toMatchObject({ name: "Gate" });
      // Edits after a rename keep the new name.
      store.drawShapes([{ kind: "room", x: 9, z: 0, width: 2, depth: 2 }], "human");
      expect(sceneJson(root, "castle", "crypt").name).toBe("Catacombs");
      expect(() => workspace.renameScene({ project: "castle", scene: "crypt", name: " " })).toThrow(SceneError);
    });

    it("renames a project and edits its description; the open scene reports it", () => {
      const root = tempRoot();
      const { workspace } = startWithScene(root);
      workspace.updateProject({ project: "castle", name: "Keep", description: "Now with a moat" });
      expect(workspace.getOpen()!.project).toEqual({ id: "castle", name: "Keep", description: "Now with a moat" });
      expect(JSON.parse(fs.readFileSync(path.join(root, "projects", "castle", "project.json"), "utf8"))).toMatchObject({
        name: "Keep",
        description: "Now with a moat",
      });
      expect(() => workspace.updateProject({ project: "nope", name: "X" })).toThrow(/No project "nope"/);
    });

    it("duplicates a scene with its history, opens the copy, and leaves the original alone", () => {
      const root = tempRoot();
      const { workspace, store } = startWithScene(root);
      store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      store.moveNodes({ ids: ["box_1"], dx: 2 }, "human");

      expect(workspace.duplicateScene({ project: "castle", scene: "entrance" })).toBe("entrance-copy");
      expect(workspace.getOpen()!.scene).toEqual({ id: "entrance-copy", name: "Entrance copy" });
      store.moveNodes({ ids: ["box_1"], dx: 5 }, "human");
      store.undo();
      store.undo();
      expect(store.getScene().nodes[0]).toMatchObject({ x: 0 });

      workspace.openScene({ project: "castle", scene: "entrance" });
      expect(store.getScene().nodes[0]).toMatchObject({ x: 2 });
      expect(store.getHistory().undoLabel).toBe("Move box_1");
    });

    it("doesn't switch away from the open scene when the other one fails to open", () => {
      const root = tempRoot();
      const { workspace } = startWithScene(root);
      workspace.createScene({ project: "castle", name: "Crypt" });
      fs.writeFileSync(path.join(root, "projects", "castle", "scenes", "entrance", "scene.json"), "{");
      expect(() => workspace.openScene({ project: "castle", scene: "entrance" })).toThrow(/didn't load/);
      expect(() => workspace.duplicateScene({ project: "castle", scene: "entrance" })).toThrow(/wasn't duplicated/);
      expect(workspace.getOpen()!.scene.id).toBe("crypt");
      expect(workspace.projects()[0].scenes.map((s) => s.id)).toEqual(["crypt", "entrance"]);
    });
  });

  describe("editor state", () => {
    const camera = { focus: { x: 4.123, z: -2 }, yaw: 90, distance: 40 };
    const view = { focus: { x: 4, z: -2 }, yaw: 90, bounds: { x: -20, z: -20, width: 40, depth: 40 } };
    const editorJson = (root: string, scene = "entrance") =>
      JSON.parse(fs.readFileSync(path.join(root, "projects", "castle", "scenes", scene, "editor.json"), "utf8"));
    const editorExists = (root: string, scene = "entrance") =>
      fs.existsSync(path.join(root, "projects", "castle", "scenes", scene, "editor.json"));

    it("writes editor.json once the camera and selection stop changing", () => {
      vi.useFakeTimers();
      try {
        const root = tempRoot();
        const { workspace, store } = startWithScene(root);
        store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
        workspace.setView(view, camera);
        vi.advanceTimersByTime(300);
        workspace.setView(view, { ...camera, yaw: 120 });
        workspace.setSelection(["box_1"]);
        vi.advanceTimersByTime(300);
        expect(editorExists(root)).toBe(false);
        vi.advanceTimersByTime(300);
        expect(editorJson(root)).toEqual({ camera: { focus: { x: 4.12, z: -2 }, yaw: 120, distance: 40 }, selection: ["box_1"] });
      } finally {
        vi.useRealTimers();
      }
    });

    it("restores the camera and selection on restart, and flush writes a pending change at once", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      first.workspace.setView(view, camera);
      first.workspace.setSelection(["box_1"]);
      first.workspace.flush();
      first.stop();

      const { workspace } = start(root);
      expect(workspace.getRestore()).toEqual({ camera: { focus: { x: 4.12, z: -2 }, yaw: 90, distance: 40 }, selection: ["box_1"] });
      // The agent sees the restored selection too.
      expect(workspace.requireScene().getScene().selection).toEqual(["box_1"]);
    });

    it("saves the scene being left before switching, and each scene restores its own camera", () => {
      const root = tempRoot();
      const { workspace } = startWithScene(root);
      const opened = vi.fn();
      workspace.onOpened(opened);
      workspace.setView(view, camera);
      workspace.createScene({ project: "castle", name: "Crypt" });
      expect(editorJson(root).camera).toMatchObject({ yaw: 90 });
      expect(opened).toHaveBeenLastCalledWith(expect.anything(), { camera: null, selection: [] });
      workspace.setView(view, { ...camera, yaw: 10 });

      workspace.openScene({ project: "castle", scene: "entrance" });
      expect(opened).toHaveBeenLastCalledWith(expect.anything(), { camera: expect.objectContaining({ yaw: 90 }), selection: [] });
      expect(editorJson(root, "crypt").camera).toMatchObject({ yaw: 10 });
    });

    it("drops saved selection IDs that are gone, and a rename doesn't send a restore", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.store.drawShapes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
      first.stop();
      fs.writeFileSync(
        path.join(root, "projects", "castle", "scenes", "entrance", "editor.json"),
        JSON.stringify({ camera: null, selection: ["box_1", "box_9"] }),
      );
      const { workspace } = start(root);
      expect(workspace.getRestore()!.selection).toEqual(["box_1"]);
      const opened = vi.fn();
      workspace.onOpened(opened);
      workspace.renameScene({ project: "castle", scene: "entrance", name: "Gate" });
      expect(opened).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it("opens a scene whose editor.json doesn't load, without it", () => {
      const root = tempRoot();
      const first = startWithScene(root);
      first.stop();
      fs.writeFileSync(path.join(root, "projects", "castle", "scenes", "entrance", "editor.json"), "{ nope");
      const { workspace } = quietly(() => start(root));
      expect(workspace.getOpen()!.scene.id).toBe("entrance");
      expect(workspace.getRestore()).toEqual({ camera: null, selection: [] });
    });

    it("a duplicate starts from the original's latest camera", () => {
      const root = tempRoot();
      const { workspace } = startWithScene(root);
      workspace.setView(view, camera);
      workspace.duplicateScene({ project: "castle", scene: "entrance" });
      expect(workspace.getRestore()!.camera).toMatchObject({ yaw: 90, distance: 40 });
    });
  });
});


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
const sceneJson = (root: string, project: string, scene: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "projects", project, "scenes", scene, "scene.json"), "utf8"));

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
    expect(opened).toHaveBeenCalledWith(open);
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
    store.drawBoxes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }], "human");
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
    store.drawBoxes([{ kind: "room", x: 0, z: 0, width: 6, depth: 4 }, { kind: "volume", x: 5, z: 0, width: 1, depth: 1 }], "agent");
    store.removeNodes(["box_2"], "human");
    first.stop();

    const second = start(root);
    expect(second.workspace.getOpen()!.scene.name).toBe("Entrance");
    const reopened = second.workspace.requireScene();
    expect(reopened.getScene().nodes.map((n) => n.id)).toEqual(["box_1"]);
    expect(reopened.getScene().nodes[0]).toMatchObject({ kind: "room", width: 6, createdBy: "agent" });
    const [box] = reopened.drawBoxes([{ kind: "room", x: 10, z: 0, width: 2, depth: 2 }], "human");
    expect(box.id).toBe("box_3");
    // History isn't saved yet (04.2): undo stops at the restart.
    reopened.undo();
    expect(reopened.getHistory().canUndo).toBe(false);
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
    expect(() => second.workspace.openScene("castle", "entrance")).toThrow(/didn't load/);
    expect(fs.readFileSync(file, "utf8")).toBe('{"name": "Entrance", "nodes": "broken"}');
    warn.mockRestore();
  });
});

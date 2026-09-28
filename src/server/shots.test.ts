import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDataDir } from "./persist";
import { SceneError } from "./scene";
import { pngSize } from "./shots";
import { createWorkspace } from "./workspace";

const roots: string[] = [];
const releases: (() => void)[] = [];
afterEach(() => {
  releases.splice(0).forEach((r) => r());
  roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
});

function start(root: string) {
  const data = openDataDir(root);
  releases.push(data.release);
  const workspace = createWorkspace(data);
  workspace.restore();
  return { workspace, stop: () => data.release() };
}
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dd-shots-"));
  roots.push(root);
  return root;
};
/** Castle ▸ Entrance, open. */
function startWithScene(root: string) {
  const s = start(root);
  s.workspace.createProject({ name: "Castle", sceneName: "Entrance" });
  return s;
}
const shotsDir = (root: string) => path.join(root, "projects", "castle", "scenes", "entrance", "shots");

/** A 1 × 1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const camera = { kind: "editor" as const, focus: { x: 1, z: 2 }, yaw: 45, distance: 30 };

describe("shots", () => {
  it("reads a PNG's size from its header, and nothing else", () => {
    expect(pngSize(Buffer.from(PNG, "base64"))).toEqual({ width: 1, height: 1 });
    expect(pngSize(Buffer.from("not a png"))).toBeNull();
  });

  it("saves a shot's image and record, with a new ID, the document's step and the image's own size", () => {
    const root = tempRoot();
    const { workspace } = startWithScene(root);
    workspace.requireScene().drawShapes([{ kind: "room", x: 0, z: 0, width: 4, depth: 4 }], "human");
    const shot = workspace.addShot({ camera, caption: "  the  gate\n", image: PNG }, "human");
    expect(shot).toMatchObject({ id: "shot_1", caption: "the gate", createdBy: "human", seq: 1, width: 1, height: 1, camera });
    expect(fs.readFileSync(path.join(shotsDir(root), "shot_1.png")).toString("base64")).toBe(PNG);
    expect(JSON.parse(fs.readFileSync(path.join(shotsDir(root), "shots.json"), "utf8"))).toMatchObject({ nextId: 2, shots: [{ id: "shot_1" }] });
    expect(workspace.shots.list()).toEqual([{ ...shot, url: "/shots/castle/scenes/entrance/shot_1.png" }]);
    expect(workspace.shotImageFile("castle", "scenes", "entrance", "shot_1")).toBe(path.join(shotsDir(root), "shot_1.png"));
  });

  it("refuses what isn't a PNG, and paths that could leave the data folder", () => {
    const { workspace } = startWithScene(tempRoot());
    expect(() => workspace.addShot({ camera, image: Buffer.from("hello").toString("base64") }, "human")).toThrow(/isn't a PNG/);
    workspace.addShot({ camera, image: PNG }, "human");
    expect(workspace.shotImageFile("..", "scenes", "entrance", "shot_1")).toBeNull();
    expect(workspace.shotImageFile("castle", "scenes", "../castle/scenes/entrance", "shot_1")).toBeNull();
    expect(workspace.shotImageFile("castle", "scenes", "entrance", "../shot_1")).toBeNull();
    expect(workspace.shotImageFile("castle", "scenes", "entrance", "shot_9")).toBeNull();
  });

  it("captions, uncaptions and deletes; IDs are never reused", () => {
    const root = tempRoot();
    const { workspace } = startWithScene(root);
    workspace.addShot({ camera, image: PNG }, "human");
    workspace.addShot({ camera, image: PNG }, "agent");
    workspace.shots.update("shot_1", "from the stair");
    expect(workspace.shots.get("shot_1")?.caption).toBe("from the stair");
    workspace.shots.update("shot_1", "  ");
    expect(workspace.shots.get("shot_1")).not.toHaveProperty("caption");
    workspace.shots.remove("shot_2");
    expect(fs.existsSync(path.join(shotsDir(root), "shot_2.png"))).toBe(false);
    expect(workspace.addShot({ camera, image: PNG }, "human").id).toBe("shot_3");
    expect(() => workspace.shots.remove("shot_2")).toThrow(SceneError);
  });

  it("belong to their document, and survive a restart", () => {
    const root = tempRoot();
    const first = startWithScene(root);
    first.workspace.addShot({ camera, caption: "gate", image: PNG }, "human");
    const other = first.workspace.createScene({ project: "castle", name: "Crypt" });
    expect(first.workspace.shots.list()).toEqual([]);
    first.workspace.openScene({ project: "castle", scene: "entrance" });
    expect(first.workspace.shots.list().map((s) => s.caption)).toEqual(["gate"]);
    first.workspace.openEntity("human");
    expect(first.workspace.addShot({ camera, image: PNG }, "human").id).toBe("shot_1");
    expect(first.workspace.shots.list()[0].url).toBe("/shots/castle/entities/human/shot_1.png");
    first.workspace.openScene({ project: "castle", scene: other });
    first.stop();
    const again = start(root);
    again.workspace.openScene({ project: "castle", scene: "entrance" });
    expect(again.workspace.shots.list().map((s) => s.id)).toEqual(["shot_1"]);
  });

  it("a shots.json that doesn't load reads as none and is never written over", () => {
    const root = tempRoot();
    const first = startWithScene(root);
    first.workspace.addShot({ camera, image: PNG }, "human");
    first.stop();
    fs.writeFileSync(path.join(shotsDir(root), "shots.json"), "{ nope");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const again = start(root);
    warn.mockRestore();
    expect(again.workspace.shots.list()).toEqual([]);
    expect(() => again.workspace.addShot({ camera, image: PNG }, "human")).toThrow(/didn't load/);
    expect(fs.readFileSync(path.join(shotsDir(root), "shots.json"), "utf8")).toBe("{ nope");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLAYER } from "../shared/scene.types";
import { openDataDir } from "./persist";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dd-player-"));
  roots.push(root);
  return root;
};
const playerFile = (root: string) => path.join(root, "projects", "castle", "player.json");

describe("the player camera", () => {
  it("is the default until changed, then saved for the project and back after a restart", () => {
    const root = tempRoot();
    const first = start(root);
    first.workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    expect(first.workspace.player()).toEqual(DEFAULT_PLAYER);
    expect(fs.existsSync(playerFile(root))).toBe(false);
    const seen: number[] = [];
    first.workspace.onPlayerChanged((p) => seen.push(p.eyeHeight));
    first.workspace.setPlayer({ ...DEFAULT_PLAYER, eyeHeight: 1.5, third: { ...DEFAULT_PLAYER.third, distance: 2 } });
    expect(seen).toEqual([1.5]);
    // Setting the same again changes nothing.
    first.workspace.setPlayer(first.workspace.player());
    expect(seen).toEqual([1.5]);
    first.stop();
    const again = start(root);
    expect(again.workspace.player()).toMatchObject({ eyeHeight: 1.5, third: { distance: 2 } });
  });

  it("a player.json that doesn't load gives the defaults and is never written over", () => {
    const root = tempRoot();
    const first = start(root);
    first.workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    first.stop();
    fs.writeFileSync(playerFile(root), "{ nope");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const again = start(root);
    warn.mockRestore();
    expect(again.workspace.player()).toEqual(DEFAULT_PLAYER);
    expect(() => again.workspace.setPlayer({ ...DEFAULT_PLAYER, speed: 6 })).toThrow(/didn't load/);
    expect(fs.readFileSync(playerFile(root), "utf8")).toBe("{ nope");
  });

  it("keeps where the human walks in the view, rounded, and drops it when they stop", () => {
    const { workspace } = start(tempRoot());
    workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    const view = { focus: { x: 0, z: 0 }, yaw: 45, bounds: { x: -10, z: -10, width: 20, depth: 20 } };
    workspace.setView({ ...view, walking: { preset: "first", eye: { x: 1.234, y: 1.65, z: -2.345 }, yaw: 90.123, pitch: -5, fov: 90 } }, { focus: { x: 0, z: 0 }, yaw: 45, distance: 30 });
    expect(workspace.store.getScene().view.walking).toEqual({ preset: "first", eye: { x: 1.23, y: 1.65, z: -2.35 }, yaw: 90.12, pitch: -5, fov: 90 });
    workspace.setView(view, { focus: { x: 0, z: 0 }, yaw: 45, distance: 30 });
    expect(workspace.store.getScene().view).not.toHaveProperty("walking");
  });
});

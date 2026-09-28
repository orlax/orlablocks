import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockedError, openDataDir, slugify } from "./persist";

const roots: string[] = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dd-persist-"));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

describe("slugify", () => {
  it("lowercases, drops accents and joins words with dashes", () => {
    expect(slugify("Castle Dungeon!", "project")).toBe("castle-dungeon");
    expect(slugify("  Été / Forêt  ", "project")).toBe("ete-foret");
    expect(slugify("Level 2", "scene")).toBe("level-2");
  });

  it("falls back when nothing is left", () => {
    expect(slugify("???", "scene")).toBe("scene");
    expect(slugify("", "project")).toBe("project");
  });
});

describe("data folder", () => {
  it("creates a project with its scenes folder and the empty semantic folders", () => {
    const root = tempRoot();
    const data = openDataDir(root);
    const id = data.createProject("Castle", "A test");
    expect(id).toBe("castle");
    for (const folder of ["scenes", "entities", "rules"]) {
      expect(fs.statSync(path.join(root, "projects", "castle", folder)).isDirectory()).toBe(true);
    }
    // Skills live in library.json (08.2), so there's no abilities folder.
    expect(fs.existsSync(path.join(root, "projects", "castle", "abilities"))).toBe(false);
    expect(data.readProject("castle")).toMatchObject({ name: "Castle", description: "A test" });
    data.release();
  });

  it("never reuses a folder: a taken slug gets -2, -3", () => {
    const data = openDataDir(tempRoot());
    expect(data.createProject("Castle", "")).toBe("castle");
    expect(data.createProject("castle", "")).toBe("castle-2");
    expect(data.createScene("castle", "Hall")).toBe("hall");
    expect(data.createScene("castle", "Hall")).toBe("hall-2");
    data.release();
  });

  it("lists projects with their scenes, and reports a scene that doesn't load instead of throwing", () => {
    const root = tempRoot();
    const data = openDataDir(root);
    data.createProject("Castle", "");
    data.createScene("castle", "Entrance");
    data.createScene("castle", "Crypt");
    fs.writeFileSync(path.join(root, "projects", "castle", "scenes", "crypt", "scene.json"), "{ nope");
    const [castle] = data.listProjects();
    expect(castle).toMatchObject({ id: "castle", name: "Castle" });
    expect(castle.scenes.map((s) => s.id)).toEqual(["entrance", "crypt"]);
    expect(castle.scenes[0].error).toBeUndefined();
    expect(castle.scenes[1].error).toMatch(/scene\.json/);
    data.release();
  });

  it("writes scene.json atomically, leaving no temp file", () => {
    const root = tempRoot();
    const data = openDataDir(root);
    data.createProject("Castle", "");
    data.createScene("castle", "Entrance");
    const file = data.readScene("castle", "entrance");
    data.writeScene("castle", "entrance", { ...file, seq: 3 });
    expect(data.readScene("castle", "entrance").seq).toBe(3);
    expect(fs.readdirSync(path.join(root, "projects", "castle", "scenes", "entrance"))).toEqual(["scene.json"]);
    data.release();
  });

  it("is locked while a server uses it, and free again after release", () => {
    const root = tempRoot();
    const data = openDataDir(root);
    expect(() => openDataDir(root)).toThrow(LockedError);
    data.release();
    expect(fs.existsSync(path.join(root, ".lock"))).toBe(false);
    openDataDir(root).release();
  });

  it("takes over a lock left by a process that's gone", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, ".lock"), "99999999\n");
    const data = openDataDir(root);
    expect(fs.readFileSync(path.join(root, ".lock"), "utf8").trim()).toBe(String(process.pid));
    data.release();
  });
});

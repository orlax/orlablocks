import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY, findRefs, isBuiltInTag, resolveRef, unknownRefs } from "../shared/library";
import type { OpenScene } from "../shared/scene.types";
import { DEFAULT_GUIDE } from "./defaultGuide";
import { createLibraryStore } from "./library";
import { describeScene, findNodes } from "./outline";
import { openDataDir } from "./persist";
import { createSceneStore, SceneError } from "./scene";
import { createWorkspace } from "./workspace";

/** A library store with #light, #climbable and @telekinesis (tagged #light). */
function stocked() {
  const store = createLibraryStore();
  store.edit(
    {
      upsert: [
        { kind: "tag", name: "light", description: "small enough to lift" },
        { kind: "tag", name: "climbable", description: "the player can climb it" },
        { kind: "skill", name: "telekinesis", description: "moves objects tagged #light", tags: ["light"] },
      ],
    },
    "human",
  );
  return store;
}

describe("references in text", () => {
  it("finds @skills and #tags, but not emails, numbers or headings", () => {
    const refs = findRefs("Use @telekinesis on the #light crates. Mail a@b.com, room #2, ## Goals, (#climbable), @Fish.");
    expect(refs.map((r) => `${r.kind}:${r.name}`)).toEqual(["skill:telekinesis", "tag:light", "tag:climbable", "skill:fish"]);
    const text = "see @telekinesis";
    const [r] = findRefs(text);
    expect(text.slice(r.start, r.end)).toBe("@telekinesis");
  });

  it("leaves a trailing - or _ out of the name", () => {
    expect(findRefs("the #light- crate")[0]).toMatchObject({ name: "light", end: 10 });
  });

  it("lists the references that name nothing", () => {
    const lib = stocked().get();
    expect(unknownRefs(lib, "@telekinesis and @fsh on #light and #clmb and @fsh")).toEqual(["@fsh", "#clmb"]);
  });
});

describe("the library store", () => {
  it("adds tags and skills as one step, sorted, with the skill's tags resolved", () => {
    const store = stocked();
    const lib = store.get();
    expect(lib.tags.map((t) => t.name)).toEqual(["climbable", "light"]);
    expect(lib.skills).toEqual([{ name: "telekinesis", description: "moves objects tagged #light", tags: ["light"] }]);
    expect(store.getHistory().undoLabel).toBe("Edit library");
    store.undo();
    expect(store.get()).toEqual(EMPTY_LIBRARY);
    store.redo();
    expect(store.get().skills).toHaveLength(1);
  });

  it("changes only the fields given, and records nothing for no change", () => {
    const store = stocked();
    store.edit({ upsert: [{ kind: "skill", name: "telekinesis", description: "lifts and throws #light things" }] }, "agent");
    expect(store.get().skills[0]).toEqual({ name: "telekinesis", description: "lifts and throws #light things", tags: ["light"] });
    expect(store.getHistory().undoLabel).toBe("Agent: edit @telekinesis");
    const before = store.getHistory();
    expect(store.edit({ upsert: [{ kind: "tag", name: "light", description: "small enough to lift" }] }, "agent").changed).toEqual([]);
    expect(store.getHistory()).toEqual(before);
  });

  it("renames with an alias, so old references still resolve", () => {
    const store = stocked();
    store.edit({ rename: [{ kind: "tag", from: "light", to: "liftable" }] }, "human");
    const lib = store.get();
    expect(lib.tags.find((t) => t.name === "liftable")).toMatchObject({ aliases: ["light"] });
    expect(resolveRef(lib, "tag", "light")?.name).toBe("liftable");
    expect(store.getHistory().undoLabel).toBe("Rename #light to #liftable");
    // The skill still says "light", and it still resolves.
    expect(lib.skills[0].tags).toEqual(["light"]);
    // A name that's an alias can't be taken or upserted, and renaming back drops the alias.
    expect(() => store.edit({ upsert: [{ kind: "tag", name: "light" }] }, "human")).toThrow(/alias of #liftable/);
    store.edit({ rename: [{ kind: "tag", from: "liftable", to: "light" }] }, "human");
    expect(store.get().tags.find((t) => t.name === "light")).toMatchObject({ aliases: ["liftable"] });
    store.undo();
    store.undo();
    expect(store.get().tags.find((t) => t.name === "light")).not.toHaveProperty("aliases");
  });

  it("refuses bad names, taken names, a skill with no description and a skill's unknown tag, changing nothing", () => {
    const store = stocked();
    const before = store.get();
    expect(() => store.edit({ upsert: [{ kind: "tag", name: "#Light" }] }, "agent")).toThrow(/isn't a name/);
    expect(() => store.edit({ rename: [{ kind: "tag", from: "light", to: "climbable" }] }, "agent")).toThrow(/#climbable is taken/);
    expect(() => store.edit({ upsert: [{ kind: "skill", name: "fish" }] }, "agent")).toThrow(/needs a description/);
    expect(() => store.edit({ upsert: [{ kind: "skill", name: "fish", description: "eats goo", tags: ["goo"] }] }, "agent")).toThrow(/no tag #goo/);
    expect(() => store.edit({ upsert: [{ kind: "tag", name: "goo", tags: ["light"] }] }, "agent")).toThrow(/only a skill has tags/);
    expect(() => store.edit({ remove: [{ kind: "skill", name: "nope" }] }, "agent")).toThrow(SceneError);
    expect(store.get()).toBe(before);
  });

  it("lets a batch add a tag and a skill that uses it, and warns about references to nothing", () => {
    const store = createLibraryStore();
    const { changed, warnings } = store.edit(
      {
        upsert: [
          { kind: "tag", name: "goo" },
          { kind: "skill", name: "fish", description: "a fish that eats #goo; see @water", tags: ["goo"] },
        ],
      },
      "agent",
    );
    expect(changed).toEqual(["#goo", "@fish"]);
    expect(warnings).toEqual(["@water names nothing in the library"]);
  });

  it("removes, and sets the design guide, each undoable", () => {
    const store = stocked();
    store.edit({ remove: [{ kind: "tag", name: "climbable" }] }, "human");
    expect(store.get().tags.map((t) => t.name)).toEqual(["light"]);
    store.edit({ guide: "# My game" }, "human");
    expect(store.getHistory().undoLabel).toBe("Edit design guide");
    expect(store.get().guide).toBe("# My game");
    store.undo();
    expect(store.get().guide).toBe("");
    store.undo();
    expect(store.get().tags).toHaveLength(2);
  });
});

describe("tags on nodes", () => {
  const withLibrary = () => {
    const lib = stocked();
    const scene = createSceneStore({ resolveTag: (name) => resolveRef(lib.get(), "tag", name)?.name });
    return { lib, scene };
  };

  it("are stored by their current names, each once, and must exist", () => {
    const { lib, scene } = withLibrary();
    lib.edit({ rename: [{ kind: "tag", from: "light", to: "liftable" }] }, "human");
    const [crate] = scene.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, tags: ["light", "liftable", "#climbable"] }], "human");
    expect(crate).toMatchObject({ tags: ["liftable", "climbable"] });
    expect(() => scene.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, tags: ["goo"] }], "agent")).toThrow(/no tag #goo in the project library/);
    expect(() => createSceneStore().drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, tags: ["light"] }], "agent")).toThrow(/no tag #light/);
  });

  it("are set and removed with update_nodes, go on groups, carry over a conversion, and not on lines", () => {
    const { scene } = withLibrary();
    const [box, line] = scene.drawShapes(
      [
        { kind: "volume", x: 0, z: 0, width: 1, depth: 1 },
        { type: "line", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] },
      ],
      "human",
    );
    scene.updateNodes([{ id: box.id, tags: ["light"] }], "human");
    expect(scene.getHistory().undoLabel).toBe(`Tag ${box.id}`);
    const group = scene.groupNodes({ ids: [box.id], name: "crates", tags: ["climbable"] }, "human");
    expect(group.tags).toEqual(["climbable"]);
    const [free] = scene.updateNodes([{ id: box.id, type: "freeform" }], "human");
    expect(free).toMatchObject({ type: "freeform", tags: ["light"] });
    scene.updateNodes([{ id: free.id, tags: null }], "human");
    expect(scene.getScene().nodes.find((n) => n.id === free.id)).not.toHaveProperty("tags");
    expect(() => scene.updateNodes([{ id: line.id, tags: ["light"] }], "human")).toThrow(/a line has no tags/);
  });
});

describe("the outline with a library", () => {
  const open: OpenScene = { project: { id: "castle", name: "Castle", description: "" }, scene: { id: "keep", name: "Keep" } };

  it("gives a glossary of just what it shows, one level deep, and current tag names", () => {
    const lib = stocked();
    lib.edit({ upsert: [{ kind: "tag", name: "unused" }, { kind: "skill", name: "fish", description: "eats goo" }] }, "human");
    const scene = createSceneStore({ resolveTag: (name) => resolveRef(lib.get(), "tag", name)?.name });
    const [crate] = scene.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, name: "crate" }], "human");
    const group = scene.groupNodes({ ids: [crate.id], name: "yard", description: "a @telekinesis puzzle" }, "human");
    scene.updateNodes([{ id: crate.id, tags: ["light"] }], "human");
    lib.edit({ rename: [{ kind: "tag", from: "light", to: "liftable" }] }, "human");

    const out = describeScene(open, scene.getScene(), {}, { library: lib.get(), guide: "design guide, 1.0 kB" });
    expect(out.guide).toBe("design guide, 1.0 kB");
    expect(out.glossary).toEqual({
      skills: { telekinesis: { description: "moves objects tagged #light", tags: ["liftable"] } },
      tags: { liftable: "small enough to lift" },
    });
    expect(out.nodes.find((n) => n.id === crate.id)).toMatchObject({ tags: ["liftable"] });
    expect(out.nodes.find((n) => n.id === group.id)).toMatchObject({ description: "a @telekinesis puzzle" });

    // A deleted tag drops out of the outline, but stays stored.
    lib.edit({ remove: [{ kind: "tag", name: "liftable" }] }, "human");
    const after = describeScene(open, scene.getScene(), {}, { library: lib.get() });
    expect(after.nodes.find((n) => n.id === crate.id)).not.toHaveProperty("tags");
    expect(scene.getScene().nodes.find((n) => n.id === crate.id)).toMatchObject({ tags: ["light"] });
  });

  it("finds nodes by tag, through aliases", () => {
    const lib = stocked();
    const scene = createSceneStore({ resolveTag: (name) => resolveRef(lib.get(), "tag", name)?.name });
    scene.drawShapes(
      [
        { kind: "volume", x: 0, z: 0, width: 1, depth: 1, name: "crate", tags: ["light"] },
        { kind: "volume", x: 5, z: 0, width: 1, depth: 1, name: "tree", tags: ["climbable"] },
      ],
      "human",
    );
    lib.edit({ rename: [{ kind: "tag", from: "light", to: "liftable" }] }, "human");
    const found = findNodes(scene.getScene().nodes, { tag: "light" }, lib.get()).found;
    expect(found.map((f) => [f.name, f.tags])).toEqual([["crate", ["liftable"]]]);
    expect(() => findNodes(scene.getScene().nodes, { tag: "goo" }, lib.get())).toThrow(/no tag #goo/);
  });
});

/** A project's tags without the built-in ones. */
const ownTags = (tags: { name: string }[]) => tags.filter((t) => !isBuiltInTag(t.name));

describe("the library in the data folder", () => {
  const roots: string[] = [];
  const releases: (() => void)[] = [];
  afterEach(() => {
    releases.splice(0).forEach((r) => r());
    roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
  });
  const start = (root: string) => {
    const data = openDataDir(root);
    releases.push(data.release);
    const workspace = createWorkspace(data);
    workspace.restore();
    return { workspace, data };
  };
  const tempRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dd-library-"));
    roots.push(root);
    return root;
  };
  const projectDir = (root: string) => path.join(root, "projects", "castle");

  it("gives a new project the default design guide, once", () => {
    const root = tempRoot();
    const { workspace } = start(root);
    workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    expect(workspace.library.get().guide).toBe(DEFAULT_GUIDE);
    expect(fs.readFileSync(path.join(projectDir(root), "rules", "design-guide.md"), "utf8")).toBe(DEFAULT_GUIDE);
    expect(JSON.parse(fs.readFileSync(path.join(projectDir(root), "library.json"), "utf8"))).toMatchObject({ seq: 0, seeded: ["guide", "human"] });

    // Emptied, it stays empty after a restart.
    workspace.editLibrary({ guide: "" }, "human");
    releases.splice(0).forEach((r) => r());
    expect(start(root).workspace.library.get().guide).toBe("");
  });

  it("saves every step and its log, and restores both, history included", () => {
    const root = tempRoot();
    const { workspace } = start(root);
    workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    workspace.editLibrary({ upsert: [{ kind: "tag", name: "light" }] }, "human");
    workspace.editLibrary({ rename: [{ kind: "tag", from: "light", to: "liftable" }] }, "agent");
    workspace.library.undo();
    const log = fs.readFileSync(path.join(projectDir(root), "library-history.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(log.map((l) => l.type)).toEqual(["commit", "commit", "undo"]);
    const saved = JSON.parse(fs.readFileSync(path.join(projectDir(root), "library.json"), "utf8"));
    expect(saved.seq).toBe(3);
    expect(ownTags(saved.tags)).toEqual([{ name: "light" }]);

    releases.splice(0).forEach((r) => r());
    const again = start(root).workspace;
    expect(ownTags(again.library.get().tags)).toEqual([{ name: "light" }]);
    expect(again.library.getHistory()).toMatchObject({ canUndo: true, canRedo: true, redoLabel: "Agent: rename #light to #liftable" });
    again.library.redo();
    expect(ownTags(again.library.get().tags)[0].name).toBe("liftable");
  });

  it("catches up a log one step ahead of library.json", () => {
    const root = tempRoot();
    const { workspace } = start(root);
    workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    workspace.editLibrary({ upsert: [{ kind: "tag", name: "light" }] }, "human");
    // A crash between the log and the state: library.json misses the step.
    const file = path.join(projectDir(root), "library.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), seq: 0, tags: [] }));
    releases.splice(0).forEach((r) => r());
    const again = start(root).workspace;
    expect(ownTags(again.library.get().tags)).toEqual([{ name: "light" }]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ seq: 1 });
  });

  it("gives every project the built-in #no-collisions, which can't be deleted or renamed", () => {
    const root = tempRoot();
    const { workspace } = start(root);
    workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    expect(workspace.library.get().tags.map((t) => t.name)).toContain("no-collisions");
    expect(() => workspace.editLibrary({ remove: [{ kind: "tag", name: "no-collisions" }] }, "human")).toThrow(/built in, so it can't be deleted/);
    expect(() => workspace.editLibrary({ rename: [{ kind: "tag", from: "no-collisions", to: "decor" }] }, "agent")).toThrow(/built in, so it can't be renamed/);
    // Its description can change.
    workspace.editLibrary({ upsert: [{ kind: "tag", name: "no-collisions", description: "grass and far hills" }] }, "human");
    expect(workspace.library.get().tags.find((t) => t.name === "no-collisions")?.description).toBe("grass and far hills");
    // An older project without it gets it when it opens.
    const file = path.join(projectDir(root), "library.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), tags: [] }));
    releases.splice(0).forEach((r) => r());
    expect(start(root).workspace.library.get().tags.map((t) => t.name)).toEqual(["no-collisions"]);
  });

  it("keeps the scene's history and the library's apart, and counts uses across scenes", () => {
    const root = tempRoot();
    const { workspace } = start(root);
    workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    workspace.editLibrary(
      { upsert: [{ kind: "tag", name: "light" }, { kind: "skill", name: "telekinesis", description: "moves #light things", tags: ["light"] }] },
      "human",
    );
    const store = workspace.requireScene();
    const [crate] = store.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, tags: ["light"] }], "human");
    store.groupNodes({ ids: [crate.id], description: "a @telekinesis puzzle" }, "human");
    workspace.createScene({ project: "castle", name: "Tower" });
    workspace.requireScene().drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, tags: ["light"] }], "human");
    expect(workspace.uses()).toEqual({ tags: { light: { nodes: 2, scenes: 2 } }, skills: { telekinesis: { nodes: 1, scenes: 1 } }, entities: {} });
    // Undoing in the scene doesn't touch the library.
    workspace.requireScene().undo();
    expect(workspace.library.get().skills).toHaveLength(1);
    expect(workspace.uses().tags.light).toEqual({ nodes: 1, scenes: 1 });
  });

  it("refuses to open a scene whose project's library doesn't load, and never writes over it", () => {
    const root = tempRoot();
    const { workspace } = start(root);
    workspace.createProject({ name: "Castle", sceneName: "Entrance" });
    workspace.createProject({ name: "Other", sceneName: "One" });
    const file = path.join(projectDir(root), "library.json");
    fs.writeFileSync(file, "{ broken");
    expect(() => workspace.openScene({ project: "castle", scene: "entrance" })).toThrow(/library didn't load/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ broken");
    expect(workspace.getOpen()?.project.id).toBe("other");
  });
});


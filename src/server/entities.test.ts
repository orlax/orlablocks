import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definitionOf, expandInstance, expandNodes, instanceShapes, ownerOf, setDefinitions } from "../shared/entities";
import { boundsOf, mirrorShape, moveShape, rotateShape } from "../shared/geometry";
import { cutters } from "../shared/holes";
import type { Box, Instance, OpenScene, SceneNode } from "../shared/scene.types";
import { countsText } from "../shared/tree";
import { describeScene, findNodes } from "./outline";
import { openDataDir } from "./persist";
import { createSceneStore, SceneError } from "./scene";
import { createWorkspace } from "./workspace";

/** A 2 × 2 × 4 trunk box and a 1 m pillar beside it, around the pivot. */
const TREE: SceneNode[] = [
  { id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 2, depth: 2, height: 4, rotation: 0, color: "brown", createdBy: "human" },
  { id: "box_2", type: "box", kind: "volume", x: 3, z: 0, y: 0, width: 1, depth: 1, height: 1, rotation: 0, color: "green", createdBy: "human" },
];
/** A lying cylinder hole: a round window. */
const WINDOW: SceneNode[] = [
  { id: "cylinder_1", type: "cylinder", kind: "hole", x: 0, z: 0, y: 0, width: 1, depth: 1, height: 1, rotation: 0, pitch: 90, color: "white", createdBy: "human" },
];
const inst = (fields: Partial<Instance> = {}): Instance => ({ id: "instance_1", type: "instance", entity: "tree", x: 10, y: 2, z: 5, rotation: 0, createdBy: "human", ...fields });

beforeEach(() => setDefinitions({ tree: TREE, window: WINDOW }));

describe("expanding an instance", () => {
  it("is a virtual group holding its definition's shapes in world space, with namespaced IDs", () => {
    const [group, trunk, pillar] = expandInstance(inst({ name: "big one", parent: "group_1" }));
    expect(group).toEqual({ id: "instance_1", type: "group", name: "big one", parent: "group_1", createdBy: "human" });
    expect(trunk).toMatchObject({ id: "instance_1/box_1", parent: "instance_1", x: 10, y: 2, z: 5 });
    expect(pillar).toMatchObject({ id: "instance_1/box_2", x: 13, z: 5 });
    expect(ownerOf("instance_1/box_2")).toBe("instance_1");
    expect(ownerOf("box_2")).toBe("box_2");
  });

  it("turns around the pivot, counterclockwise seen from above", () => {
    const [, trunk, pillar] = expandInstance(inst({ rotation: 90 }));
    expect(trunk).toMatchObject({ x: 10, z: 5, rotation: 90 });
    // +x turned 90° counterclockwise seen from above is -z (north).
    expect(pillar).toMatchObject({ x: 10, z: 2, rotation: 90 });
  });

  it("shows a missing entity as a red block", () => {
    const shapes = instanceShapes(inst({ entity: "gone" }));
    expect(shapes).toEqual([expect.objectContaining({ id: "instance_1/missing", type: "box", color: "red", x: 10, z: 5 })]);
  });

  it("gives the instance bounds, and moves, turns and mirrors it as a unit", () => {
    const i = inst();
    expect(boundsOf([i])).toEqual({ minX: 9, maxX: 13.5, minY: 2, maxY: 6, minZ: 4, maxZ: 6 });
    expect(moveShape(i, 1, 0, -1)).toEqual({ x: 11, z: 4 });
    expect(rotateShape(i, { x: 0, z: 0 }, 90)).toEqual({ x: 5, z: -10, rotation: 90 });
    expect(mirrorShape({ ...i, rotation: 30 }, "x", 0)).toEqual({ x: -10, rotation: 150 });
    expect(mirrorShape({ ...i, rotation: 30 }, "z", 0)).toEqual({ z: -5, rotation: 330 });
  });
});

describe("holes and instances", () => {
  it("a window entity placed in a room's group cuts the room's walls", () => {
    const room: Box = { id: "box_9", type: "box", kind: "room", x: 0, z: 0, y: 0, width: 10, depth: 10, height: 3, rotation: 0, parent: "group_1", color: "white", createdBy: "human" };
    const nodes: SceneNode[] = [
      { id: "group_1", type: "group", createdBy: "human" },
      room,
      inst({ id: "instance_2", entity: "window", x: 0, y: 1, z: -5, parent: "group_1" }),
    ];
    const cuts = cutters(expandNodes(nodes));
    expect(cuts.get("box_9")?.map((h) => h.id)).toEqual(["instance_2/cylinder_1"]);
  });

  it("a hole in the scene cuts an instance's shapes, like a sibling group's", () => {
    const nodes: SceneNode[] = [
      { id: "group_1", type: "group", createdBy: "human" },
      { id: "box_9", type: "box", kind: "hole", x: 10, z: 5, y: 3, width: 3, depth: 3, height: 1, rotation: 0, parent: "group_1", color: "white", createdBy: "human" },
      // At the top level, the instance is a sibling group of the hole's group.
      inst(),
    ];
    expect(cutters(expandNodes(nodes)).get("instance_1/box_1")?.map((h) => h.id)).toEqual(["box_9"]);
  });
});

describe("instances in the store", () => {
  it("draws one, refusing an entity that doesn't exist, and counts it", () => {
    const store = createSceneStore();
    const [i] = store.drawShapes([{ type: "instance", entity: "tree", x: 4.123, z: 1, rotation: -90, name: "old oak" }], "agent");
    expect(i).toEqual({ id: "instance_1", type: "instance", entity: "tree", name: "old oak", x: 4.12, y: 0, z: 1, rotation: 270, createdBy: "agent" });
    expect(() => store.drawShapes([{ type: "instance", entity: "nope", x: 0, z: 0 }], "agent")).toThrow(/no entity "nope"/);
    expect(countsText(store.getScene().nodes)).toBe("1 instance");
  });

  it("swaps its entity and takes a place, but refuses fields of its own", () => {
    const store = createSceneStore();
    const [i] = store.drawShapes([{ type: "instance", entity: "tree", x: 0, z: 0 }], "human");
    store.updateNodes([{ id: i.id, entity: "window" }], "agent");
    expect(store.getHistory().undoLabel).toBe(`Agent: swap ${i.id}`);
    store.updateNodes([{ id: i.id, x: 3, rotation: 45 }], "agent");
    expect(store.getScene().nodes[0]).toMatchObject({ entity: "window", x: 3, rotation: 45 });
    expect(() => store.updateNodes([{ id: i.id, height: 3 }], "agent")).toThrow(/is an instance, with no height/);
    expect(() => store.updateNodes([{ id: i.id, entity: "nope" }], "agent")).toThrow(/no entity "nope"/);
    expect(() => store.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, parent: i.id }], "agent")).toThrow(/not a group/);
  });

  it("moves, turns, mirrors and copies with its group", () => {
    const store = createSceneStore();
    const [i, b] = store.drawShapes(
      [
        { type: "instance", entity: "tree", x: 0, z: 0 },
        { kind: "volume", x: 10, z: 0, width: 1, depth: 1 },
      ],
      "human",
    );
    const g = store.groupNodes({ ids: [i.id, b.id] }, "human");
    store.moveNodes({ ids: [g.id], dx: 5 }, "human");
    expect(store.getScene().nodes.find((n) => n.id === i.id)).toMatchObject({ x: 5 });
    store.rotateNodes({ ids: [g.id], degrees: 90, pivot: { x: 5, z: 0 } }, "human");
    expect(store.getScene().nodes.find((n) => n.id === i.id)).toMatchObject({ x: 5, z: 0, rotation: 90 });
    const [copy] = store.duplicateNodes({ ids: [g.id], dz: 20 }, "human");
    const copied = store.getScene().nodes.find((n) => n.type === "instance" && n.parent === copy.id);
    expect(copied).toMatchObject({ id: "instance_2", entity: "tree", z: 20, rotation: 90 });
  });

  it("detaches into a group of world copies with new IDs, as one undoable step", () => {
    const store = createSceneStore({ entityName: (id) => (definitionOf(id) ? `the ${id}` : undefined) });
    const [i] = store.drawShapes([{ type: "instance", entity: "tree", x: 10, y: 2, z: 5 }], "human");
    const [group] = store.detachInstances([i.id], "agent");
    expect(group).toMatchObject({ type: "group", name: "the tree" });
    const inside = store.getScene().nodes.filter((n) => n.parent === group.id);
    expect(inside.map((n) => [n.id, n.type === "box" ? [n.x, n.y, n.z] : null])).toEqual([
      ["box_1", [10, 2, 5]],
      ["box_2", [13, 2, 5]],
    ]);
    expect(store.getScene().nodes.some((n) => n.id === i.id)).toBe(false);
    store.undo();
    expect(store.getScene().nodes.map((n) => n.id)).toEqual([i.id]);
    expect(() => store.detachInstances(["box_99"], "agent")).toThrow(SceneError);
  });

  it("prepares a single group unwrapped, around the bottom center, and refuses notes and instances", () => {
    const store = createSceneStore();
    const [a, b] = store.drawShapes(
      [
        { kind: "volume", x: 10, z: 10, y: 1, width: 2, depth: 2, height: 1 },
        { kind: "volume", x: 14, z: 10, y: 1, width: 2, depth: 2, height: 3 },
      ],
      "human",
    );
    const g = store.groupNodes({ ids: [a.id, b.id], name: "spikes", description: "poison" }, "human");
    const prepared = store.prepareEntity([g.id]);
    expect(prepared.pivot).toEqual({ x: 12, y: 1, z: 10 });
    expect(prepared.nodes.map((n) => [n.id, n.parent, n.type === "box" ? [n.x, n.y, n.z] : null])).toEqual([
      ["box_1", undefined, [-2, 0, 0]],
      ["box_2", undefined, [2, 0, 0]],
    ]);
    expect(prepared.from).toMatchObject({ name: "spikes", description: "poison" });
    expect(prepared.remove.sort()).toEqual([a.id, b.id, g.id].sort());
    store.drawShapes([{ type: "note", x: 0, z: 0, text: "x" }], "human");
    expect(() => store.prepareEntity(["note_1"])).toThrow(/can't hold notes/);
  });
});

describe("instances for the agent", () => {
  const open: OpenScene = { project: { id: "castle", name: "Castle", description: "" }, scene: { id: "keep", name: "Keep" } };

  it("an instance is one line with its bounds, and the glossary says what its entity is", () => {
    const store = createSceneStore();
    store.drawShapes([{ type: "instance", entity: "tree", x: 10, y: 2, z: 5, name: "old oak" }], "human");
    const library = {
      tags: [{ name: "climbable", description: "the player can climb it" }],
      skills: [],
      entities: [{ id: "tree", name: "tree tall", description: "a #climbable tree", tags: ["climbable"] }],
      guide: "",
    };
    const out = describeScene(open, store.getScene(), {}, { library });
    expect(out.nodes[0]).toMatchObject({ id: "instance_1", type: "instance", entity: "tree", bounds: { x: 11.25, z: 5, y: 2, width: 4.5, depth: 2, height: 4 } });
    expect(out.glossary?.entities).toEqual({ tree: { name: "tree tall", description: "a #climbable tree", tags: ["climbable"], size: [4.5, 2, 4] } });
    expect(out.glossary?.tags).toEqual({ climbable: "the player can climb it" });
    const nodes = store.getScene().nodes;
    expect(findNodes(nodes, { tag: "climbable" }, library).found.map((f) => f.id)).toEqual(["instance_1"]);
    expect(findNodes(nodes, { name: "tall" }, library).found.map((f) => f.id)).toEqual(["instance_1"]);
    expect(findNodes(nodes, { entity: "tree" }, library).found[0]).toMatchObject({ entity: "tree", tags: ["climbable"] });
  });
});

describe("entities in the workspace", () => {
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
    return workspace;
  };
  const tempRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dd-entities-"));
    roots.push(root);
    return root;
  };

  it("makes an entity from a group: its folder, its library record, and an instance in its place", () => {
    const root = tempRoot();
    const ws = start(root);
    ws.createProject({ name: "Castle", sceneName: "Keep" });
    ws.editLibrary({ upsert: [{ kind: "tag", name: "hazard" }] }, "human");
    const store = ws.requireScene();
    const [a, b] = store.drawShapes(
      [
        { kind: "volume", x: 10, z: 10, width: 1, depth: 1, height: 1, taper: 1 },
        { kind: "volume", x: 12, z: 10, width: 1, depth: 1, height: 1, taper: 1 },
      ],
      "human",
    );
    const g = store.groupNodes({ ids: [a.id, b.id], name: "Poison", tags: ["hazard"] }, "human");
    const { entity, instance } = ws.makeEntity({ ids: [g.id], description: "goo that hurts; @fish cleans it" }, "agent");
    expect(entity).toEqual({ id: "poison", name: "Poison", description: "goo that hurts; @fish cleans it", tags: ["hazard"] });
    expect(instance).toMatchObject({ type: "instance", entity: "poison", x: 11, y: 0, z: 10, rotation: 0 });
    expect(store.getScene().nodes.map((n) => n.id)).toEqual([instance.id]);
    expect(store.getHistory().undoLabel).toBe("Agent: make entity Poison");
    const file = JSON.parse(fs.readFileSync(path.join(root, "projects", "castle", "entities", "poison", "entity.json"), "utf8"));
    expect(file.nodes.map((n: Box) => [n.id, n.x])).toEqual([
      ["box_1", -1],
      ["box_2", 1],
    ]);
    expect(file.nextId).toMatchObject({ box: 3 });
    // Every project starts with a human (08.5).
    expect(ws.library.get().entities.map((e) => e.id)).toEqual(["human", "poison"]);
    expect(ws.library.get().entities.find((e) => e.id === "poison")).toEqual(entity);
    // Not a library step: the library's undo is the tag.
    expect(ws.library.getHistory().undoLabel).toBe("Add #hazard");

    // Undo puts the shapes back; the entity stays.
    store.undo();
    expect(store.getScene().nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, g.id].sort());
    expect(ws.library.get().entities.map((e) => e.id)).toContain("poison");

    // After a restart the definition is loaded again.
    releases.splice(0).forEach((r) => r());
    setDefinitions({});
    const again = start(root);
    expect(definitionOf("poison")).toHaveLength(2);
    expect(again.library.get().entities.map((e) => e.id)).toEqual(["human", "poison"]);
  });

  it("refuses to delete an entity that's placed, naming the scenes, and deletes it once it isn't", () => {
    const root = tempRoot();
    const ws = start(root);
    ws.createProject({ name: "Castle", sceneName: "Keep" });
    const [a] = ws.requireScene().drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1 }], "human");
    const { instance } = ws.makeEntity({ ids: [a.id], name: "crate" }, "human");
    ws.createScene({ project: "castle", name: "Tower" });
    ws.requireScene().drawShapes([{ type: "instance", entity: "crate", x: 5, z: 5 }], "human");
    expect(ws.uses().entities.crate).toEqual({ nodes: 2, scenes: 2, sceneNames: ["Tower", "Keep"] });
    expect(() => ws.editLibrary({ remove: [{ kind: "entity", name: "crate" }] }, "human")).toThrow(/crate is placed 2 times, in Tower, Keep/);
    ws.requireScene().undo();
    ws.openScene({ project: "castle", scene: "keep" });
    ws.requireScene().removeNodes([instance.id], "human");
    ws.editLibrary({ remove: [{ kind: "entity", name: "crate" }] }, "human");
    expect(ws.library.get().entities.map((e) => e.id)).toEqual(["human"]);
    // Its folder stays, so undoing the delete brings it back whole.
    ws.library.undo();
    expect(ws.library.get().entities.map((e) => e.id)).toEqual(["crate", "human"]);
    expect(definitionOf("crate")).toHaveLength(1);
  });

  it("edits an entity in its own document: its own undo history, saved, every instance following, and back", () => {
    const root = tempRoot();
    const ws = start(root);
    ws.createProject({ name: "Castle", sceneName: "Keep" });
    const scene = ws.requireScene();
    const [a] = scene.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, height: 2 }], "human");
    const { instance } = ws.makeEntity({ ids: [a.id], name: "pillar" }, "human");
    scene.drawShapes([{ type: "instance", entity: "pillar", x: 10, z: 0 }], "human");
    const sceneUndo = scene.getHistory().undoLabel;

    ws.openEntity("pillar");
    expect(ws.getOpen()).toMatchObject({ scene: { id: "keep" }, entity: { id: "pillar", name: "pillar" } });
    expect(ws.getRestore()?.camera).toMatchObject({ focus: { x: 0, z: 0 } });
    const store = ws.requireScene();
    expect(store.getScene().nodes.map((n) => n.id)).toEqual(["box_1"]);
    expect(store.getHistory().canUndo).toBe(false);
    // Taller: every instance follows.
    store.updateNodes([{ id: "box_1", height: 5 }], "agent");
    expect(boundsOf([{ ...instance, x: 0 }]).maxY).toBe(5);
    expect(definitionOf("pillar")?.[0]).toMatchObject({ height: 5 });
    expect(JSON.parse(fs.readFileSync(path.join(root, "projects", "castle", "entities", "pillar", "entity.json"), "utf8")).nodes[0].height).toBe(5);
    expect(fs.readFileSync(path.join(root, "projects", "castle", "entities", "pillar", "history.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    // Notes and instances can't go in; top-level holes can.
    expect(() => store.drawShapes([{ type: "note", x: 0, z: 0, text: "x" }], "agent")).toThrow(/can't hold notes/);
    expect(() => store.drawShapes([{ type: "instance", entity: "human", x: 0, z: 0 }], "agent")).toThrow(/no nested entities/);
    expect(() => ws.makeEntity({ ids: ["box_1"] }, "agent")).toThrow(/editing an entity/);
    expect(() => ws.editLibrary({ remove: [{ kind: "entity", name: "pillar" }] }, "human")).toThrow(/open for editing/);
    // The uses count the scene from disk.
    expect(ws.uses().entities.pillar).toMatchObject({ nodes: 2, sceneNames: ["Keep"] });

    ws.closeEntity();
    expect(ws.getOpen()).not.toHaveProperty("entity");
    expect(ws.requireScene().getScene().nodes.map((n) => n.type)).toEqual(["instance", "instance"]);
    expect(ws.requireScene().getHistory().undoLabel).toBe(sceneUndo);

    // After a restart the entity's own history is still there.
    releases.splice(0).forEach((r) => r());
    setDefinitions({});
    const again = start(root);
    again.openEntity("pillar");
    expect(again.requireScene().getHistory()).toMatchObject({ canUndo: true, undoLabel: "Agent: change height of box_1" });
    again.requireScene().undo();
    expect(definitionOf("pillar")?.[0]).toMatchObject({ height: 2 });
  });

  it("gives every project a human, once, 1.8 m tall", () => {
    const root = tempRoot();
    const ws = start(root);
    ws.createProject({ name: "Castle", sceneName: "Keep" });
    expect(ws.library.get().entities).toEqual([expect.objectContaining({ id: "human", name: "human" })]);
    const shapes = (definitionOf("human") ?? []).filter((n) => n.type !== "group") as Box[];
    expect(boundsOf(shapes)).toMatchObject({ minY: 0, maxY: 1.8 });
    // Deleted, it stays deleted after a restart.
    ws.editLibrary({ remove: [{ kind: "entity", name: "human" }] }, "human");
    releases.splice(0).forEach((r) => r());
    expect(start(root).library.get().entities).toEqual([]);
  });
});

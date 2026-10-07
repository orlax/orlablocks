import { describeScene, findNodes } from "./outline";
import { compactNodes } from "./results";
import { describe, expect, it } from "vitest";
import { createSceneStore } from "./scene";
import { buildExport } from "./export";
import { EMPTY_LIBRARY } from "../shared/library";
import { SceneFileSchema } from "../shared/project.types";
import { evaluateTerrain, terrainProblems, terrainSources } from "../shared/terrain";
import type { Terrain } from "../shared/scene.types";

const fixture = () => {
  const store = createSceneStore();
  store.drawShapes([
    { type: "group", ref: "sources" },
    { type: "terrain", source: "$sources", x: 10, z: 7, width: 32, depth: 16, y: -2, resolution: 129 },
  ], "human");
  return store;
};

describe("terrain scene and export", () => {
  it("keeps its empty source group and roundtrips persistence and undo", () => {
    const store = fixture();
    expect(store.getScene().nodes).toHaveLength(2);
    store.updateNodes([{ id: "terrain_1", y: -4 }], "human");
    store.undo(); expect((store.getScene().nodes[1] as Terrain).y).toBe(-2);
    store.redo(); expect((store.getScene().nodes[1] as Terrain).y).toBe(-4);
    const saved = SceneFileSchema.parse({ name: "test", createdAt: "now", seq: 1, nodes: store.getScene().nodes, nextId: store.getNextId() });
    const restored = createSceneStore(); restored.load(saved);
    expect(restored.getScene().nodes).toEqual(store.getScene().nodes);
  });
  it("rejects unsupported inputs atomically and releases a deleted source", () => {
    const store = fixture(); const before = store.getNextId();
    expect(() => store.drawShapes([{ type: "box", kind: "room", parent: "group_1", x: 0, z: 0, width: 2, depth: 2 }], "agent")).toThrow("sources");
    expect(store.getNextId()).toEqual(before);
    store.removeNodes(["group_1"], "human");
    expect(store.getScene().nodes[0]).not.toHaveProperty("source");
    store.undo(); expect(store.getScene().nodes).toHaveLength(2);
  });
  it("exports a native terrain with reversed z rows, negative origin and no source meshes", () => {
    const store = fixture();
    store.drawShapes([
      { type: "box", kind: "volume", parent: "group_1", x: 5, z: 3, y: -1, width: 8, depth: 6, height: 4 },
      { type: "cylinder", kind: "volume", parent: "group_1", x: 16, z: 11, y: 0, width: 7, depth: 5, height: 7, bevel: 0.6 },
      { type: "box", kind: "volume", x: 50, z: 0, width: 2, depth: 2 },
    ], "human");
    const nodes = store.getScene().nodes;
    const t = nodes.find((n): n is Terrain => n.type === "terrain")!;
    const built = buildExport({ nodes, project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "S" }, seq: 1, library: EMPTY_LIBRARY });
    const r = built.manifest.nodes.find((n) => n.type === "terrain")!;
    expect(built.manifest.version).toBe(2);
    expect(built.manifest.nodes.map((n) => n.id)).toEqual(["terrain_1", "box_2"]);
    expect(r.position).toEqual([-6, -2, -15]);
    expect(r.collider).toBe("terrain");
    const field = evaluateTerrain(t, nodes);
    for (let z = 0; z < 129; z++) for (let x = 0; x < 129; x++) {
      const h = built.binary.readFloatLE(r.terrain.offset + (z * 129 + x) * 4);
      const i = (128 - z) * 129 + x;
      expect(h * r.terrain.size[1] + r.position[1]).toBeCloseTo(field.heights[i], 5);
      expect(field.mesh.positions[i * 3 + 1]).toBe(field.heights[i]);
    }
  });
});

describe("terrain editing", () => {
  const made = () => {
    const store = createSceneStore();
    store.drawShapes([
      { type: "box", kind: "volume", x: 0, z: 0, width: 8, depth: 8, height: 4, terrain: { operation: "raise", fade: 2 } },
      { type: "ramp", points: [{ x: 6, y: 2, z: 0 }, { x: 12, y: 5, z: 0 }], width: 2, terrain: { operation: "set", fade: 3 } },
    ], "human");
    const terrain = store.makeTerrain({ ids: ["box_1", "ramp_1"] }, "human");
    return { store, terrain };
  };
  it("Make terrain covers input fades, preserves geometry and undoes in one step", () => {
    const { store, terrain } = made();
    expect(terrain.x - terrain.width / 2).toBe(-6);
    expect(terrain.x + terrain.width / 2).toBe(15);
    expect(terrain.depth).toBe(12);
    const nodes = store.getScene().nodes;
    expect(nodes.find((n) => n.id === "box_1")).toMatchObject({ x: 0, z: 0, height: 4, parent: terrain.source });
    expect(nodes.find((n) => n.id === "ramp_1")).toHaveProperty("terrain.fade", 3);
    store.undo(); expect(store.getScene().nodes).toHaveLength(2);
    store.redo(); expect(store.getScene().nodes).toHaveLength(5);
    expect(() => store.makeTerrain({ ids: ["box_1"] }, "human")).toThrow("already belong");
  });
  it("copies a bare terrain, an assembly and multiple roots with independent sources", () => {
    const { store, terrain } = made();
    const copy = store.duplicateNodes({ ids: [terrain.id], dx: 30 }, "human")[0] as Terrain;
    expect(copy.source).not.toBe(terrain.source);
    expect(store.getScene().nodes.find((n) => n.id === copy.source)?.parent).toBe(terrain.parent);
    expect(evaluateTerrain(copy, store.getScene().nodes).max).toBeCloseTo(evaluateTerrain(terrain, store.getScene().nodes).max);
    store.updateNodes([{ id: "box_1", height: 8 }], "human");
    expect(evaluateTerrain(copy, store.getScene().nodes).max).toBeLessThan(8);
    const transformed = store.transformNodes({ ids: [terrain.id], copy: true, move: { dx: -30 }, scale: 2 }, "agent");
    const copied = transformed.shapes.find((n): n is Terrain => n.type === "terrain")!;
    expect(copied.source).toBe(transformed.copies![terrain.source!]);
    expect(store.getScene().nodes.find((n) => n.id === transformed.copies!.ramp_1)).toHaveProperty("terrain.fade", 6);
    const assembly = store.duplicateNodes({ ids: [terrain.parent!] }, "human")[0];
    expect(terrainProblemsFor(store)).toEqual([]);
    expect(assembly.type).toBe("group");
    store.duplicateNodes({ ids: [terrain.id, terrain.source!] }, "human");
    expect(terrainProblemsFor(store)).toEqual([]);
  });
  it("rejects rotation, tilt and invalid source edits without partial changes", () => {
    const { store, terrain } = made();
    const before = structuredClone(store.getScene().nodes);
    expect(() => store.transformNodes({ ids: [terrain.parent!], rotate: 30, move: { dx: 5 } }, "human")).toThrow("Nothing was transformed");
    expect(() => store.rotateNodes({ ids: [terrain.parent!], degrees: 10, axis: "x" }, "human")).toThrow("Nothing was rotated");
    expect(() => store.updateNodes([{ id: "box_1", height: 7 }, { id: "ramp_1", step: 0.2 }], "human")).toThrow("smooth ramps");
    expect(() => store.rotateNodes({ ids: ["ramp_1"], degrees: 10, axis: "x" }, "human")).toThrow("cannot tilt");
    expect(store.getScene().nodes).toEqual(before);
    store.transformNodes({ ids: [terrain.parent!], scale: 2, mirror: "x", move: { dx: 5, dy: 1 } }, "human");
    expect(store.getScene().nodes.find((n) => n.id === terrain.id)).toMatchObject({ width: terrain.width * 2, depth: terrain.depth * 2, resolution: 129 });
    expect(store.getScene().nodes.find((n) => n.id === "box_1")).toHaveProperty("terrain.fade", 4);
    store.undo(); expect(store.getScene().nodes).toEqual(before);
  });
  it("preserves source settings on conversion, nested ungroup order, and source release on undo", () => {
    const { store, terrain } = made();
    const converted = store.convertNodes({ ids: ["box_1"] }, "human")[0];
    expect(converted.terrain).toEqual({ operation: "raise", fade: 2 });
    const nested = store.groupNodes({ ids: [converted.id] }, "human");
    // Move a later source before the nested group; dissolving keeps the fully expanded order.
    store.placeNodes({ ids: ["ramp_1"], parent: terrain.source!, before: nested.id }, "human");
    const order = terrainSourcesFor(store, terrain).map((n) => n.id);
    store.ungroup({ ids: [nested.id] }, "human");
    expect(terrainSourcesFor(store, terrain).map((n) => n.id)).toEqual(order);
    store.ungroup({ ids: [terrain.source!] }, "human");
    expect(store.getScene().nodes.find((n) => n.id === terrain.id)).not.toHaveProperty("source");
    store.undo(); expect(store.getScene().nodes.find((n) => n.id === terrain.id)).toHaveProperty("source", terrain.source);
    store.removeNodes([terrain.id], "human");
    expect(store.getScene().nodes.some((n) => n.id === converted.id)).toBe(true);
    store.undo(); expect(store.getScene().nodes.some((n) => n.id === terrain.id)).toBe(true);
  });
});

const terrainProblemsFor = (store: ReturnType<typeof createSceneStore>) => terrainProblems(store.getScene().nodes);
const terrainSourcesFor = (store: ReturnType<typeof createSceneStore>, t: Terrain) => terrainSources(t, store.getScene().nodes);

it("Make terrain retains expanded order when selected sources originally have different parents", () => {
  const store = createSceneStore();
  store.drawShapes([
    { type: "group", ref: "a" }, { type: "group", ref: "b" },
    { type: "box", kind: "volume", parent: "$b", x: 0, z: 0, width: 4, depth: 4, height: 2, terrain: { operation: "set", fade: 0 } },
    { type: "box", kind: "volume", parent: "$a", x: 0, z: 0, width: 4, depth: 4, height: 7 },
  ], "human");
  const before = structuredClone(store.getScene().nodes);
  const t = store.makeTerrain({ ids: ["box_1", "box_2"] }, "human");
  expect(terrainSourcesFor(store, t).map((n) => n.id)).toEqual(["box_2", "box_1"]);
  expect(evaluateTerrain(t, store.getScene().nodes).max).toBe(2);
  store.undo(); expect(store.getScene().nodes).toEqual(before);
});

it("describes generated bounds and lean terrain metadata consistently across reads and edits", () => {
  const store = fixture();
  store.drawShapes([{ type: "box", kind: "volume", parent: "group_1", x: 10, z: 7, y: -5, width: 8, depth: 8, height: 2, terrain: { operation: "lower", fade: 2 } }], "human");
  const nodes = store.getScene().nodes;
  const open = { project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "S" } };
  const read = describeScene(open, store.getScene()).nodes.find((n) => n.type === "terrain")!;
  const compact = compactNodes(nodes, ["terrain_1"])[0];
  const found = findNodes(nodes, { type: "terrain" }).found[0];
  for (const result of [read, compact, found]) {
    expect(result).toMatchObject({ source: "group_1", resolution: 129, cellSpacing: { x: 0.25, z: 0.125 }, elevation: [-3, -2], bounds: { y: -3, height: 1 } });
    expect(result).not.toHaveProperty("heights");
  }
  expect(findNodes(nodes, { type: "box" }).found[0]).toMatchObject({ terrainFor: "terrain_1", modifierOrder: 1 });
});

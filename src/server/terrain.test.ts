import { describe, expect, it } from "vitest";
import { createSceneStore } from "./scene";
import { buildExport } from "./export";
import { EMPTY_LIBRARY } from "../shared/library";
import { SceneFileSchema } from "../shared/project.types";
import { evaluateTerrain } from "../shared/terrain";
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
    for (let z = 0; z < 129; z += 8) for (let x = 0; x < 129; x += 8) {
      const h = built.binary.readFloatLE(r.terrain.offset + (z * 129 + x) * 4);
      expect(h * r.terrain.size[1] + r.position[1]).toBeCloseTo(field.heights[(128 - z) * 129 + x], 5);
    }
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setDefinitions, instanceShapes } from "../shared/entities";
import { EMPTY_LIBRARY } from "../shared/library";
import { NodeSchema, ShapeInputSchema, type Instance, type SceneNode, type WallAttachment } from "../shared/scene.types";
import { polarPose, wallPose, wallSupportProblem } from "../shared/wallAttachment";
import { buildExport } from "./export";
import { loadManifold } from "./manifold";
import { lintScene } from "./lint";
import { createSceneStore } from "./scene";

const frame = { id: "box_1", type: "box", kind: "volume", x: 0, y: 0, z: 0, width: 0.1, depth: 1, height: 1, rotation: 0, color: "gray", createdBy: "human" } as const;
const mount = (id: string, patch: Partial<WallAttachment> = {}): WallAttachment => ({ id, side: "inner", angle: 0, elevation: 3, offset: 0, facingOffset: 0, ...patch });
beforeAll(() => loadManifold());
beforeEach(() => setDefinitions({ frame: [frame] }));
function fixture() {
  const store = createSceneStore();
  const [tower, art] = store.drawShapes([
    { type: "group", ref: "building" },
    { type: "cylinder", ref: "tower", parent: "$building", kind: "room", x: 0, z: 0, y: 2, width: 10, depth: 10, height: 10, wall: 0.4 },
    { type: "instance", entity: "frame", parent: "$building", wallAttachment: mount("$tower") },
  ], "agent").slice(1);
  const node = () => store.getScene().nodes.find((n) => n.id === art.id) as Instance;
  return { store, tower, art, node };
}
const snapshot = (store: ReturnType<typeof createSceneStore>) => structuredClone(store.getScene().nodes);

describe("19.7 scene relative placement and wall mounts", () => {
  it("places nine frames in a single ref batch with local +x facing the inner normal", () => {
    const store = createSceneStore();
    const nodes = store.drawShapes([
      { type: "cylinder", ref: "tower", kind: "room", x: 10, z: -4, y: 2, rotation: 15, width: 20, depth: 20, height: 12, wall: 0.5 },
      ...Array.from({ length: 9 }, (_, i) => ({ type: "instance" as const, entity: "frame", wallAttachment: mount("$tower", { angle: i * 40 }) })),
    ], "agent");
    expect(nodes).toHaveLength(10);
    for (const n of nodes.slice(1) as Instance[]) {
      const a = n.wallAttachment!;
      const theta = (a.angle + 15) * Math.PI / 180;
      expect(n.x).toBeCloseTo(10 + 9.5 * Math.cos(theta), 1);
      expect(n.z).toBeCloseTo(-4 - 9.5 * Math.sin(theta), 1);
      expect(n.rotation).toBe((a.angle + 195) % 360);
      expect(wallSupportProblem(nodes, n)).toBeNull();
    }
    store.undo(); expect(store.getScene().nodes).toHaveLength(0);
    store.redo(); expect(store.getScene().nodes).toEqual(nodes);
  });
  it("resolves polar once, with facing offsets and without a stored dependency", () => {
    const { store, tower } = fixture();
    for (const [facing, rotation] of [["out", 100], ["in", 280], ["tangent", 190]] as const) {
      const [n] = store.drawShapes([{ type: "instance", entity: "frame", polar: { around: tower.id, radius: 4, angle: 90, elevation: 4, facing, rotationOffset: 10 } }], "agent");
      expect(n).toMatchObject({ x: 0, y: 6, z: -4, rotation });
      expect(n).not.toHaveProperty("polar");
      store.updateNodes([{ id: tower.id, x: 5 }], "agent");
      expect(store.getScene().nodes.find((m) => m.id === n.id)).toEqual(n);
      store.undo();
      store.updateNodes([{ id: n.id, polar: { around: tower.id, radius: 3, angle: 180, facing: "in" } }], "agent");
      expect(store.getScene().nodes.find((m) => m.id === n.id)).toMatchObject({ x: -3, y: 2, z: 0, rotation: 0 });
    }
  });
  it("supports one-shot polar boxes/cylinders with ordinary stored world geometry", () => {
    const { store, tower } = fixture();
    for (const type of ["box", "cylinder"] as const) {
      const [n] = store.drawShapes([{ type, width: 1, depth: 1, polar: { around: tower.id, radius: 3, angle: 90, elevation: 1, facing: "tangent" } }], "agent");
      expect(n).toMatchObject({ x: 0, y: 3, z: -3, rotation: 180 });
      expect(n).not.toHaveProperty("polar");
      store.updateNodes([{ id: n.id, polar: { around: tower.id, radius: 2, angle: 180 } }], "human");
      expect(store.getScene().nodes.find((m) => m.id === n.id)).toMatchObject({ x: -2, y: 2, z: 0, rotation: 180 });
    }
    expect(ShapeInputSchema.safeParse({ width: 1, depth: 1 }).success).toBe(false);
    expect(ShapeInputSchema.safeParse({ width: 1, depth: 1, x: 0, polar: { around: tower.id, radius: 2, angle: 0 } }).success).toBe(false);
  });
  it("resolves polar updates around the final support pose in the same batch", () => {
    const { store, tower, art, node } = fixture();
    store.updateNodes([{ id: art.id, wallAttachment: null, polar: { around: tower.id, radius: 3, angle: 0 } }, { id: tower.id, x: 10, rotation: 90 }], "agent");
    expect(node()).toMatchObject({ x: 10, z: -3, y: 2, rotation: 90 });
    expect(node().wallAttachment).toBeUndefined();
    store.updateNodes([{ id: tower.id, width: 12 }], "human");
    store.updateNodes([{ id: art.id, polar: { around: tower.id, radius: 2, angle: 0 } }, { id: tower.id, depth: 12 }], "agent");
    expect(node()).toMatchObject({ x: 10, z: -2, rotation: 90 });
  });
  it("refreshes translation, yaw, radius, wall thickness and elevation in one step and reloads", () => {
    const { store, tower, node } = fixture();
    const before = snapshot(store);
    store.updateNodes([{ id: tower.id, x: 4, y: 1, z: 2, rotation: 90, width: 20, depth: 20, wall: 1 }], "agent");
    expect(node()).toMatchObject({ x: 4, y: 4, z: -7, rotation: 270 });
    const after = snapshot(store);
    expect(NodeSchema.parse(JSON.parse(JSON.stringify(node())))).toEqual(node());
    store.undo(); expect(store.getScene().nodes).toEqual(before);
    store.redo(); expect(store.getScene().nodes).toEqual(after);
    const reloaded = createSceneStore();
    reloaded.load({ nodes: after, nextId: store.getNextId() });
    reloaded.updateNodes([{ id: tower.id, wall: 2 }], "human");
    expect(reloaded.getScene().nodes.find((n) => n.id === node().id)).toMatchObject({ z: -6 });
  });
  it("keeps broken support links and last poses; lint reports them and repair resumes following", () => {
    const { store, tower, art, node } = fixture();
    const before = structuredClone(node());
    store.removeNodes([tower.id], "human");
    expect(node()).toEqual(before);
    expect(lintScene(store.getScene().nodes).findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: art.id, check: "attachments", message: expect.stringContaining("missing") })]));
    store.undo(); expect(node()).toEqual(before);
    store.updateNodes([{ id: tower.id, arc: { from: 90, sweep: 100 } }], "agent");
    expect(node()).toEqual(before);
    expect(wallSupportProblem(store.getScene().nodes, node())).toMatch(/arc/);
    store.updateNodes([{ id: art.id, wallAttachment: mount(tower.id, { angle: 120 }) }], "agent");
    expect(wallSupportProblem(store.getScene().nodes, node())).toBeNull();
    const pose = structuredClone(node());
    store.updateNodes([{ id: art.id, wallAttachment: null }], "human");
    expect(node()).toMatchObject({ x: pose.x, y: pose.y, z: pose.z, rotation: pose.rotation });
    expect(node()).not.toHaveProperty("wallAttachment");
  });
  it("updates mount parameters on direct move/rotate and rejects unrepresentable edits atomically", () => {
    const { store, art, node } = fixture();
    store.moveNodes({ ids: [art.id], dx: -4.6, dz: -4.6, dy: 1 }, "human");
    expect(node()).toMatchObject({ x: 0, y: 6, z: -4.6, wallAttachment: { angle: 90, elevation: 4, offset: 0, facingOffset: 270 } });
    store.updateNodes([{ id: art.id, rotation: 30 }], "agent");
    expect(node().wallAttachment?.facingOffset).toBe(120);
    const before = snapshot(store);
    for (const changes of [[{ id: art.id, pitch: 15 }], [{ id: art.id, y: 100 }], [{ id: art.id, x: 0, z: 0 }]]) {
      expect(() => store.updateNodes(changes, "human")).toThrow(/detach|elevation|center/);
      expect(store.getScene().nodes).toEqual(before);
    }
    expect(() => store.rotateNodes({ ids: [art.id], axis: "x", degrees: 45 }, "human")).toThrow(/detach/);
    expect(store.getScene().nodes).toEqual(before);
  });
  it("rejects invalid draw inputs, refs, cycles and update conflicts without partial mutations", () => {
    const { store, art, tower } = fixture();
    const before = snapshot(store);
    const invalid = [
      { type: "instance", entity: "frame", polar: { around: tower.id, radius: 2, angle: 0 }, x: 1 },
      { type: "instance", entity: "frame", wallAttachment: mount("$later") },
      { type: "instance", entity: "frame", wallAttachment: mount(art.id) },
      { type: "instance", entity: "frame" },
    ];
    for (const input of invalid) {
      expect(() => store.drawShapes([input as never], "agent")).toThrow();
      expect(store.getScene().nodes).toEqual(before);
    }
    for (const input of [{ id: art.id, polar: { around: tower.id, radius: 3, angle: 0 } }, { id: tower.id, wallAttachment: mount(tower.id) }, { id: art.id, wallAttachment: mount(tower.id), y: 4 }]) {
      expect(() => store.updateNodes([{ id: tower.id, name: "must rollback" }, input], "agent")).toThrow();
      expect(store.getScene().nodes).toEqual(before);
    }
    expect(ShapeInputSchema.safeParse({ type: "instance", entity: "frame" }).success).toBe(false);
  });
  it("remaps assembly copies and cross-scene pastes; standalone copies detach at the copied world pose", () => {
    const { store, art, tower } = fixture();
    store.duplicateNodes({ ids: ["group_1"], dx: 20 }, "agent");
    const copy = store.getScene().nodes.find((n) => n.type === "instance" && n.id !== art.id) as Instance;
    expect(copy.wallAttachment?.id).not.toBe(tower.id);
    expect(copy.x).toBe(24.6);
    store.duplicateNodes({ ids: [art.id], dx: 2 }, "agent");
    expect(store.getScene().nodes.find((n) => n.type === "instance" && n.id !== art.id && n.id !== copy.id)).toMatchObject({ x: 6.6 });
    const detached = store.getScene().nodes.find((n) => n.type === "instance" && n.id !== art.id && n.id !== copy.id) as Instance;
    expect(detached.wallAttachment).toBeUndefined();
    const paste = createSceneStore();
    paste.pasteNodes({ parent: null, nodes: snapshot(store).filter((n) => ["group_1", tower.id, art.id].includes(n.id)), focus: { x: 30, z: 20 } }, "human");
    const pasted = paste.getScene().nodes.find((n) => n.type === "instance") as Instance;
    expect(wallSupportProblem(paste.getScene().nodes, pasted)).toBeNull();
    const solo = createSceneStore();
    solo.pasteNodes({ parent: null, nodes: [structuredClone(pasted)], focus: { x: 0, z: 0 } }, "human");
    expect((solo.getScene().nodes[0] as Instance).wallAttachment).toBeUndefined();
  });
  it("preserves transformed assembly mounts including scaled/mirrored copies", () => {
    const { store, node } = fixture();
    store.transformNodes({ ids: ["group_1"], scale: 2, rotate: 30, move: { dx: 3, dy: 1, dz: 4 }, copy: true }, "agent");
    for (const n of store.getScene().nodes) if (n.type === "instance") expect(wallSupportProblem(store.getScene().nodes, n)).toBeNull();
    store.mirrorNodes({ ids: ["group_1"], axis: "x" }, "human");
    expect(wallSupportProblem(store.getScene().nodes, node())).toBeNull();
  });
  it("only suppresses floating for supported mounts; floor on behavior stays unchanged", () => {
    const { store, art, tower, node } = fixture();
    expect(lintScene(store.getScene().nodes).findings.filter((f) => f.id === art.id)).toEqual([]);
    expect(() => store.updateNodes([{ id: art.id, on: { id: tower.id } }], "agent")).toThrow(/detach/);
    store.updateNodes([{ id: art.id, wallAttachment: mount(tower.id, { offset: 1 }) }], "agent");
    expect(lintScene(store.getScene().nodes).findings.filter((f) => f.id === art.id).map((f) => f.check)).toEqual(expect.arrayContaining(["attachments", "floating"]));
    store.updateNodes([{ id: art.id, wallAttachment: null, on: { id: tower.id } }], "human");
    expect(node().on?.id).toBe(tower.id);
    expect(node().y).toBe(2);
    store.updateNodes([{ id: art.id, on: null, wallAttachment: mount(tower.id) }], "human");
    expect(node().on).toBeUndefined();
    expect(node().y).toBe(5);
    expect(() => store.makeArray(art.id, "human")).toThrow(/Detach/);
  });
  it("validates arc wrap, full walls, vertical limits and signed inner/outer offsets", () => {
    const { store, tower } = fixture();
    store.updateNodes([{ id: tower.id, arc: { from: 300, sweep: 101 }, rotation: 45 }], "agent");
    const nodes = store.getScene().nodes;
    expect(wallPose(nodes, mount(tower.id, { angle: 20 }))).not.toHaveProperty("problem");
    expect(wallPose(nodes, mount(tower.id, { angle: 42 }))).toHaveProperty("problem");
    expect(wallPose(nodes, mount(tower.id, { angle: -60, side: "outer", offset: 0.2 }))).toEqual(polarPose(nodes, { around: tower.id, radius: 5.2, angle: -60, elevation: 3, facing: "out" }));
    for (const change of [{ sides: 8 }, { width: 12 }, { kind: "volume" as const }, { wall: 6 }]) {
      // Clear arc to allow the deliberately unsupported target state.
      store.updateNodes([{ id: tower.id, arc: null, ...change }], "agent");
      expect(wallPose(store.getScene().nodes, mount(tower.id))).toHaveProperty("problem");
      store.undo();
    }
  });
  it("reports an opening removing the mounting surface, respecting hidden cutters", () => {
    const { store, tower, art, node } = fixture();
    store.updateNodes([{ id: tower.id, cutTags: ["wall"] }], "agent");
    const [hole] = store.drawShapes([{ kind: "hole", x: 4.6, z: 0, y: 4, width: 3, depth: 3, height: 3, cutTags: ["wall"] }], "agent");
    expect(wallSupportProblem(store.getScene().nodes, node())).toMatch(/surface|cut/);
    expect(lintScene(store.getScene().nodes, { checks: ["attachments"] }).findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: art.id })]));
    const last = structuredClone(node());
    store.updateNodes([{ id: tower.id, x: 0.1 }], "human");
    expect(node()).toEqual(last);
    store.updateNodes([{ id: hole.id, hidden: true }], "human");
    expect(node().x).toBeCloseTo(last.x + 0.1, 2);
    expect(wallSupportProblem(store.getScene().nodes, node())).toBeNull();
  });
  it("exports the same resolved instance poses used by editor expansion", () => {
    const { store, tower, node } = fixture();
    store.updateNodes([{ id: tower.id, rotation: 35, x: -2, wall: 0.7 }], "agent");
    const n = node();
    const { manifest } = buildExport({ project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "S" }, seq: 1, nodes: store.getScene().nodes, library: EMPTY_LIBRARY });
    expect(instanceShapes(n)).toHaveLength(1);
    const json = JSON.stringify(manifest);
    expect(json).toContain(n.id);
    // Ordinary export frames are resolved world poses, shared with Unity/GLB.
    const record = manifest.nodes.find((r) => r.id === n.id)!;
    expect(record.position).toEqual([n.x, n.y, -n.z]);
    expect(record.euler[1]).toBe(-n.rotation);
  });
});

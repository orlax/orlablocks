import { afterEach, describe, expect, it } from "vitest";
import { expandNodes, setDefinitions } from "../shared/entities";
import { cutters, holeScope, isHole } from "../shared/holes";
import { NodeSchema, type Box, type SceneNode } from "../shared/scene.types";
import { createSceneStore } from "./scene";
const part = (id: string, kind: Box["kind"]): Box => ({ id, type: "box", kind, cutTags: ["internal"], x: 0, y: 0, z: 0, width: 2, depth: 2, height: 2, rotation: 0, color: "white", createdBy: "human" });
const defs = { door: [part("solid", "volume"), part("hole", "hole")] };
const store = () => { setDefinitions(defs); return createSceneStore({ entityName: (id) => id === "door" ? "Door" : undefined }); };
const targets = (nodes: SceneNode[]) => {
  const expanded = expandNodes(nodes);
  return expanded.filter(isHole).map((h) => [h.id, holeScope(expanded, h).map((s) => s.id)]);
};
afterEach(() => setDefinitions({}));
describe("19.6 cut-tag edits", () => {
  it("creates independent tags, reparents without retargeting, atomically rejects unsupported nodes, and undoes", () => {
    const s = store();
    const [wall, hole, g] = s.drawShapes([{ x: 0, z: 0, width: 4, depth: 4, cutTags: ["lobby"] }, { x: 0, z: 0, width: 1, depth: 1, kind: "hole", cutTags: ["lobby"] }, { type: "group", ref: "g" }, { x: 100, z: 0, width: 1, depth: 1, parent: "$g" }], "human");
    const before = targets(s.getScene().nodes);
    s.updateNodes([{ id: hole.id, parent: g.id }], "human");
    expect(targets(s.getScene().nodes)).toEqual(before);
    s.updateNodes([{ id: hole.id, cutTags: [] }], "human");
    expect(cutters(s.getScene().nodes).size).toBe(0);
    s.undo(); expect(targets(s.getScene().nodes)).toEqual(before);
    expect(() => s.updateNodes([{ id: wall.id, name: "bad" }, { id: g.id, cutTags: ["x"] }], "human")).toThrow(/cutTags|cut tags/);
    expect(s.getScene().nodes.find((n) => n.id === wall.id)?.name).toBeUndefined();
    expect(() => s.updateNodes([{ id: hole.id, cutTags: ["bad:namespace"] }], "human")).toThrow(/colon/);
  });
  it("preserves internal and external cuts through instance/array detach and serializes legal tags", () => {
    const s = store();
    const [wall, inst] = s.drawShapes([{ x: 0, z: 0, width: 4, depth: 4, cutTags: ["lobby"] }, { type: "instance", entity: "door", x: 0, z: 0, cutTagParts: { hole: ["lobby"] } }], "human");
    expect(cutters(expandNodes(s.getScene().nodes)).get(wall.id)).toHaveLength(1);
    s.detachInstances([inst.id], "human");
    s.getScene().nodes.forEach((n) => expect(() => NodeSchema.parse(n)).not.toThrow());
    expect(cutters(expandNodes(s.getScene().nodes)).get(wall.id)).toHaveLength(1);
    s.undo();
    const array = s.makeArray(inst.id, "human");
    expect(array.cutTagParts?.["0/hole"]).toEqual(["lobby"]);
    const before = cutters(expandNodes(s.getScene().nodes)).get(wall.id)?.length;
    const [group] = s.detachInstances([array.id], "human");
    expect(s.getScene().nodes.filter((n) => n.parent === group.id)).toHaveLength(4);
    expect(cutters(expandNodes(s.getScene().nodes)).get(wall.id)).toHaveLength(before!);
  });
  it("rejects detach before mutation when shared external tags would introduce internal cuts", () => {
    const s = store();
    setDefinitions({ door: [{ ...part("solid", "volume"), cutTags: [] }, { ...part("hole", "hole"), cutTags: [] }] });
    const [i] = s.drawShapes([{ type: "instance", entity: "door", x: 0, z: 0, cutTags: ["lobby"] }], "human");
    const before = s.getScene().nodes;
    expect(() => s.detachInstances([i.id], "human")).toThrow(/per-part/);
    expect(s.getScene().nodes).toEqual(before);
  });
  it("Make entity retains external bindings and conversion/duplicates keep tag membership", () => {
    const s = store();
    const [wall, hole] = s.drawShapes([{ x: 0, z: 0, width: 4, depth: 4, cutTags: ["lobby"] }, { x: 0, z: 0, width: 1, depth: 1, kind: "hole", cutTags: ["lobby"] }], "human");
    const prepared = s.prepareEntity([hole.id]);
    setDefinitions({ ...defs, custom: prepared.nodes });
    const instance = s.commitEntity(prepared, "custom", "custom", "human")!;
    expect(instance.cutTagParts?.[hole.id]).toEqual(["lobby"]);
    expect(cutters(expandNodes(s.getScene().nodes)).get(wall.id)).toHaveLength(1);
    const converted = s.convertNodes({ ids: [wall.id] }, "human");
    expect(converted[0]).toHaveProperty("cutTags", ["lobby"]);
    expect(cutters(expandNodes(s.getScene().nodes)).get(converted[0].id)).toHaveLength(1);
    const [copy] = s.duplicateNodes({ ids: [converted[0].id], dx: 0, dz: 0 }, "human");
    expect(copy).toHaveProperty("cutTags", ["lobby"]);
    expect(cutters(expandNodes(s.getScene().nodes)).get(copy.id)).toHaveLength(1);
    const pasted = s.pasteNodes({ nodes: [copy], focus: { x: 0, z: 0 }, parent: null }, "human");
    expect(pasted[0]).toHaveProperty("cutTags", ["lobby"]);
  });
});

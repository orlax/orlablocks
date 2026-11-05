import { afterEach, describe, expect, it } from "vitest";
import { setDefinitions } from "../shared/entities";
import { NodeSchema, type OpenScene } from "../shared/scene.types";
import { describeScene, findNodes, MAX_QUERY_IDS } from "./outline";
import { createSceneStore } from "./scene";

const open: OpenScene = { project: { id: "test", name: "test", description: "fixture" }, scene: { id: "main", name: "main" } };
afterEach(() => setDefinitions({}));

function fixture() {
  setDefinitions({ block: [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 1, height: 1, rotation: 0, color: "gray", createdBy: "human" }] });
  const store = createSceneStore();
  const made = store.drawShapes([
    { type: "group", ref: "g" },
    { type: "group", ref: "nested", parent: "$g" },
    { type: "cylinder", x: 0, z: 0, width: 8, depth: 8, parent: "$nested" },
    { type: "ramp", ref: "ramp", spiral: { x: 0, z: 0, radius: 8, turn: 180, y: 0, rise: 2 }, width: 1 },
    { type: "array", entity: "block", layout: { type: "path", along: { id: "$ramp" }, place: "count", count: 4 }, skip: [1] },
    { type: "note", x: 0, z: 0, text: "unrelated" },
  ], "agent");
  return { store, made };
}

describe("19.1 bounded reads", () => {
  it("keeps requested order, collapses groups even in small scenes, and omits unrelated selections/notes", () => {
    const { store, made } = fixture();
    store.setSelection([made[5].id]);
    const out = describeScene(open, store.getScene(), { ids: [made[3].id, made[0].id, made[3].id, "gone"] });
    expect(out.nodes.map((n) => n.id)).toEqual([made[3].id, made[0].id]);
    expect(out.nodes[1]).toHaveProperty("collapsed", true);
    expect(out.missing).toEqual(["gone"]);
    expect(out.selected).toBeUndefined();
    expect(out.notes).toBeUndefined();
    expect(describeScene(open, store.getScene(), { ids: [made[0].id], depth: 1 }).nodes.map((n) => n.id)).toEqual([made[0].id, made[1].id]);
    const full = describeScene(open, store.getScene(), { ids: [made[0].id, made[2].id], full: true });
    expect(full.nodes.map((n) => n.id)).toEqual([made[0].id, made[2].id, made[1].id]);
    expect(full.nodes.every((n) => !n.collapsed)).toBe(true);
    expect(() => describeScene(open, store.getScene(), { ids: [made[0].id], root: made[0].id })).toThrow(/mutually exclusive/);
    expect(() => describeScene(open, store.getScene(), { ids: Array(MAX_QUERY_IDS + 1).fill("x") })).toThrow(/IDs/);
  });

  it("resolves array items as placed instances, reporting skipped and invalid indices", () => {
    const { store, made } = fixture();
    const a = made[4].id;
    const out = describeScene(open, store.getScene(), { ids: [a, `${a}/0`, `${a}/1`, `${a}/999`] });
    expect(out.nodes[0].at).toBeUndefined();
    expect(out.nodes[1]).toMatchObject({ id: `${a}/0`, type: "instance", entity: "block", x: 8 });
    expect(out.missing).toEqual([`${a}/1`, `${a}/999`]);
    expect(describeScene(open, store.getScene(), { root: `${a}/0` }).root).toEqual(out.nodes[1]);
    expect(describeScene(open, store.getScene(), { ids: [a], full: true }).nodes[0].at).toHaveLength(3);
    expect(findNodes(store.getScene().nodes, { type: "item", ids: [`${a}/0`, `${a}/1`] }).found.map((n) => n.id)).toEqual([`${a}/0`]);
    expect(findNodes(store.getScene().nodes, { under: a, kind: "room", ids: [`${a}/0`] }).found).toEqual([]);
  });

  it("intersects IDs with recursive containment and type filters", () => {
    const { store, made } = fixture();
    expect(findNodes(store.getScene().nodes, { ids: made.map((n) => n.id), under: made[0].id, type: "cylinder" }).found.map((n) => n.id)).toEqual([made[2].id]);
    expect(findNodes(store.getScene().nodes, { ids: ["gone"] }).found).toEqual([]);
  });
});

describe("19.1 creation and spiral edits", () => {
  it("defaults only creation kinds, preserving room updates and strict stored/freeform validation", () => {
    const store = createSceneStore();
    const made = store.drawShapes([
      { x: 0, z: 0, width: 2, depth: 2 },
      { type: "cylinder", x: 4, z: 0, width: 2, depth: 2 },
      { kind: "room", x: 8, z: 0, width: 4, depth: 4 },
    ], "agent");
    expect(made).toMatchObject([{ kind: "volume" }, { kind: "volume" }, { kind: "room" }]);
    expect(store.updateNodes([{ id: made[2].id, name: "still a room" }], "agent")[0]).toMatchObject({ kind: "room" });
    const { kind: _, ...invalid } = made[0] as Record<string, unknown>;
    expect(NodeSchema.safeParse(invalid).success).toBe(false);
    expect(() => store.drawShapes([{ type: "freeform", points: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }] } as never], "agent")).toThrow();
  });

  it("updates spirals through normal dependency refresh and one-step undo/redo", () => {
    const { store, made } = fixture();
    const before = structuredClone(store.getScene().nodes);
    store.updateNodes([{ id: made[3].id, spiral: { x: 10, z: 0, radius: 10, from: 90, turn: 180, y: 2, rise: 4 } }], "agent");
    const after = structuredClone(store.getScene().nodes);
    expect(after[3]).toMatchObject({ id: made[3].id, points: [{ x: 10, y: 2, z: -10 }, {}, { y: 6 }] });
    expect(after[3]).not.toHaveProperty("spiral");
    expect(after[4]).toMatchObject({ layout: { along: { id: made[3].id } } });
    expect(after[4]).not.toEqual(before[4]);
    store.undo();
    expect(store.getScene().nodes).toEqual(before);
    store.redo();
    expect(store.getScene().nodes).toEqual(after);
  });

  it("unlinks through lines on spiral edits and rejects incompatible/conflicting batches atomically", () => {
    const { store, made } = fixture();
    const [line] = store.drawShapes([{ type: "line", through: { stops: [made[2].id, `${made[4].id}/0`] } }], "agent");
    const spiral = { x: 0, z: 0, radius: 5, turn: 90, y: 0, rise: 3 };
    const [changed] = store.updateNodes([{ id: line.id, spiral }], "agent");
    expect(changed).not.toHaveProperty("through");
    expect(changed).toMatchObject({ points: [{ x: 5, y: 0, z: 0 }, { x: 0, y: 3, z: -5 }] });
    const before = structuredClone(store.getScene().nodes);
    const history = store.getHistory();
    for (const change of [
      { id: made[2].id, spiral },
      { id: line.id, spiral, points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] },
      { id: line.id, spiral, through: { stops: [made[2].id, `${made[4].id}/0`] } },
      { id: line.id, spiral: { ...spiral, turn: 1e9 } },
      { id: made[3].id, spiral: { ...spiral, radius: 0.1 } },
    ]) {
      expect(() => store.updateNodes([{ id: made[2].id, name: "must not change" }, change], "agent")).toThrow();
      expect(store.getScene().nodes).toEqual(before);
      expect(store.getHistory()).toEqual(history);
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Box, Freeform, SceneNode } from "../shared/scene.types";
import { subtreeIds } from "../shared/tree";
import { createSceneStore, SceneError } from "./scene";

const boxes = (store: ReturnType<typeof createSceneStore>) => store.getScene().nodes.filter((n): n is Box => n.type === "box");

describe("scene store", () => {
  it("adds a valid batch with box_N IDs and notifies listeners", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);

    const created = store.drawShapes(
      [
        { kind: "room", x: 0, z: 0, width: 6, depth: 4, height: 5 },
        { kind: "volume", x: 1, z: 1, width: 2, depth: 2, height: 1 },
        { kind: "room", x: 6, z: 0, width: 4, depth: 4, height: 3 },
      ],
      "agent",
    );

    expect(created.map((b) => b.id)).toEqual(["box_1", "box_2", "box_3"]);
    expect(store.getScene().nodes).toHaveLength(3);
    expect(created[1]).toMatchObject({ kind: "volume", width: 2, depth: 2, height: 1, createdBy: "agent" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fills in defaults: rooms 3 m, volumes 0.25 m, on the ground, unrotated, almost-white, unnamed", () => {
    const store = createSceneStore();
    const [room, volume] = store.drawShapes(
      [
        { kind: "room", x: 0, z: 0, width: 4, depth: 4 },
        { kind: "volume", x: 0, z: 0, width: 1, depth: 1 },
      ],
      "human",
    );
    expect(room.height).toBe(3);
    expect(volume.height).toBe(0.25);
    expect(room).toMatchObject({ type: "box", y: 0, rotation: 0, color: "almost-white" });
    expect("name" in room).toBe(false);
  });

  it("keeps elevation, rotation, color and name, normalizing rotation to 0..360", () => {
    const store = createSceneStore();
    const [a, b] = store.drawShapes(
      [
        { kind: "volume", x: 0, z: 0, width: 1, depth: 1, y: -2.5, rotation: -90, color: "blue", name: "  pit  " },
        { kind: "room", x: 0, z: 0, width: 1, depth: 1, rotation: 720, name: "   " },
      ],
      "agent",
    );
    expect(a).toMatchObject({ y: -2.5, rotation: 270, color: "blue", name: "pit" });
    expect(b).toMatchObject({ rotation: 0 });
    expect("name" in b).toBe(false);
  });

  it("rejects unknown colors and unknown fields", () => {
    const store = createSceneStore();
    // @ts-expect-error unknown color on purpose
    expect(() => store.drawShapes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1, color: "teal" }], "agent")).toThrow(
      /shapes\[0\]\.color/,
    );
    // @ts-expect-error unknown field on purpose
    expect(() => store.drawShapes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1, level: 2 }], "agent")).toThrow(/level/);
  });

  it("rejects the whole batch when one item is invalid", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);

    expect(() =>
      store.drawShapes(
        [
          { kind: "room", x: 0, z: 0, width: 1, depth: 1 },
          { kind: "volume", x: 1, z: 1, width: 2, depth: -2 },
        ],
        "agent",
      ),
    ).toThrow(/shapes\[1\]\.depth/);
    expect(store.getScene().nodes).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("requires a known kind, width and depth", () => {
    const store = createSceneStore();
    // @ts-expect-error missing depth on purpose
    expect(() => store.drawShapes([{ kind: "room", x: 3, z: 4, width: 2 }], "human")).toThrow(/shapes\[0\]\.depth/);
    // @ts-expect-error unknown kind on purpose
    expect(() => store.drawShapes([{ kind: "tower", x: 0, z: 0, width: 1, depth: 1 }], "agent")).toThrow(/shapes\[0\]\.kind/);
  });

  it("rejects heights below one vertical snap step (0.05 m)", () => {
    const store = createSceneStore();
    expect(() => store.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, height: 0.04 }], "agent")).toThrow(
      /shapes\[0\]\.height/,
    );
    const [ok] = store.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, height: 0.05 }], "agent");
    expect(ok.height).toBe(0.05);
  });

  it("keeps non-integer values, rounded to 2 decimals", () => {
    const store = createSceneStore();
    const [box] = store.drawShapes([{ kind: "room", x: 10.25, z: 4.3333, width: 3.5, depth: 1.25, height: 2.456 }], "agent");
    expect(box).toMatchObject({ x: 10.25, z: 4.33, width: 3.5, depth: 1.25, height: 2.46 });
  });

  it("rejects footprints that round to 0 and empty batches", () => {
    const store = createSceneStore();
    expect(() => store.drawShapes([{ kind: "room", x: 0, z: 0, width: 1, depth: 0.001 }], "agent")).toThrow(SceneError);
    expect(() => store.drawShapes([], "agent")).toThrow(SceneError);
  });

  it("stores the reported view without notifying listeners", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);
    store.setView({ focus: { x: 1.005, z: -2 }, yaw: 45.678, bounds: { x: -30, z: -20, width: 72.333, depth: 45 } });
    expect(store.getScene().view).toEqual({
      focus: { x: 1, z: -2 },
      yaw: 45.68,
      bounds: { x: -30, z: -20, width: 72.33, depth: 45 },
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("clears the scene without reusing IDs", () => {
    const store = createSceneStore();
    store.drawShapes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1 }], "human");
    store.clear("human");
    expect(store.getScene().nodes).toHaveLength(0);
    const [next] = store.drawShapes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1 }], "human");
    expect(next.id).toBe("box_2");
  });
});

describe("scene store history", () => {
  const room = (x: number) => ({ kind: "room" as const, x, z: 0, width: 4, depth: 4 });
  const ids = (store: ReturnType<typeof createSceneStore>) => store.getScene().nodes.map((b) => b.id);

  it("undoes and redoes a draw, keeping the same IDs", () => {
    const store = createSceneStore();
    store.drawShapes([room(0)], "human");
    store.drawShapes([room(5)], "human");
    expect(store.getHistory()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "Draw box_2" });

    expect(store.undo()?.label).toBe("Draw box_2");
    expect(ids(store)).toEqual(["box_1"]);
    expect(store.redo()?.label).toBe("Draw box_2");
    expect(ids(store)).toEqual(["box_1", "box_2"]);
  });

  it("an agent batch is one undo step, labeled as the agent's", () => {
    const store = createSceneStore();
    store.drawShapes([room(0)], "human");
    store.drawShapes([room(5), room(10), { kind: "volume", x: 1, z: 1, width: 1, depth: 1 }], "agent");
    expect(store.getHistory().undoLabel).toBe("Agent: draw box_2, box_3, box_4");
    store.undo();
    expect(ids(store)).toEqual(["box_1"]);
  });

  it("undo reverts the latest step whoever made it", () => {
    const store = createSceneStore();
    store.drawShapes([room(0)], "agent");
    store.drawShapes([room(5)], "human");
    store.undo();
    expect(ids(store)).toEqual(["box_1"]);
  });

  it("Clear is undoable and restores boxes in their original order", () => {
    const store = createSceneStore();
    store.drawShapes([room(0), room(5)], "agent");
    store.drawShapes([{ kind: "volume", x: 1, z: 1, width: 1, depth: 1 }], "human");
    store.clear("human");
    expect(store.getHistory().undoLabel).toBe("Clear");
    store.undo();
    expect(ids(store)).toEqual(["box_1", "box_2", "box_3"]);
  });

  it("clearing an empty scene records nothing", () => {
    const store = createSceneStore();
    store.clear("human");
    expect(store.getHistory().canUndo).toBe(false);
  });

  it("a new edit clears redo, and new IDs never reuse undone ones", () => {
    const store = createSceneStore();
    store.drawShapes([room(0)], "human");
    store.undo();
    store.drawShapes([room(5)], "human");
    expect(store.getHistory().canRedo).toBe(false);
    expect(ids(store)).toEqual(["box_2"]);
  });

  it("a rejected batch adds no step", () => {
    const store = createSceneStore();
    expect(() => store.drawShapes([{ kind: "room", x: 0, z: 0, width: -1, depth: 1 }], "agent")).toThrow(SceneError);
    expect(store.getHistory().canUndo).toBe(false);
  });

  it("undo and redo notify listeners, and do nothing when there's nothing to do", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);
    expect(store.undo()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    store.drawShapes([room(0)], "human");
    store.undo();
    store.redo();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("scene store updates", () => {
  const setup = () => {
    const store = createSceneStore();
    store.drawShapes(
      [
        { kind: "room", x: 0, z: 0, width: 4, depth: 4 },
        { kind: "volume", x: 1, z: 1, width: 1, depth: 1 },
      ],
      "human",
    );
    return store;
  };
  const heights = (store: ReturnType<typeof createSceneStore>) => boxes(store).map((b) => b.height);

  it("changes heights as one undoable step", () => {
    const store = setup();
    const updated = store.updateNodes([{ id: "box_2", height: 1.5 }], "human");
    expect(updated).toMatchObject([{ id: "box_2", height: 1.5 }]);
    expect(heights(store)).toEqual([3, 1.5]);
    expect(store.getHistory().undoLabel).toBe("Change height of box_2");
    store.undo();
    expect(heights(store)).toEqual([3, 0.25]);
    store.redo();
    expect(heights(store)).toEqual([3, 1.5]);
  });

  it("changes any field, and undo restores every one of them", () => {
    const store = setup();
    const before = structuredClone(store.getScene().nodes);
    store.updateNodes(
      [{ id: "box_1", x: 10.123, z: -4, y: 3, width: 6, depth: 2, height: 4, rotation: 375, color: "yellow", kind: "volume", name: "lobby" }],
      "agent",
    );
    expect(store.getScene().nodes[0]).toMatchObject({
      x: 10.12, z: -4, y: 3, width: 6, depth: 2, height: 4, rotation: 15, color: "yellow", kind: "volume", name: "lobby",
    });
    expect(store.getHistory().undoLabel).toBe("Agent: edit box_1");
    store.undo();
    expect(store.getScene().nodes).toEqual(before);
  });

  it("labels an edit by what changed", () => {
    const store = setup();
    store.updateNodes([{ id: "box_1", x: 2, z: 2 }, { id: "box_2", y: 1 }], "human");
    expect(store.getHistory().undoLabel).toBe("Edit box_1, box_2");
    store.updateNodes([{ id: "box_1", x: 3 }, { id: "box_2", z: 5 }], "human");
    expect(store.getHistory().undoLabel).toBe("Move box_1, box_2");
    store.updateNodes([{ id: "box_1", color: "red" }], "agent");
    expect(store.getHistory().undoLabel).toBe("Agent: recolor box_1");
  });

  it("an empty name removes the name", () => {
    const store = setup();
    store.updateNodes([{ id: "box_1", name: "lobby" }], "human");
    store.updateNodes([{ id: "box_1", name: "" }], "human");
    expect("name" in store.getScene().nodes[0]).toBe(false);
    store.undo();
    expect(store.getScene().nodes[0].name).toBe("lobby");
  });

  it("rejects unknown IDs, duplicates, empty changes and invalid values, changing nothing", () => {
    const store = setup();
    const listener = vi.fn();
    store.onChange(listener);
    expect(() => store.updateNodes([{ id: "box_99", height: 2 }], "agent")).toThrow(/changes\[0\]\.id: no node "box_99"/);
    expect(() =>
      store.updateNodes(
        [
          { id: "box_1", height: 5 },
          { id: "box_2", height: 0.01 },
        ],
        "agent",
      ),
    ).toThrow(/changes\[1\]\.height/);
    expect(() =>
      store.updateNodes(
        [
          { id: "box_1", height: 5 },
          { id: "box_1", height: 6 },
        ],
        "agent",
      ),
    ).toThrow(/more than once/);
    expect(() => store.updateNodes([{ id: "box_1" }], "agent")).toThrow(/nothing to change/);
    expect(() => store.updateNodes([{ id: "box_1", width: 0.001 }], "agent")).toThrow(/changes\[0\]\.width/);
    // @ts-expect-error unknown color on purpose
    expect(() => store.updateNodes([{ id: "box_1", color: "teal" }], "agent")).toThrow(/changes\[0\]\.color/);
    expect(heights(store)).toEqual([3, 0.25]);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getHistory().undoLabel).toBe("Draw box_1, box_2");
  });

  it("records nothing when nothing actually changes", () => {
    const store = setup();
    store.updateNodes([{ id: "box_1", height: 3, rotation: 360, color: "almost-white" }], "human");
    expect(store.getHistory().undoLabel).toBe("Draw box_1, box_2");
  });
});

describe("scene store removal and selection", () => {
  const setup = () => {
    const store = createSceneStore();
    store.drawShapes(
      [0, 5, 10].map((x) => ({ kind: "room" as const, x, z: 0, width: 4, depth: 4 })),
      "human",
    );
    return store;
  };
  const ids = (store: ReturnType<typeof createSceneStore>) => store.getScene().nodes.map((b) => b.id);

  it("removes boxes as one step, and undo brings them back with the same IDs in place", () => {
    const store = setup();
    store.removeNodes(["box_1", "box_3"], "agent");
    expect(ids(store)).toEqual(["box_2"]);
    expect(store.getHistory().undoLabel).toBe("Agent: delete box_1, box_3");
    store.undo();
    expect(ids(store)).toEqual(["box_1", "box_2", "box_3"]);
  });

  it("rejects unknown or repeated IDs, removing nothing", () => {
    const store = setup();
    expect(() => store.removeNodes(["box_1", "box_9"], "agent")).toThrow(/ids\[1\]: no node "box_9"/);
    expect(() => store.removeNodes(["box_1", "box_1"], "agent")).toThrow(/more than once/);
    expect(() => store.removeNodes([], "agent")).toThrow(SceneError);
    expect(ids(store)).toEqual(["box_1", "box_2", "box_3"]);
  });

  it("reports the selection without notifying listeners or recording a step, dropping unknown IDs", () => {
    const store = setup();
    const listener = vi.fn();
    store.onChange(listener);
    store.setSelection(["box_2", "box_9", "box_2"]);
    expect(store.getScene().selection).toEqual(["box_2"]);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getHistory().undoLabel).toBe("Draw box_1, box_2, box_3");
  });

  it("drops removed boxes from the selection", () => {
    const store = setup();
    store.setSelection(["box_1", "box_2"]);
    store.removeNodes(["box_1"], "agent");
    expect(store.getScene().selection).toEqual(["box_2"]);
    store.clear("human");
    expect(store.getScene().selection).toEqual([]);
  });
});

describe("scene store groups", () => {
  /** box_1 at x 0, box_2 at x 10, box_3 at x 20, all 2 × 2 × 1 volumes. */
  const setup = () => {
    const store = createSceneStore();
    store.drawShapes(
      [0, 10, 20].map((x) => ({ kind: "volume" as const, x, z: 0, width: 2, depth: 2, height: 1 })),
      "human",
    );
    return store;
  };
  const node = (store: ReturnType<typeof createSceneStore>, id: string) => store.getScene().nodes.find((n) => n.id === id)!;
  const ids = (store: ReturnType<typeof createSceneStore>) => store.getScene().nodes.map((n) => n.id);

  it("groups nodes as one step: the group goes where the first node was, and undo dissolves it", () => {
    const store = setup();
    const group = store.groupNodes({ ids: ["box_3", "box_2"], name: " lobby " }, "human");
    expect(group).toMatchObject({ id: "group_1", type: "group", name: "lobby" });
    expect(ids(store)).toEqual(["box_1", "group_1", "box_2", "box_3"]);
    expect(node(store, "box_2").parent).toBe("group_1");
    expect(node(store, "box_1").parent).toBeUndefined();
    expect(store.getHistory().undoLabel).toBe("Group box_3, box_2 as group_1");
    store.undo();
    expect(ids(store)).toEqual(["box_1", "box_2", "box_3"]);
    expect("parent" in node(store, "box_2")).toBe(false);
  });

  it("nests a new group inside the deepest group holding all its members", () => {
    const store = setup();
    store.groupNodes({ ids: ["box_1", "box_2", "box_3"] }, "human");
    const inner = store.groupNodes({ ids: ["box_2", "box_3"] }, "human");
    expect(inner.parent).toBe("group_1");
    // A listed node whose ancestor is also listed stays inside it.
    const outer = store.groupNodes({ ids: ["group_2", "box_3"] }, "human");
    expect(node(store, "group_2").parent).toBe(outer.id);
    expect(node(store, "box_3").parent).toBe("group_2");
  });

  it("moves a group with everything in it, relatively, as one step", () => {
    const store = setup();
    store.groupNodes({ ids: ["box_1", "box_2"] }, "human");
    const moved = store.moveNodes({ ids: ["group_1"], dx: 6, dy: 0.5 }, "agent");
    expect((moved as Box[]).map((b) => [b.id, b.x, b.y])).toEqual([
      ["box_1", 6, 0.5],
      ["box_2", 16, 0.5],
    ]);
    expect(node(store, "box_3")).toMatchObject({ x: 20 });
    expect(store.getHistory().undoLabel).toBe("Agent: move group_1");
    store.undo();
    expect(node(store, "box_1")).toMatchObject({ x: 0, y: 0 });
  });

  it("rotates a group around the center of its bounds", () => {
    const store = setup();
    store.groupNodes({ ids: ["box_1", "box_2"] }, "human");
    // Bounds x -1..11: center 5, 0. A 90° counterclockwise turn sends +x to -z.
    store.rotateNodes({ ids: ["group_1"], degrees: 90 }, "agent");
    expect(node(store, "box_1")).toMatchObject({ x: 5, z: 5, rotation: 90 });
    expect(node(store, "box_2")).toMatchObject({ x: 5, z: -5, rotation: 90 });
  });

  it("deleting a group deletes everything in it; undo restores it all in place", () => {
    const store = setup();
    store.groupNodes({ ids: ["box_1", "box_2"] }, "human");
    store.removeNodes(["group_1"], "human");
    expect(ids(store)).toEqual(["box_3"]);
    store.undo();
    expect(ids(store)).toEqual(["group_1", "box_1", "box_2", "box_3"]);
  });

  it("a group left empty disappears in the same step, and comes back on undo", () => {
    const store = setup();
    store.groupNodes({ ids: ["box_1"] }, "human");
    store.removeNodes(["box_1"], "human");
    expect(ids(store)).toEqual(["box_2", "box_3"]);
    store.undo();
    expect(ids(store)).toEqual(["group_1", "box_1", "box_2", "box_3"]);

    // Moving the last child out has the same effect.
    store.updateNodes([{ id: "box_1", parent: null }], "human");
    expect(ids(store)).toEqual(["box_1", "box_2", "box_3"]);
  });

  it("ungroups: contents move up to the group's parent, nested groups dissolve together", () => {
    const store = setup();
    store.groupNodes({ ids: ["box_1", "box_2", "box_3"] }, "human");
    store.groupNodes({ ids: ["box_2", "box_3"] }, "human");
    expect(store.ungroup({ ids: ["group_2"] }, "human")).toEqual(["box_2", "box_3"]);
    expect(node(store, "box_2").parent).toBe("group_1");
    store.undo();
    expect(store.ungroup({ ids: ["group_1", "group_2"] }, "human")).toEqual(["box_1", "box_2", "box_3"]);
    expect(store.getScene().nodes.every((n) => n.parent === undefined)).toBe(true);
    expect(() => store.ungroup({ ids: ["box_1"] }, "human")).toThrow(/is a box, not a group/);
  });

  it("draws into a group and reparents with update_nodes, rejecting bad parents and cycles", () => {
    const store = setup();
    store.groupNodes({ ids: ["box_1"] }, "human");
    const [pillar] = store.drawShapes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, parent: "group_1" }], "agent");
    expect(pillar.parent).toBe("group_1");
    expect(() => store.drawShapes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1, parent: "box_2" }], "agent")).toThrow(
      /shapes\[0\]\.parent: "box_2" is a box/,
    );
    store.updateNodes([{ id: "box_2", parent: "group_1" }], "human");
    expect(store.getHistory().undoLabel).toBe("Regroup box_2");
    store.groupNodes({ ids: ["box_2"] }, "human"); // group_2 inside group_1
    expect(() => store.updateNodes([{ id: "group_1", parent: "group_2" }], "agent")).toThrow(/"group_2" is inside "group_1"/);
    expect(() => store.updateNodes([{ id: "group_1", x: 3 }], "agent")).toThrow(/only name and parent/);
    store.updateNodes([{ id: "group_1", name: "lobby" }], "agent");
    expect(node(store, "group_1").name).toBe("lobby");
  });

  it("drops selected nodes that disappear with their group", () => {
    const store = setup();
    store.groupNodes({ ids: ["box_1", "box_2"] }, "human");
    store.setSelection(["group_1", "box_1", "box_3"]);
    store.removeNodes(["group_1"], "human");
    expect(store.getScene().selection).toEqual(["box_3"]);
  });
});

describe("scene store copies", () => {
  /** lobby (group_1) holds box_1 and hall (group_2) with box_2; box_3 is at the top level. */
  const setup = () => {
    const store = createSceneStore();
    store.drawShapes(
      [0, 10, 20].map((x) => ({ kind: "volume" as const, x, z: 0, width: 2, depth: 2, height: 1 })),
      "human",
    );
    store.updateNodes([{ id: "box_2", name: "pillar" }], "human");
    store.groupNodes({ ids: ["box_2"], name: "hall" }, "human");
    store.groupNodes({ ids: ["box_1", "group_1"], name: "lobby" }, "human");
    return store;
  };
  const ids = (store: ReturnType<typeof createSceneStore>) => store.getScene().nodes.map((n) => n.id);
  const node = (store: ReturnType<typeof createSceneStore>, id: string) => store.getScene().nodes.find((n) => n.id === id)!;

  it("copies a nested group with new IDs, names and structure, right after the original, as one step", () => {
    const store = setup();
    expect(ids(store)).toEqual(["group_2", "box_1", "group_1", "box_2", "box_3"]);
    const copies = store.duplicateNodes({ ids: ["group_2"], dx: 20 }, "agent");
    expect(copies.map((n) => n.id)).toEqual(["group_3"]);
    expect(ids(store)).toEqual(["group_2", "box_1", "group_1", "box_2", "group_3", "box_4", "group_4", "box_5", "box_3"]);
    expect(node(store, "group_3")).toMatchObject({ name: "lobby", createdBy: "agent" });
    expect(node(store, "group_3").parent).toBeUndefined();
    expect(node(store, "group_4")).toMatchObject({ name: "hall", parent: "group_3" });
    expect(node(store, "box_5")).toMatchObject({ name: "pillar", parent: "group_4", x: 30, createdBy: "agent" });
    expect(node(store, "box_2")).toMatchObject({ x: 10, parent: "group_1" });
    expect(store.getHistory().undoLabel).toBe("Agent: copy lobby (group_2)");
    store.undo();
    expect(ids(store)).toEqual(["group_2", "box_1", "group_1", "box_2", "box_3"]);
    store.redo();
    expect(ids(store)).toContain("box_5");
  });

  it("makes a row with count, copy i offset by i times the offset, and never reuses IDs", () => {
    const store = setup();
    const copies = store.duplicateNodes({ ids: ["box_3"], dx: 0.25, dy: 3, count: 3 }, "human");
    expect(copies.map((n) => [n.id, (n as Box).x, (n as Box).y])).toEqual([
      ["box_4", 20.25, 3],
      ["box_5", 20.5, 6],
      ["box_6", 20.75, 9],
    ]);
    expect(ids(store).slice(-4)).toEqual(["box_3", "box_4", "box_5", "box_6"]);
    expect(store.getHistory().undoLabel).toBe("Copy box_3 ×3");
    store.undo();
    expect(store.duplicateNodes({ ids: ["box_3"] }, "human").map((n) => n.id)).toEqual(["box_7"]);
  });

  it("keeps a copied box in its original's group, and copies a node listed with its ancestor once", () => {
    const store = setup();
    const [copy] = store.duplicateNodes({ ids: ["box_2"], dz: 4 }, "human");
    expect(copy).toMatchObject({ id: "box_4", parent: "group_1", z: 4 });
    expect(ids(store)).toEqual(["group_2", "box_1", "group_1", "box_2", "box_4", "box_3"]);
    const copies = store.duplicateNodes({ ids: ["box_1", "group_2"] }, "human");
    expect(copies.map((n) => n.id)).toEqual(["group_3"]);
    expect(store.getScene().nodes.filter((n) => n.parent === "group_3").map((n) => n.id)).toEqual(["box_5", "group_4"]);
  });

  it("rejects unknown or repeated IDs and bad counts, copying nothing", () => {
    const store = setup();
    const before = ids(store);
    expect(() => store.duplicateNodes({ ids: ["box_9"] }, "agent")).toThrow(SceneError);
    expect(() => store.duplicateNodes({ ids: ["box_1", "box_1"] }, "agent")).toThrow(/more than once/);
    expect(() => store.duplicateNodes({ ids: ["box_1"], count: 0 }, "agent")).toThrow(SceneError);
    expect(() => store.duplicateNodes({ ids: ["box_1"], count: 101 }, "agent")).toThrow(SceneError);
    expect(() => store.duplicateNodes({ ids: ["box_1"], count: 1.5 }, "agent")).toThrow(SceneError);
    expect(ids(store)).toEqual(before);
    expect(store.getHistory().undoLabel).toBe("Group box_1, group_1 as group_2");
  });
});

describe("scene store mirroring", () => {
  /** An L of rotated boxes, grouped as group_1, plus box_3 far away. */
  const setup = () => {
    const store = createSceneStore();
    store.drawShapes(
      [
        { kind: "room", x: 4, z: 0, width: 8, depth: 2, rotation: 10 },
        { kind: "volume", x: 1, z: 3, width: 2, depth: 4, rotation: 30, y: 1 },
        { kind: "volume", x: 50, z: 50, width: 1, depth: 1 },
      ],
      "human",
    );
    store.groupNodes({ ids: ["box_1", "box_2"], name: "wing" }, "human");
    return store;
  };
  const box = (store: ReturnType<typeof createSceneStore>, id: string) => boxes(store).find((b) => b.id === id)!;

  it("mirrors a group on X as one step: centers reflect, rotations negate, y stays, others untouched", () => {
    const store = setup();
    const before = boxes(store);
    const mirrored = store.mirrorNodes({ ids: ["group_1"], axis: "x" }, "agent");
    expect(mirrored.map((b) => b.id)).toEqual(["box_1", "box_2"]);
    expect(box(store, "box_1")).toMatchObject({ rotation: 350, z: 0 });
    expect(box(store, "box_2")).toMatchObject({ rotation: 330, z: 3, y: 1 });
    // The two centers swap sides: box_2 was west of box_1, now it's east.
    expect(box(store, "box_2").x).toBeGreaterThan(box(store, "box_1").x);
    expect(box(store, "box_3")).toEqual(before[2]);
    expect(store.getHistory().undoLabel).toBe("Agent: mirror group_1 on X");
    store.undo();
    expect(boxes(store)).toEqual(before);
  });

  it("mirroring twice on either axis restores the exact values", () => {
    const store = setup();
    const before = boxes(store);
    for (const axis of ["x", "z"] as const) {
      store.mirrorNodes({ ids: ["group_1"], axis }, "human");
      expect(boxes(store)).not.toEqual(before);
      store.mirrorNodes({ ids: ["group_1"], axis }, "human");
      expect(boxes(store)).toEqual(before);
    }
    expect(store.getHistory().undoLabel).toBe("Mirror group_1 on Z");
  });

  it("records nothing for a single unrotated box, and rejects unknown IDs and axes", () => {
    const store = setup();
    const label = store.getHistory().undoLabel;
    store.mirrorNodes({ ids: ["box_3"], axis: "z" }, "human");
    expect(store.getHistory().undoLabel).toBe(label);
    expect(() => store.mirrorNodes({ ids: ["box_9"], axis: "x" }, "human")).toThrow(/no node "box_9"/);
    // @ts-expect-error y isn't a mirror axis
    expect(() => store.mirrorNodes({ ids: ["box_1"], axis: "y" }, "human")).toThrow(SceneError);
  });
});

describe("scene store paste and cut", () => {
  /** lobby (group_1) holds hall (group_2) with box_1 (x 0) and box_2 (x 4); box_3 is at the top level. */
  const setup = () => {
    const store = createSceneStore();
    store.drawShapes(
      [
        { kind: "room", x: 0, z: 0, width: 2, depth: 2, name: "a" },
        { kind: "volume", x: 4, z: 0, width: 2, depth: 2, y: 3, name: "b" },
        { kind: "volume", x: 50, z: 50, width: 1, depth: 1 },
      ],
      "human",
    );
    store.groupNodes({ ids: ["box_1", "box_2"], name: "hall" }, "human");
    store.groupNodes({ ids: ["group_1"], name: "lobby" }, "human");
    return store;
  };
  /** What the editor puts on the clipboard for `ids`: their subtrees, in list order. */
  const snapshot = (store: ReturnType<typeof createSceneStore>, ids: string[]) => {
    const all = new Set(ids.flatMap((id) => [...subtreeIds(store.getScene().nodes, id)]));
    return structuredClone(store.getScene().nodes.filter((n) => all.has(n.id)));
  };
  const node = (store: ReturnType<typeof createSceneStore>, id: string) => store.getScene().nodes.find((n) => n.id === id)!;

  it("pastes with fresh IDs, names and nesting, centered on the focus (snapped offset), keeping y, as one step", () => {
    const store = setup();
    const clip = snapshot(store, ["group_2"]);
    // The boxes span x -1..5, so the center is x 2, z 0; focus 10.3, -7.1 → offset 8.5 (snapped), -7.
    const roots = store.pasteNodes({ nodes: clip, focus: { x: 10.3, z: -7.1 }, parent: null }, "human");
    expect(roots.map((n) => n.id)).toEqual(["group_3"]);
    expect(node(store, "group_3")).toMatchObject({ name: "lobby" });
    expect(node(store, "group_3").parent).toBeUndefined();
    expect(node(store, "group_4")).toMatchObject({ name: "hall", parent: "group_3" });
    expect(node(store, "box_4")).toMatchObject({ name: "a", parent: "group_4", x: 8.5, z: -7, y: 0 });
    expect(node(store, "box_5")).toMatchObject({ name: "b", parent: "group_4", x: 12.5, z: -7, y: 3 });
    expect(store.getHistory().undoLabel).toBe("Paste 4 nodes");
    store.undo();
    expect(store.getScene().nodes).toHaveLength(5);
  });

  it("drops parents outside the snapshot, and pastes into the entered group, last among its children", () => {
    const store = setup();
    // box_2 alone: its parent group_1 isn't in the snapshot.
    const [root] = store.pasteNodes({ nodes: snapshot(store, ["box_2"]), focus: { x: 0, z: 0 }, parent: null }, "human");
    expect(root.parent).toBeUndefined();
    expect(store.getHistory().undoLabel).toBe("Paste box_4");
    store.pasteNodes({ nodes: snapshot(store, ["box_3"]), focus: { x: 0, z: 0 }, parent: "group_1" }, "human");
    expect(node(store, "box_5").parent).toBe("group_1");
    const ids = store.getScene().nodes.map((n) => n.id);
    expect(ids.indexOf("box_5")).toBe(ids.indexOf("box_2") + 1);
  });

  it("pasting twice makes two copies; cut removes as one step labeled Cut", () => {
    const store = setup();
    const clip = snapshot(store, ["box_3"]);
    store.removeNodes(["box_3"], "human", { cut: true });
    expect(store.getHistory().undoLabel).toBe("Cut box_3");
    store.pasteNodes({ nodes: clip, focus: { x: 0, z: 0 }, parent: null }, "human");
    store.pasteNodes({ nodes: clip, focus: { x: 0, z: 0 }, parent: null }, "human");
    expect(boxes(store).map((b) => [b.id, b.x, b.z]).slice(-2)).toEqual([
      ["box_4", 0, 0],
      ["box_5", 0, 0],
    ]);
  });

  it("rejects repeated IDs, cycles, a bad parent, no boxes and invalid nodes, pasting nothing", () => {
    const store = setup();
    const before = store.getScene().nodes.length;
    const clip = snapshot(store, ["group_2"]);
    // Invalid nodes on purpose, so they go in untyped.
    const paste = (nodes: unknown[], parent: string | null = null) =>
      store.pasteNodes({ nodes: nodes as SceneNode[], focus: { x: 0, z: 0 }, parent }, "human");
    expect(() => paste([...clip, clip[0]])).toThrow(/appears more than once/);
    expect(() => paste(clip.map((n) => (n.id === "group_2" ? { ...n, parent: "group_1" } : n)))).toThrow(/inside itself/);
    expect(() => paste(clip, "box_3")).toThrow(/is a box, not a group/);
    expect(() => paste(clip.filter((n) => n.type === "group"))).toThrow(/no shapes/);
    expect(() => paste([{ ...clip[2], width: -1 }])).toThrow(SceneError);
    expect(() => paste([])).toThrow(SceneError);
    expect(store.getScene().nodes).toHaveLength(before);
  });
});

describe("scene store placing (outliner drag and drop)", () => {
  /** box_1..box_4 at the top level; group_1 holds box_2 and box_3. */
  const setup = () => {
    const store = createSceneStore();
    store.drawShapes([0, 1, 2, 3].map((x) => ({ kind: "volume" as const, x, z: 0, width: 1, depth: 1 })), "human");
    store.groupNodes({ ids: ["box_2", "box_3"] }, "human");
    return store;
  };
  const tree = (store: ReturnType<typeof createSceneStore>) =>
    store.getScene().nodes.map((n) => (n.parent ? `${n.id}<${n.parent}` : n.id));

  it("reorders siblings as one undoable step", () => {
    const store = setup();
    store.placeNodes({ ids: ["box_4"], parent: null, before: "box_1" }, "human");
    expect(tree(store)).toEqual(["box_4", "box_1", "group_1", "box_2<group_1", "box_3<group_1"]);
    expect(store.getHistory().undoLabel).toBe("Reorder box_4");
    store.undo();
    expect(tree(store)).toEqual(["box_1", "group_1", "box_2<group_1", "box_3<group_1", "box_4"]);
  });

  it("moves nodes into a group, last among its children, or before a child", () => {
    const store = setup();
    store.placeNodes({ ids: ["box_1"], parent: "group_1", before: null }, "human");
    expect(tree(store)).toEqual(["group_1", "box_2<group_1", "box_3<group_1", "box_1<group_1", "box_4"]);
    expect(store.getHistory().undoLabel).toBe("Move box_1 into group_1");
    store.placeNodes({ ids: ["box_4"], parent: "group_1", before: "box_2" }, "human");
    expect(tree(store)).toEqual(["group_1", "box_4<group_1", "box_2<group_1", "box_3<group_1", "box_1<group_1"]);
  });

  it("moving a group's last nodes out removes the group in the same step", () => {
    const store = setup();
    store.placeNodes({ ids: ["box_2", "box_3"], parent: null, before: null }, "human");
    expect(tree(store)).toEqual(["box_1", "box_4", "box_2", "box_3"]);
    store.undo();
    expect(tree(store)).toEqual(["box_1", "group_1", "box_2<group_1", "box_3<group_1", "box_4"]);
  });

  it("rejects a group inside itself and a `before` from another parent, and records nothing for a no-op", () => {
    const store = setup();
    store.groupNodes({ ids: ["group_1"] }, "human"); // group_2 holds group_1
    expect(() => store.placeNodes({ ids: ["group_2"], parent: "group_1", before: null }, "human")).toThrow(/is inside "group_2"/);
    expect(() => store.placeNodes({ ids: ["box_1"], parent: "group_1", before: "box_4" }, "human")).toThrow(/isn't in group_1/);
    const label = store.getHistory().undoLabel;
    store.placeNodes({ ids: ["box_2"], parent: "group_1", before: "box_3" }, "human");
    expect(store.getHistory().undoLabel).toBe(label);
  });
});

describe("scene store cylinders", () => {
  it("draws cylinders with their own IDs, smooth unless given sides", () => {
    const store = createSceneStore();
    const [box, round, octagon] = store.drawShapes(
      [
        { kind: "room", x: 0, z: 0, width: 4, depth: 4 },
        { type: "cylinder", kind: "room", x: 10, z: 0, width: 10, depth: 10, name: "shrine" },
        { type: "cylinder", kind: "volume", x: 20, z: 0, width: 3, depth: 2, sides: 8 },
      ],
      "agent",
    );
    expect([box.id, round.id, octagon.id]).toEqual(["box_1", "cylinder_1", "cylinder_2"]);
    expect(round).toMatchObject({ type: "cylinder", height: 3, name: "shrine" });
    expect(round).not.toHaveProperty("sides");
    expect(octagon).toMatchObject({ type: "cylinder", sides: 8, height: 0.25 });
    expect(store.getNextId()).toEqual({ box: 2, group: 1, cylinder: 3, freeform: 1 });
    expect(store.getHistory().undoLabel).toBe("Agent: draw box_1, cylinder_1, cylinder_2");
  });

  it("rejects sides on a box, and side counts outside 3..64", () => {
    const store = createSceneStore();
    expect(() => store.drawShapes([{ kind: "room", x: 0, z: 0, width: 4, depth: 4, sides: 6 }], "agent")).toThrow(/shapes\[0\]\.sides: only a cylinder/);
    expect(() => store.drawShapes([{ type: "cylinder", kind: "room", x: 0, z: 0, width: 4, depth: 4, sides: 2 }], "agent")).toThrow(/sides/);
    expect(() => store.drawShapes([{ type: "cylinder", kind: "room", x: 0, z: 0, width: 4, depth: 4, sides: 65 }], "agent")).toThrow(/sides/);
    expect(store.getScene().nodes).toHaveLength(0);
  });

  it("changes sides, makes it smooth with null, and undoes both", () => {
    const store = createSceneStore();
    const [c] = store.drawShapes([{ type: "cylinder", kind: "room", x: 0, z: 0, width: 6, depth: 6 }], "human");
    store.updateNodes([{ id: c.id, sides: 6 }], "human");
    expect(store.getScene().nodes[0]).toMatchObject({ sides: 6 });
    expect(store.getHistory().undoLabel).toBe("Change sides of cylinder_1");
    store.updateNodes([{ id: c.id, sides: null }], "human");
    expect(store.getScene().nodes[0]).not.toHaveProperty("sides");
    store.undo();
    expect(store.getScene().nodes[0]).toMatchObject({ sides: 6 });
    store.undo();
    expect(store.getScene().nodes[0]).not.toHaveProperty("sides");
    // A box has no sides.
    const [b] = store.drawShapes([{ kind: "room", x: 10, z: 0, width: 4, depth: 4 }], "human");
    expect(() => store.updateNodes([{ id: b.id, sides: 6 }], "agent")).toThrow(/only a cylinder has sides/);
  });

  it("mirrors an odd-sided cylinder on X to 180 - rotation, and twice back exactly", () => {
    const store = createSceneStore();
    const [p] = store.drawShapes([{ type: "cylinder", kind: "volume", x: 3, z: 1, width: 4, depth: 3, sides: 5, rotation: 20 }], "human");
    store.mirrorNodes({ ids: [p.id], axis: "x" }, "human");
    expect(store.getScene().nodes[0]).toMatchObject({ rotation: 160 });
    store.mirrorNodes({ ids: [p.id], axis: "x" }, "human");
    expect(store.getScene().nodes[0]).toEqual(p);
    store.mirrorNodes({ ids: [p.id], axis: "z" }, "human");
    expect(store.getScene().nodes[0]).toMatchObject({ rotation: 340 });
  });

  it("copies and pastes cylinders with fresh cylinder IDs, keeping their sides", () => {
    const store = createSceneStore();
    const [c] = store.drawShapes([{ type: "cylinder", kind: "room", x: 0, z: 0, width: 6, depth: 6, sides: 8 }], "human");
    const [copy] = store.duplicateNodes({ ids: [c.id], dx: 10 }, "human");
    expect(copy).toMatchObject({ id: "cylinder_2", type: "cylinder", sides: 8, x: 10 });
    const [pasted] = store.pasteNodes({ nodes: [c], focus: { x: 50, z: 0 }, parent: null }, "human");
    expect(pasted).toMatchObject({ id: "cylinder_3", sides: 8, x: 50 });
  });
});

describe("scene store free-forms", () => {
  const l = [
    { x: 0, z: 0 },
    { x: 6, z: 0 },
    { x: 6, z: 2 },
    { x: 2, z: 2 },
    { x: 2, z: 6 },
    { x: 0, z: 6 },
  ];

  it("draws free-forms with their own IDs, points rounded and empty handles dropped", () => {
    const store = createSceneStore();
    const [f] = store.drawShapes(
      [{ type: "freeform", kind: "room", points: [{ x: 0.123, z: 0, out: { x: 0.001, z: 0 } }, ...l.slice(1)], name: "cave" }],
      "agent",
    );
    expect(f).toMatchObject({ id: "freeform_1", type: "freeform", kind: "room", height: 3, y: 0, name: "cave" });
    expect((f as Freeform).points[0]).toEqual({ x: 0.12, z: 0 });
    expect(store.getHistory().undoLabel).toBe("Agent: draw freeform_1");
  });

  it("refuses an outline that crosses itself, too few points, and box fields", () => {
    const store = createSceneStore();
    const bowtie = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 0, z: 4 }, { x: 5, z: 5 }];
    expect(() => store.drawShapes([{ type: "freeform", kind: "room", points: bowtie }], "agent")).toThrow(
      /shapes\[0\]\.points: the outline crosses itself \(the edges from point 1 and from point 3\)/,
    );
    expect(() => store.drawShapes([{ type: "freeform", kind: "room", points: l.slice(0, 2) }], "agent")).toThrow(/points/);
    expect(() => store.drawShapes([{ type: "freeform", kind: "room", points: l, width: 3 } as never], "agent")).toThrow(/width/);
    expect(store.getScene().nodes).toHaveLength(0);
  });

  it("updates points (one reshape step), refuses footprint fields, and undoes", () => {
    const store = createSceneStore();
    const [f] = store.drawShapes([{ type: "freeform", kind: "volume", points: l }], "human");
    store.updateNodes([{ id: f.id, points: l.map((p) => ({ ...p, x: p.x * 2 })) }], "human");
    expect(store.getHistory().undoLabel).toBe("Reshape freeform_1");
    expect((store.getScene().nodes[0] as Freeform).points[1]).toEqual({ x: 12, z: 0 });
    // The same points again change nothing.
    store.updateNodes([{ id: f.id, points: l.map((p) => ({ ...p, x: p.x * 2 })) }], "human");
    expect(store.getHistory().undoLabel).toBe("Reshape freeform_1");
    expect(() => store.updateNodes([{ id: f.id, x: 3 }], "agent")).toThrow(/is a free-form, with no x of its own/);
    expect(() => store.updateNodes([{ id: f.id, points: [l[0], l[1], l[0], l[1]] }], "agent")).toThrow(/points/);
    const [b] = store.drawShapes([{ kind: "room", x: 20, z: 0, width: 2, depth: 2 }], "human");
    expect(() => store.updateNodes([{ id: b.id, points: l }], "agent")).toThrow(/only a free-form has points/);
    store.undo();
    store.undo();
    expect((store.getScene().nodes[0] as Freeform).points).toEqual(l);
  });

  it("moves, rotates, mirrors, copies and pastes free-forms through their points", () => {
    const store = createSceneStore();
    const [f] = store.drawShapes([{ type: "freeform", kind: "volume", points: l }], "human");
    const points = () => (store.getScene().nodes.find((n) => n.id === f.id) as Freeform).points;
    store.moveNodes({ ids: [f.id], dx: 1, dz: 2 }, "agent");
    expect(points()[0]).toEqual({ x: 1, z: 2 });
    store.rotateNodes({ ids: [f.id], degrees: 90 }, "agent");
    store.rotateNodes({ ids: [f.id], degrees: -90 }, "agent");
    expect(points()[0]).toEqual({ x: 1, z: 2 });
    const before = points();
    store.mirrorNodes({ ids: [f.id], axis: "x" }, "agent");
    expect(points()).not.toEqual(before);
    store.mirrorNodes({ ids: [f.id], axis: "x" }, "agent");
    expect(points()).toEqual(before);
    const [copy] = store.duplicateNodes({ ids: [f.id], dx: 10 }, "agent");
    expect(copy).toMatchObject({ id: "freeform_2" });
    expect((copy as Freeform).points[0]).toEqual({ x: 11, z: 2 });
    const [pasted] = store.pasteNodes({ nodes: [store.getScene().nodes[0]], focus: { x: 50, z: 0 }, parent: null }, "human");
    expect(pasted.id).toBe("freeform_3");
    // Its bounds (x 1..7, z 2..8) are centered on the focus.
    expect((pasted as Freeform).points[0]).toEqual({ x: 47, z: -3 });
  });
});

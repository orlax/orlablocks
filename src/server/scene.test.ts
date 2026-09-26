import { describe, expect, it, vi } from "vitest";
import { createSceneStore, SceneError } from "./scene";

describe("scene store", () => {
  it("adds a valid batch with box_N IDs and notifies listeners", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);

    const created = store.drawBoxes(
      [
        { kind: "room", x: 0, z: 0, width: 6, depth: 4, height: 5 },
        { kind: "volume", x: 1, z: 1, width: 2, depth: 2, height: 1 },
        { kind: "room", x: 6, z: 0, width: 4, depth: 4, height: 3 },
      ],
      "agent",
    );

    expect(created.map((b) => b.id)).toEqual(["box_1", "box_2", "box_3"]);
    expect(store.getScene().boxes).toHaveLength(3);
    expect(created[1]).toMatchObject({ kind: "volume", width: 2, depth: 2, height: 1, createdBy: "agent" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fills in defaults: rooms 3 m, volumes 0.25 m, on the ground, unrotated, almost-white, unnamed", () => {
    const store = createSceneStore();
    const [room, volume] = store.drawBoxes(
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
    const [a, b] = store.drawBoxes(
      [
        { kind: "volume", x: 0, z: 0, width: 1, depth: 1, y: -2.5, rotation: -90, color: "blue", name: "  pit  " },
        { kind: "room", x: 0, z: 0, width: 1, depth: 1, rotation: 720, name: "   " },
      ],
      "agent",
    );
    expect(a).toMatchObject({ y: -2.5, rotation: 270, color: "blue", name: "pit" });
    expect(b.rotation).toBe(0);
    expect("name" in b).toBe(false);
  });

  it("rejects unknown colors and unknown fields", () => {
    const store = createSceneStore();
    // @ts-expect-error unknown color on purpose
    expect(() => store.drawBoxes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1, color: "teal" }], "agent")).toThrow(
      /boxes\[0\]\.color/,
    );
    // @ts-expect-error unknown field on purpose
    expect(() => store.drawBoxes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1, parent: "group_1" }], "agent")).toThrow(
      /parent/,
    );
  });

  it("rejects the whole batch when one item is invalid", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);

    expect(() =>
      store.drawBoxes(
        [
          { kind: "room", x: 0, z: 0, width: 1, depth: 1 },
          { kind: "volume", x: 1, z: 1, width: 2, depth: -2 },
        ],
        "agent",
      ),
    ).toThrow(/boxes\[1\]\.depth/);
    expect(store.getScene().boxes).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("requires a known kind, width and depth", () => {
    const store = createSceneStore();
    // @ts-expect-error missing depth on purpose
    expect(() => store.drawBoxes([{ kind: "room", x: 3, z: 4, width: 2 }], "human")).toThrow(/boxes\[0\]\.depth/);
    // @ts-expect-error unknown kind on purpose
    expect(() => store.drawBoxes([{ kind: "tower", x: 0, z: 0, width: 1, depth: 1 }], "agent")).toThrow(/boxes\[0\]\.kind/);
  });

  it("rejects heights below one vertical snap step (0.05 m)", () => {
    const store = createSceneStore();
    expect(() => store.drawBoxes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, height: 0.04 }], "agent")).toThrow(
      /boxes\[0\]\.height/,
    );
    const [ok] = store.drawBoxes([{ kind: "volume", x: 0, z: 0, width: 1, depth: 1, height: 0.05 }], "agent");
    expect(ok.height).toBe(0.05);
  });

  it("keeps non-integer values, rounded to 2 decimals", () => {
    const store = createSceneStore();
    const [box] = store.drawBoxes([{ kind: "room", x: 10.25, z: 4.3333, width: 3.5, depth: 1.25, height: 2.456 }], "agent");
    expect(box).toMatchObject({ x: 10.25, z: 4.33, width: 3.5, depth: 1.25, height: 2.46 });
  });

  it("rejects footprints that round to 0 and empty batches", () => {
    const store = createSceneStore();
    expect(() => store.drawBoxes([{ kind: "room", x: 0, z: 0, width: 1, depth: 0.001 }], "agent")).toThrow(SceneError);
    expect(() => store.drawBoxes([], "agent")).toThrow(SceneError);
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
    store.drawBoxes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1 }], "human");
    store.clear("human");
    expect(store.getScene().boxes).toHaveLength(0);
    const [next] = store.drawBoxes([{ kind: "room", x: 0, z: 0, width: 1, depth: 1 }], "human");
    expect(next.id).toBe("box_2");
  });
});

describe("scene store history", () => {
  const room = (x: number) => ({ kind: "room" as const, x, z: 0, width: 4, depth: 4 });
  const ids = (store: ReturnType<typeof createSceneStore>) => store.getScene().boxes.map((b) => b.id);

  it("undoes and redoes a draw, keeping the same IDs", () => {
    const store = createSceneStore();
    store.drawBoxes([room(0)], "human");
    store.drawBoxes([room(5)], "human");
    expect(store.getHistory()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "Draw box_2" });

    expect(store.undo()?.label).toBe("Draw box_2");
    expect(ids(store)).toEqual(["box_1"]);
    expect(store.redo()?.label).toBe("Draw box_2");
    expect(ids(store)).toEqual(["box_1", "box_2"]);
  });

  it("an agent batch is one undo step, labeled as the agent's", () => {
    const store = createSceneStore();
    store.drawBoxes([room(0)], "human");
    store.drawBoxes([room(5), room(10), { kind: "volume", x: 1, z: 1, width: 1, depth: 1 }], "agent");
    expect(store.getHistory().undoLabel).toBe("Agent: draw box_2, box_3, box_4");
    store.undo();
    expect(ids(store)).toEqual(["box_1"]);
  });

  it("undo reverts the latest step whoever made it", () => {
    const store = createSceneStore();
    store.drawBoxes([room(0)], "agent");
    store.drawBoxes([room(5)], "human");
    store.undo();
    expect(ids(store)).toEqual(["box_1"]);
  });

  it("Clear is undoable and restores boxes in their original order", () => {
    const store = createSceneStore();
    store.drawBoxes([room(0), room(5)], "agent");
    store.drawBoxes([{ kind: "volume", x: 1, z: 1, width: 1, depth: 1 }], "human");
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
    store.drawBoxes([room(0)], "human");
    store.undo();
    store.drawBoxes([room(5)], "human");
    expect(store.getHistory().canRedo).toBe(false);
    expect(ids(store)).toEqual(["box_2"]);
  });

  it("a rejected batch adds no step", () => {
    const store = createSceneStore();
    expect(() => store.drawBoxes([{ kind: "room", x: 0, z: 0, width: -1, depth: 1 }], "agent")).toThrow(SceneError);
    expect(store.getHistory().canUndo).toBe(false);
  });

  it("undo and redo notify listeners, and do nothing when there's nothing to do", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);
    expect(store.undo()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    store.drawBoxes([room(0)], "human");
    store.undo();
    store.redo();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("scene store updates", () => {
  const setup = () => {
    const store = createSceneStore();
    store.drawBoxes(
      [
        { kind: "room", x: 0, z: 0, width: 4, depth: 4 },
        { kind: "volume", x: 1, z: 1, width: 1, depth: 1 },
      ],
      "human",
    );
    return store;
  };
  const heights = (store: ReturnType<typeof createSceneStore>) => store.getScene().boxes.map((b) => b.height);

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
    const before = structuredClone(store.getScene().boxes);
    store.updateNodes(
      [{ id: "box_1", x: 10.123, z: -4, y: 3, width: 6, depth: 2, height: 4, rotation: 375, color: "yellow", kind: "volume", name: "lobby" }],
      "agent",
    );
    expect(store.getScene().boxes[0]).toMatchObject({
      x: 10.12, z: -4, y: 3, width: 6, depth: 2, height: 4, rotation: 15, color: "yellow", kind: "volume", name: "lobby",
    });
    expect(store.getHistory().undoLabel).toBe("Agent: edit box_1");
    store.undo();
    expect(store.getScene().boxes).toEqual(before);
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
    expect("name" in store.getScene().boxes[0]).toBe(false);
    store.undo();
    expect(store.getScene().boxes[0].name).toBe("lobby");
  });

  it("rejects unknown IDs, duplicates, empty changes and invalid values, changing nothing", () => {
    const store = setup();
    const listener = vi.fn();
    store.onChange(listener);
    expect(() => store.updateNodes([{ id: "box_99", height: 2 }], "agent")).toThrow(/changes\[0\]\.id: no box "box_99"/);
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
    store.drawBoxes(
      [0, 5, 10].map((x) => ({ kind: "room" as const, x, z: 0, width: 4, depth: 4 })),
      "human",
    );
    return store;
  };
  const ids = (store: ReturnType<typeof createSceneStore>) => store.getScene().boxes.map((b) => b.id);

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
    expect(() => store.removeNodes(["box_1", "box_9"], "agent")).toThrow(/ids\[1\]: no box "box_9"/);
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

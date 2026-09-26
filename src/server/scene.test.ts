import { describe, expect, it, vi } from "vitest";
import { createSceneStore, SceneError } from "./scene";

describe("scene store", () => {
  it("adds a valid batch with per-kind IDs and notifies listeners", () => {
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

    expect(created.map((b) => b.id)).toEqual(["room_1", "volume_1", "room_2"]);
    expect(store.getScene().boxes).toHaveLength(3);
    expect(created[1]).toMatchObject({ kind: "volume", width: 2, depth: 2, height: 1, createdBy: "agent" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("gives rooms 3 m and volumes 0.25 m when no height is passed", () => {
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
    expect(next.id).toBe("room_2");
  });
});

describe("scene store history", () => {
  const room = (x: number) => ({ kind: "room" as const, x, z: 0, width: 4, depth: 4 });
  const ids = (store: ReturnType<typeof createSceneStore>) => store.getScene().boxes.map((b) => b.id);

  it("undoes and redoes a draw, keeping the same IDs", () => {
    const store = createSceneStore();
    store.drawBoxes([room(0)], "human");
    store.drawBoxes([room(5)], "human");
    expect(store.getHistory()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "Draw room_2" });

    expect(store.undo()?.label).toBe("Draw room_2");
    expect(ids(store)).toEqual(["room_1"]);
    expect(store.redo()?.label).toBe("Draw room_2");
    expect(ids(store)).toEqual(["room_1", "room_2"]);
  });

  it("an agent batch is one undo step, labeled as the agent's", () => {
    const store = createSceneStore();
    store.drawBoxes([room(0)], "human");
    store.drawBoxes([room(5), room(10), { kind: "volume", x: 1, z: 1, width: 1, depth: 1 }], "agent");
    expect(store.getHistory().undoLabel).toBe("Agent: draw room_2, room_3, volume_1");
    store.undo();
    expect(ids(store)).toEqual(["room_1"]);
  });

  it("undo reverts the latest step whoever made it", () => {
    const store = createSceneStore();
    store.drawBoxes([room(0)], "agent");
    store.drawBoxes([room(5)], "human");
    store.undo();
    expect(ids(store)).toEqual(["room_1"]);
  });

  it("Clear is undoable and restores boxes in their original order", () => {
    const store = createSceneStore();
    store.drawBoxes([room(0), room(5)], "agent");
    store.drawBoxes([{ kind: "volume", x: 1, z: 1, width: 1, depth: 1 }], "human");
    store.clear("human");
    expect(store.getHistory().undoLabel).toBe("Clear");
    store.undo();
    expect(ids(store)).toEqual(["room_1", "room_2", "volume_1"]);
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
    expect(ids(store)).toEqual(["room_2"]);
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
    const updated = store.updateBoxes([{ id: "volume_1", height: 1.5 }], "human");
    expect(updated).toMatchObject([{ id: "volume_1", height: 1.5 }]);
    expect(heights(store)).toEqual([3, 1.5]);
    expect(store.getHistory().undoLabel).toBe("Change height of volume_1");
    store.undo();
    expect(heights(store)).toEqual([3, 0.25]);
    store.redo();
    expect(heights(store)).toEqual([3, 1.5]);
  });

  it("labels agent changes and batches them in one step", () => {
    const store = setup();
    store.updateBoxes(
      [
        { id: "room_1", height: 6 },
        { id: "volume_1", height: 2 },
      ],
      "agent",
    );
    expect(store.getHistory().undoLabel).toBe("Agent: change height of room_1, volume_1");
    store.undo();
    expect(heights(store)).toEqual([3, 0.25]);
  });

  it("rejects unknown IDs, duplicates and heights below 0.05 m, changing nothing", () => {
    const store = setup();
    const listener = vi.fn();
    store.onChange(listener);
    expect(() => store.updateBoxes([{ id: "room_99", height: 2 }], "agent")).toThrow(/changes\[0\]\.id: no box "room_99"/);
    expect(() =>
      store.updateBoxes(
        [
          { id: "room_1", height: 5 },
          { id: "volume_1", height: 0.01 },
        ],
        "agent",
      ),
    ).toThrow(/changes\[1\]\.height/);
    expect(() =>
      store.updateBoxes(
        [
          { id: "room_1", height: 5 },
          { id: "room_1", height: 6 },
        ],
        "agent",
      ),
    ).toThrow(/more than once/);
    expect(heights(store)).toEqual([3, 0.25]);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getHistory().undoLabel).toBe("Draw room_1, volume_1");
  });

  it("records nothing when no height actually changes", () => {
    const store = setup();
    store.updateBoxes([{ id: "room_1", height: 3 }], "human");
    expect(store.getHistory().undoLabel).toBe("Draw room_1, volume_1");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createSceneStore, SceneError } from "./scene";

describe("scene store", () => {
  it("adds a valid batch and notifies listeners", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);

    const created = store.addRects(
      [
        { x: 0, y: 0, width: 2, height: 2 },
        { x: 5, y: 5, width: 6, height: 3 },
      ],
      "agent",
    );

    expect(created.map((r) => r.id)).toEqual(["rect_1", "rect_2"]);
    expect(store.getScene().rects).toHaveLength(2);
    expect(created[1]).toMatchObject({ width: 6, height: 3, createdBy: "agent" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects the whole batch when one item is invalid", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);

    expect(() =>
      store.addRects(
        [
          { x: 0, y: 0, width: 1, height: 1 },
          { x: 1, y: 1, width: 2, height: -2 },
        ],
        "agent",
      ),
    ).toThrow(/rects\[1\]\.height/);
    expect(store.getScene().rects).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("requires width and height", () => {
    const store = createSceneStore();
    // @ts-expect-error missing height on purpose
    expect(() => store.addRects([{ x: 3, y: 4, width: 2 }], "human")).toThrow(/rects\[0\]\.height/);
  });

  it("keeps non-integer coordinates, rounded to 2 decimals", () => {
    const store = createSceneStore();
    const [rect] = store.addRects([{ x: 10.25, y: 4.3333, width: 3.5, height: 1.25 }], "agent");
    expect(rect).toMatchObject({ x: 10.25, y: 4.33, width: 3.5, height: 1.25 });
  });

  it("rejects dimensions that round to 0 and empty batches", () => {
    const store = createSceneStore();
    expect(() => store.addRects([{ x: 0, y: 0, width: 1, height: 0.001 }], "agent")).toThrow(SceneError);
    expect(() => store.addRects([], "agent")).toThrow(SceneError);
  });

  it("stores the reported view without notifying listeners", () => {
    const store = createSceneStore();
    const listener = vi.fn();
    store.onChange(listener);
    store.setView({ x: 0, y: 0, width: 72.333, height: 45 });
    expect(store.getScene().view).toEqual({ x: 0, y: 0, width: 72.33, height: 45 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("clears the scene", () => {
    const store = createSceneStore();
    store.addRects([{ x: 0, y: 0, width: 1, height: 1 }], "human");
    store.clear();
    expect(store.getScene().rects).toHaveLength(0);
  });
});

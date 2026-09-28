import { beforeEach, describe, expect, it } from "vitest";
import { setDefinitions } from "../shared/entities";
import type { ArrayLayout, ArrayNode } from "../shared/scene.types";
import { arrayHandles, dragArrayHandle, itemDots, toggleSkips } from "./arrayEdit";

const array = (layout: ArrayLayout, fields: Partial<ArrayNode> = {}): ArrayNode => ({ id: "array_1", type: "array", entities: [{ entity: "block" }], layout, createdBy: "human", ...fields });
const circle: ArrayLayout = { type: "circle", x: 2, y: 1, z: 0, radius: 5, count: 4, start: 90 };
const grid: ArrayLayout = { type: "grid", x: 0, y: 0, z: 0, columns: 3, rows: 2, spacing: { x: 2, z: 4 } };

beforeEach(() => setDefinitions({ block: [] }));

describe("an array's edit mode", () => {
  it("shows every item's dot, the skipped ones hollow", () => {
    const dots = itemDots(array(circle, { skip: [1] }));
    expect(dots).toHaveLength(4);
    expect(dots.map((d) => d.skipped)).toEqual([false, true, false, false]);
  });

  it("puts a circle's radius handle at its start, and a grid's spacing handle on its far corner item", () => {
    expect(arrayHandles(array(circle))).toEqual([
      { part: "center", x: 2, y: 1, z: 0 },
      { part: "radius", x: expect.closeTo(2, 5), y: 1, z: -5 },
    ]);
    expect(arrayHandles(array(grid))[1]).toEqual({ part: "spacing", x: 2, y: 0, z: 2 });
  });

  it("drags a center (snapping to a shape's center), a radius or a start, and a grid's spacing", () => {
    const a = array(circle);
    expect(dragArrayHandle(a, "center", { x: 10.3, z: 3.9 })?.patch).toEqual({ x: 10.5, z: 4 });
    expect(dragArrayHandle(a, "center", { x: 10.3, z: 3.9 }, { centers: [{ x: 10.1, z: 3.7 }] })?.patch).toEqual({ x: 10.1, z: 3.7 });
    expect(dragArrayHandle(a, "radius", { x: 2, z: -7.1 })?.patch).toEqual({ radius: 7 });
    expect(dragArrayHandle(a, "radius", { x: 2, z: -7.1 }, { free: true })?.patch).toEqual({ radius: 7.1 });
    expect(dragArrayHandle(a, "radius", { x: 7, z: 0 }, { alt: true })?.patch).toEqual({ start: 0 });
    expect(dragArrayHandle(array(grid), "spacing", { x: 3, z: 1 })?.patch).toEqual({ spacing: { x: 3, z: 2 } });
    expect(dragArrayHandle(array(grid), "spacing", { x: 3, z: 1 }, { alt: true })?.patch).toEqual({ spacing: { x: 3, z: 3 } });
  });

  it("skips shown items and brings skipped ones back", () => {
    expect(toggleSkips(array(circle, { skip: [3] }), [0, 3])).toEqual([0]);
  });
});

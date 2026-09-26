import { describe, expect, it } from "vitest";
import type { Box } from "../shared/scene.types";
import { DEFAULT_CAMERA, worldToScreen, type CameraState } from "./camera";
import { convexHull, marqueeHits, polygonOverlapsRect, rectFrom } from "./marquee";

const size = { width: 1200, height: 800 };
const cam: CameraState = { ...DEFAULT_CAMERA, yaw: 30, distance: 60 };
const box = (patch: Partial<Box>): Box => ({
  id: "box_1",
  type: "box",
  kind: "volume",
  x: 0,
  z: 0,
  y: 0,
  width: 2,
  depth: 2,
  height: 1,
  rotation: 0,
  color: "almost-white",
  createdBy: "human",
  ...patch,
});

describe("convexHull", () => {
  it("drops interior points", () => {
    const hull = convexHull([
      { sx: 0, sy: 0 },
      { sx: 10, sy: 0 },
      { sx: 5, sy: 5 },
      { sx: 10, sy: 10 },
      { sx: 0, sy: 10 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ sx: 5, sy: 5 });
  });
});

describe("polygonOverlapsRect", () => {
  // A diamond centered at 10, 10 with radius 10.
  const diamond = [
    { sx: 10, sy: 0 },
    { sx: 20, sy: 10 },
    { sx: 10, sy: 20 },
    { sx: 0, sy: 10 },
  ];

  it("detects containment and partial overlap", () => {
    expect(polygonOverlapsRect(diamond, { x0: 8, y0: 8, x1: 12, y1: 12 })).toBe(true);
    expect(polygonOverlapsRect(diamond, { x0: -5, y0: -5, x1: 50, y1: 50 })).toBe(true);
    expect(polygonOverlapsRect(diamond, { x0: 15, y0: 5, x1: 30, y1: 8 })).toBe(true);
  });

  it("misses a rect in the diamond's bounding-box corner (bounds alone would say yes)", () => {
    expect(polygonOverlapsRect(diamond, { x0: 0, y0: 0, x1: 3, y1: 3 })).toBe(false);
  });
});

describe("marqueeHits", () => {
  const a = box({});
  const b = box({ id: "box_2", x: 10, z: 0 });
  const far = box({ id: "box_3", x: 40, z: 40 });
  const at = (x: number, y: number, z: number) => worldToScreen(cam, size, { x, y, z })!;

  it("selects the boxes a rect touches, in scene order", () => {
    const p = at(5, 0.5, 0);
    const q = at(10, 0.5, 0);
    // From between the two boxes to the middle of box_2: touches box_2 only.
    expect(marqueeHits(cam, size, [a, b, far], rectFrom({ sx: p.sx, sy: p.sy - 5 }, { sx: q.sx, sy: q.sy + 5 }))).toEqual([
      "box_2",
    ]);
    const r = at(-1, 0.5, 0);
    expect(marqueeHits(cam, size, [far, b, a], rectFrom(r, { sx: q.sx, sy: q.sy + 5 }))).toEqual(["box_2", "box_1"]);
  });

  it("follows the box's rotation", () => {
    // A long thin box along x; turned 90° it runs along z, so a rect at x = 4 no longer touches it.
    const long = box({ width: 10, depth: 0.5 });
    const p = at(4, 0.5, 0);
    const rect = rectFrom({ sx: p.sx - 3, sy: p.sy - 3 }, { sx: p.sx + 3, sy: p.sy + 3 });
    expect(marqueeHits(cam, size, [long], rect)).toEqual(["box_1"]);
    expect(marqueeHits(cam, size, [{ ...long, rotation: 90 }], rect)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { FootPoint } from "../shared/scene.types";
import { DEFAULT_CAMERA, worldToScreen, type CameraState } from "./camera";
import { hitPoints, moveHandle, movePoints, removePoints, togglePoint } from "./points";

const size = { width: 1200, height: 800 };
const cam: CameraState = { ...DEFAULT_CAMERA, yaw: 30, distance: 60 };
const Y = 1;
const screen = (p: { x: number; z: number }) => worldToScreen(cam, size, { x: p.x, y: Y, z: p.z })!;
const square: FootPoint[] = [
  { x: 0, z: 0 },
  { x: 8, z: 0, out: { x: 0, z: 2 }, in: { x: 0, z: -2 } },
  { x: 8, z: 8 },
  { x: 0, z: 8 },
];

describe("hitPoints", () => {
  const at = (p: { x: number; z: number }, selected: number[] = []) => {
    const s = screen(p);
    return hitPoints(cam, size, s.sx, s.sy, square, Y, selected);
  };

  it("finds a point, and a handle only on a selected point", () => {
    expect(at({ x: 8, z: 8 })).toEqual({ type: "point", index: 2 });
    expect(at({ x: 8, z: 2 })?.type).not.toBe("handle");
    expect(at({ x: 8, z: 2 }, [1])).toEqual({ type: "handle", index: 1, side: "out" });
    expect(at({ x: 8, z: -2 }, [1])).toEqual({ type: "handle", index: 1, side: "in" });
  });

  it("finds a spot on an edge with how far along it is", () => {
    const hit = at({ x: 4, z: 8 });
    expect(hit).toMatchObject({ type: "edge", index: 2 });
    expect(hit?.type === "edge" && hit.t).toBeCloseTo(0.5, 1);
    expect(at({ x: 4, z: 4 })).toBeNull();
  });
});

describe("point edits", () => {
  it("moves the chosen points with their handles", () => {
    const moved = movePoints(square, [1, 2], 1, -1);
    expect(moved[1]).toEqual({ x: 9, z: -1, out: { x: 0, z: 2 }, in: { x: 0, z: -2 } });
    expect(moved[2]).toEqual({ x: 9, z: 7 });
    expect(moved[0]).toBe(square[0]);
  });

  it("keeps a smooth point smooth: the opposite handle turns in line and keeps its length; Alt breaks it", () => {
    const [, p] = moveHandle(square, 1, "out", { x: 3, z: 0 }, false);
    expect(p.out).toEqual({ x: 3, z: 0 });
    expect(p.in!.x).toBeCloseTo(-2);
    expect(p.in!.z).toBeCloseTo(0);
    expect(moveHandle(square, 1, "out", { x: 3, z: 0 }, true)[1].in).toEqual({ x: 0, z: -2 });
  });

  it("switches a corner to smooth along its neighbors, and back", () => {
    const smooth = togglePoint(square, 2)[2];
    // Neighbors (8, 0) and (0, 8): the handles run along (-1, 1), a third of the 8 m edges long.
    expect(smooth.out!.x).toBeCloseTo(-8 / 3 / Math.SQRT2);
    expect(smooth.out!.z).toBeCloseTo(8 / 3 / Math.SQRT2);
    expect(smooth.in).toEqual({ x: -smooth.out!.x, z: -smooth.out!.z });
    expect(togglePoint(square, 1)[1]).toEqual({ x: 8, z: 0 });
  });

  it("removes points, but never below 3", () => {
    expect(removePoints(square, [0], 3)).toHaveLength(3);
    expect(removePoints(square, [0, 1], 3)).toBeNull();
  });
});

describe("point edits on a line (open, 3D)", () => {
  const path = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 2, z: 0, in: { x: -1, y: 0, z: 0 }, out: { x: 1, y: 0, z: 0 } },
    { x: 8, y: 0, z: 0 },
  ];

  it("finds a point at its own height, and no closing edge", () => {
    const s = worldToScreen(cam, size, { x: 4, y: 2, z: 0 })!;
    expect(hitPoints(cam, size, s.sx, s.sy, path, 0, [], false)).toEqual({ type: "point", index: 1 });
    // Halfway along the closing edge (8,0,0) → (0,0,0) there's nothing: the path is open.
    const back = worldToScreen(cam, size, { x: 4, y: 0, z: 0 })!;
    expect(hitPoints(cam, size, back.sx, back.sy, path, 0, [], false)?.type).not.toBe("edge");
  });

  it("raises points, keeps a 3D handle in line, and makes an end smooth along its one edge", () => {
    expect(movePoints(path, [0], 0, 0, 1.5)[0]).toEqual({ x: 0, y: 1.5, z: 0 });
    const [, p] = moveHandle(path, 1, "out", { x: 0, y: 2, z: 0 }, false);
    expect(p.in!.y).toBeCloseTo(-1);
    expect(p.in!.x).toBeCloseTo(0);
    const end = togglePoint(path, 2, false)[2];
    expect(end.out!.x).toBeGreaterThan(0);
    expect(end.out!.y).toBeLessThan(0);
    expect(removePoints(path, [0], 2)).toHaveLength(2);
    expect(removePoints(path, [0, 1], 2)).toBeNull();
  });
});

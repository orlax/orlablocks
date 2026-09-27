import { describe, expect, it } from "vitest";
import { boundsOf, footprint, mirrorAcross, moveShape, offsetPolygon, pointInPolygon, signedArea2 } from "./geometry";
import type { Box } from "./scene.types";

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

const apply = (boxes: Box[], patches: ReturnType<typeof mirrorAcross>) => boxes.map((b) => ({ ...b, ...patches[b.id] }));

describe("mirror", () => {
  // An L: a long arm along x and a short one along +z at its west end, the short one turned 30°.
  const l = [box({ id: "box_1", x: 4, z: 0, width: 8, depth: 2 }), box({ id: "box_2", x: 1, z: 3, width: 2, depth: 4, rotation: 30, y: 1 })];

  it("reflects centers across the bounds' center on X, negates rotations, and keeps y and z", () => {
    const b = boundsOf(l);
    const cx = (b.minX + b.maxX) / 2;
    const out = apply(l, mirrorAcross(l, "x"));
    expect(out[0].x).toBeCloseTo(2 * cx - 4, 2);
    expect(out[1].x).toBeCloseTo(2 * cx - 1, 2);
    expect(out.map((o) => [o.z, o.y, o.rotation])).toEqual([
      [0, 0, 0],
      [3, 1, 330],
    ]);
    // The footprint stays where it was.
    const after = boundsOf(out);
    expect(after.minX).toBeCloseTo(b.minX, 2);
    expect(after.maxX).toBeCloseTo(b.maxX, 2);
  });

  it("reflects on Z too, with the same rotation rule", () => {
    const out = apply(l, mirrorAcross(l, "z"));
    expect(out.map((o) => o.x)).toEqual([4, 1]);
    expect(out[1].rotation).toBe(330);
    expect(boundsOf(out).minZ).toBeCloseTo(boundsOf(l).minZ, 2);
  });

  it("mirroring twice restores the exact values, even when the center falls on a rounding tie", () => {
    // Bounds -0.125..0.25 on x and z: the reflection sum is 0.125, an exact tie. Plain rounding drifts 0.01 here.
    const odd = [box({ id: "box_1", x: 0, z: 0, width: 0.25, depth: 0.25 }), box({ id: "box_2", x: 0.2, z: 0.2, width: 0.1, depth: 0.1 })];
    for (const axis of ["x", "z"] as const) {
      const once = apply(odd, mirrorAcross(odd, axis));
      const twice = apply(once, mirrorAcross(once, axis));
      expect(twice).toEqual(odd);
    }
    expect(apply(l, mirrorAcross(apply(l, mirrorAcross(l, "x")), "x"))).toEqual(l);
  });

  it("leaves a single unrotated box as it is", () => {
    const one = [box({ x: 3.25, z: -1 })];
    expect(apply(one, mirrorAcross(one, "x"))).toEqual(one);
    expect(apply(one, mirrorAcross(one, "z"))).toEqual(one);
  });
});

describe("footprint", () => {
  it("is the box's 4 world corners, turned with it", () => {
    const f = footprint(box({ x: 10, z: 5, width: 4, depth: 2, rotation: 90 }));
    // Turned 90° counterclockwise seen from above, the width runs along world -z.
    const round = f.map((p) => ({ x: Math.round(p.x * 100) / 100 + 0, z: Math.round(p.z * 100) / 100 + 0 }));
    expect(round).toEqual([
      { x: 9, z: 7 },
      { x: 9, z: 3 },
      { x: 11, z: 3 },
      { x: 11, z: 7 },
    ]);
  });
});

describe("offsetPolygon", () => {
  const square = [
    { x: 0, z: 0 },
    { x: 2, z: 0 },
    { x: 2, z: 2 },
    { x: 0, z: 2 },
  ];

  it("grows and shrinks a square by the same amount on every side, in either winding", () => {
    for (const poly of [square, [...square].reverse()]) {
      const grown = offsetPolygon(poly, 0.1)!;
      expect(Math.abs(signedArea2(grown)) / 2).toBeCloseTo(2.2 * 2.2);
      expect(grown.every((p) => Math.abs(p.x - 1) === 1.1 || Math.abs(Math.abs(p.x - 1) - 1.1) < 1e-9)).toBe(true);
      expect(Math.abs(signedArea2(offsetPolygon(poly, -0.1)!)) / 2).toBeCloseTo(1.8 * 1.8);
    }
  });

  it("returns null when shrinking collapses it", () => {
    expect(offsetPolygon(square, -1)).toBeNull();
    expect(offsetPolygon(square, -1.5)).toBeNull();
  });
});

describe("pointInPolygon", () => {
  // An L: 0..4 along x at z 0..1, and 0..1 along z up to 4.
  const l = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 1 },
    { x: 1, z: 1 },
    { x: 1, z: 4 },
    { x: 0, z: 4 },
  ];

  it("works on concave outlines", () => {
    expect(pointInPolygon(l, { x: 3, z: 0.5 })).toBe(true);
    expect(pointInPolygon(l, { x: 0.5, z: 3 })).toBe(true);
    expect(pointInPolygon(l, { x: 3, z: 3 })).toBe(false);
  });
});

describe("moveShape", () => {
  it("patches only the axes that move, rounded to 2 decimals", () => {
    expect(moveShape(box({ x: 1, y: 0, z: 2 }), 0.333, 0, 0)).toEqual({ x: 1.33 });
    expect(moveShape(box({}), 0, 0, 0)).toEqual({});
  });
});

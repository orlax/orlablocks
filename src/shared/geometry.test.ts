import { describe, expect, it } from "vitest";
import { boundsOf, mirrorAcross } from "./geometry";
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

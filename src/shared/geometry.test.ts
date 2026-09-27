import { describe, expect, it } from "vitest";
import {
  boundsOf,
  footprint,
  footprintBounds,
  handleFrame,
  mirrorAcross,
  moveShape,
  offsetPolygon,
  outlineProblem,
  pathCrosses,
  pointInPolygon,
  pointInRings,
  resizeShape,
  roomWalls,
  rotateShape,
  sampleEdge,
  signedArea2,
} from "./geometry";
import { CURVE_SEGMENTS, type Box, type Cylinder, type FootPoint, type Freeform } from "./scene.types";

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

describe("cylinders", () => {
  const cylinder = (patch: Partial<Cylinder>): Cylinder => ({ ...box({}), type: "cylinder", ...patch }) as Cylinder;
  const r2 = (n: number) => Math.round(n * 100) / 100 + 0;

  it("an octagon has flat edges facing the world axes at rotation 0", () => {
    const f = footprint(cylinder({ width: 10, depth: 10, sides: 8 }));
    expect(f).toHaveLength(8);
    // The two corners either side of +x share x (a flat edge facing +x), and likewise for +z.
    expect(r2(f[0].x)).toBe(r2(f[7].x));
    expect(r2(f[0].z)).toBe(-r2(f[7].z));
    const b = footprintBounds(cylinder({ width: 10, depth: 10, sides: 8 }));
    expect([r2(b.minX), r2(b.maxX), r2(b.minZ), r2(b.maxZ)]).toEqual([-5, 5, -5, 5].map((v) => r2(v * Math.cos(Math.PI / 8))));
  });

  it("a smooth oval's bounds are its true ellipse's, turned", () => {
    const b = footprintBounds(cylinder({ width: 8, depth: 4, rotation: 90 }));
    expect([r2(b.minX), r2(b.maxX), r2(b.minZ), r2(b.maxZ)]).toEqual([-2, 2, -4, 4]);
    const d = footprintBounds(cylinder({ width: 8, depth: 4, rotation: 45 }));
    expect(r2(d.maxX)).toBe(r2(Math.sqrt((16 + 4) / 2) * 1));
  });

  it("mirroring a pentagon gives its true mirror image on both axes (the box rule, -rotation, wouldn't on X)", () => {
    const p = cylinder({ x: 3, z: 1, width: 4, depth: 3, sides: 5, rotation: 20 });
    for (const axis of ["x", "z"] as const) {
      const [out] = apply([p as unknown as Box], mirrorAcross([p], axis)) as unknown as Cylinder[];
      const b = boundsOf([p]);
      const sum = axis === "x" ? b.minX + b.maxX : b.minZ + b.maxZ;
      const reflected = footprint(p).map((q) => (axis === "x" ? { x: sum - q.x, z: q.z } : { x: q.x, z: sum - q.z }));
      // Every reflected corner is a corner of the result (within the 1 cm the center is rounded to).
      const corners = footprint(out);
      for (const q of reflected) expect(Math.min(...corners.map((c) => Math.hypot(c.x - q.x, c.z - q.z)))).toBeLessThan(0.01);
    }
  });
});

describe("free-forms", () => {
  const freeform = (points: FootPoint[], patch: Partial<Freeform> = {}): Freeform => ({
    id: "freeform_1",
    type: "freeform",
    kind: "volume",
    y: 0,
    height: 1,
    color: "almost-white",
    points,
    createdBy: "human",
    ...patch,
  });
  const square: FootPoint[] = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 4 },
    { x: 0, z: 4 },
  ];

  it("samples straight edges as their start point, curved ones along the curve", () => {
    expect(sampleEdge(square[0], square[1])).toEqual([{ x: 0, z: 0 }]);
    const curved = sampleEdge({ x: 0, z: 0, out: { x: 0, z: -2 } }, { x: 4, z: 0 });
    expect(curved).toHaveLength(CURVE_SEGMENTS);
    // The handle pulls the curve toward -z.
    expect(Math.min(...curved.map((p) => p.z))).toBeLessThan(-0.5);
  });

  it("bounds include a curve that bulges past the points", () => {
    const b = footprintBounds(freeform([{ x: 0, z: 0, out: { x: 0, z: -4 } }, ...square.slice(1)]));
    expect(b.minZ).toBeLessThan(-1);
    expect(handleFrame(freeform(square))).toEqual({ x: 2, z: 2, width: 4, depth: 4, rotation: 0 });
  });

  it("finds what's wrong with an outline", () => {
    expect(outlineProblem(square)).toBeNull();
    // A lopsided bowtie (a symmetric one has no net area): the edges from point 1 and from point 3 cross.
    expect(outlineProblem([square[0], square[1], square[3], { x: 5, z: 5 }])).toMatch(/crosses itself \(the edges from point 1 and from point 3\)/);
    expect(outlineProblem([square[0], square[1], square[1], square[2]])).toMatch(/points 1 and 2 are in the same place/);
    expect(outlineProblem([square[0], square[1], square[0]])).toMatch(/at least 3 distinct points/);
    expect(outlineProblem([square[0], { x: 2, z: 0 }, square[1]])).toMatch(/no area/);
    // A handle long enough to swing the first edge across the far side.
    expect(outlineProblem([{ x: 0, z: 0, out: { x: 0, z: 12 } }, ...square.slice(1)])).toMatch(/crosses itself/);
  });

  it("tells whether a path being drawn crosses itself, open or closed", () => {
    // The third edge comes back down across the first.
    const back = [square[0], square[1], square[2], { x: 2, z: -2 }];
    expect(pathCrosses(back, false)).toBe(true);
    expect(pathCrosses(square, false)).toBe(false);
    // Open, a U doesn't cross; closed, its last edge would only join it.
    expect(pathCrosses(square.slice(0, 3), true)).toBe(false);
  });

  it("moves points (handles unchanged), and patches nothing for no move", () => {
    const f = freeform([{ x: 0, z: 0, out: { x: 1, z: 0 } }, ...square.slice(1)]);
    expect(moveShape(f, 1, 0, 2).points).toEqual([
      { x: 1, z: 2, out: { x: 1, z: 0 } },
      { x: 5, z: 2 },
      { x: 5, z: 6 },
      { x: 1, z: 6 },
    ]);
    expect(moveShape(f, 0, 0.5, 0)).toEqual({ y: 0.5 });
    expect(moveShape(f, 0, 0, 0)).toEqual({});
  });

  it("rotates points around the pivot and turns their handles", () => {
    // 90° counterclockwise seen from above takes +x to -z.
    const { points } = rotateShape(freeform([{ x: 1, z: 0, out: { x: 1, z: 0 } }, { x: 0, z: 1 }, { x: -1, z: 0 }]), { x: 0, z: 0 }, 90);
    expect(points).toEqual([
      { x: 0, z: -1, out: { x: 0, z: -1 } },
      { x: 1, z: 0 },
      { x: 0, z: 1 },
    ]);
  });

  it("mirrors as a true mirror image, keeping the point order, and twice restores it exactly", () => {
    const f = freeform([
      { x: 0.25, z: 0 },
      { x: 3.1, z: 0.4, out: { x: 1, z: 1 } },
      { x: 2.3, z: 3.7, in: { x: 0.5, z: -0.2 } },
    ]);
    for (const axis of ["x", "z"] as const) {
      const once = { ...f, ...mirrorAcross([f], axis)[f.id] } as Freeform;
      const b = boundsOf([f]);
      const sum = axis === "x" ? b.minX + b.maxX : b.minZ + b.maxZ;
      const reflected = footprint(f).map((q) => (axis === "x" ? { x: sum - q.x, z: q.z } : { x: q.x, z: sum - q.z }));
      footprint(once).forEach((q, i) => expect(Math.hypot(q.x - reflected[i].x, q.z - reflected[i].z)).toBeLessThan(0.01));
      const twice = { ...once, ...mirrorAcross([once], axis)[f.id] };
      expect(twice).toEqual(f);
    }
  });

  it("stretches points and handles with its frame when resized", () => {
    const f = freeform([{ x: 0, z: 0, out: { x: 2, z: 0 } }, ...square.slice(1)]);
    const { points } = resizeShape(f, handleFrame(f), { x: 4, z: 2, width: 8, depth: 4 });
    expect(points![0]).toEqual({ x: 0, z: 0, out: { x: 4, z: 0 } });
    expect(points![2]).toEqual({ x: 8, z: 4 });
  });

  it("offsets concave room walls robustly: an L's walls hold its inside, and a thin sliver has none", () => {
    const l = freeform(
      [
        { x: 0, z: 0 },
        { x: 6, z: 0 },
        { x: 6, z: 2 },
        { x: 2, z: 2 },
        { x: 2, z: 6 },
        { x: 0, z: 6 },
      ],
      { kind: "room" },
    );
    const { outer, inner, walls } = roomWalls(l, 0.1);
    expect(pointInRings(outer, { x: 6.05, z: 1 })).toBe(true);
    expect(pointInRings(inner, { x: 1, z: 4 })).toBe(true);
    expect(pointInRings(walls, { x: 1, z: 4 })).toBe(false);
    expect(pointInRings(walls, { x: 1.95, z: 4 })).toBe(true);
    // The inside corner of the L is outside everything.
    expect(pointInRings(outer, { x: 4, z: 4 })).toBe(false);
    const sliver = freeform([{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 0.15 }], { kind: "room" });
    expect(roomWalls(sliver, 0.1).inner).toEqual([]);
    // No area at all (the Pen's preview with the cursor on the point just placed): no rings, so nothing to draw.
    const flat = freeform([{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 0 }], { kind: "room" });
    expect(roomWalls(flat, 0.1).walls).toEqual([]);
  });
});

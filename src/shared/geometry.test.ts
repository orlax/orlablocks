import { describe, expect, it } from "vitest";
import {
  boundsOf,
  footprint,
  footprintBounds,
  handleFrame,
  mirrorAcross,
  lineProblem,
  orientedFrame,
  polyline,
  reversePoints,
  verticalRange,
  rotateAround,
  sampleOutline,
  splitEdge,
  toFreeformPoints,
  toShapeLocal,
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
import { CURVE_SEGMENTS, type Box, type Cylinder, type FootPoint, type Freeform, type Line, type LinePoint } from "./scene.types";

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

  it("offsets concave room walls inward robustly: an L's walls hold its inside, and a thin sliver has none", () => {
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
    // The walls grow inward from the outline, 0.2 m by default.
    const { outer, inner, walls } = roomWalls(l);
    expect(pointInRings(outer, { x: 5.95, z: 1 })).toBe(true);
    expect(pointInRings(outer, { x: 6.05, z: 1 })).toBe(false);
    expect(pointInRings(inner, { x: 1, z: 4 })).toBe(true);
    expect(pointInRings(walls, { x: 1, z: 4 })).toBe(false);
    expect(pointInRings(walls, { x: 1.9, z: 4 })).toBe(true);
    expect(pointInRings(walls, { x: 1.7, z: 4 })).toBe(false);
    // The inside corner of the L is outside everything.
    expect(pointInRings(outer, { x: 4, z: 4 })).toBe(false);
    // A thicker wall reaches further in.
    expect(pointInRings(roomWalls({ ...l, wall: 0.5 }).walls, { x: 1.7, z: 4 })).toBe(true);
    const sliver = freeform([{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 0.3 }], { kind: "room" });
    expect(roomWalls(sliver).inner).toEqual([]);
    // No area at all (the Pen's preview with the cursor on the point just placed): no rings, so nothing to draw.
    const flat = freeform([{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 0 }], { kind: "room" });
    expect(roomWalls(flat).walls).toEqual([]);
  });
});

describe("convert and split (point editing)", () => {
  const freeform = (points: FootPoint[]): Freeform => ({
    id: "freeform_1",
    type: "freeform",
    kind: "volume",
    y: 0,
    height: 1,
    color: "almost-white",
    points,
    createdBy: "human",
  });
  /** The distance from `p` to the nearest of the outline's densely sampled points. */
  const offOutline = (points: FootPoint[], p: { x: number; z: number }) => {
    const dense = points.flatMap((a, i) => {
      const b = points[(i + 1) % points.length];
      const c1 = a.out ? { x: a.x + a.out.x, z: a.z + a.out.z } : a;
      const c2 = b.in ? { x: b.x + b.in.x, z: b.z + b.in.z } : b;
      return Array.from({ length: 400 }, (_, k) => {
        const t = k / 400;
        const u = 1 - t;
        return {
          x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
          z: u * u * u * a.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * b.z,
        };
      });
    });
    return Math.min(...dense.map((q) => Math.hypot(q.x - p.x, q.z - p.z)));
  };

  it("converts a box to its 4 world corners, and a sided cylinder to its corners", () => {
    expect(toFreeformPoints(box({ x: 1, z: 1, width: 4, depth: 2 }))).toEqual([
      { x: -1, z: 0 },
      { x: 3, z: 0 },
      { x: 3, z: 2 },
      { x: -1, z: 2 },
    ]);
    const hex: Cylinder = { ...box({ width: 4, depth: 4, rotation: 30 }), type: "cylinder", sides: 6 };
    const points = toFreeformPoints(hex);
    expect(points).toHaveLength(6);
    expect(points.every((p) => !p.in && !p.out)).toBe(true);
    points.forEach((p, i) => {
      const f = footprint(hex)[i];
      expect(p.x).toBeCloseTo(f.x, 2);
      expect(p.z).toBeCloseTo(f.z, 2);
    });
  });

  it("converts a smooth cylinder to 4 smooth points that still trace its ellipse", () => {
    const oval: Cylinder = { ...box({ x: 5, z: -2, width: 10, depth: 6, rotation: 20 }), type: "cylinder" };
    const points = toFreeformPoints(oval);
    expect(points).toHaveLength(4);
    expect(points.every((p) => p.in && p.out && p.in.x === -p.out.x && p.in.z === -p.out.z)).toBe(true);
    // Every sampled point of the free-form lies on the true ellipse (within a couple of centimeters).
    for (const p of sampleOutline(points).polygon) {
      const l = toShapeLocal(oval, p);
      expect(Math.abs(Math.hypot(l.x / 5, l.z / 3) - 1)).toBeLessThan(0.005);
    }
  });

  it("splits a straight edge with a corner, and a curved one without changing the shape", () => {
    const square: FootPoint[] = [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 4, z: 4 },
      { x: 0, z: 4 },
    ];
    expect(splitEdge(square, 0, 0.25)[1]).toEqual({ x: 1, z: 0 });
    expect(splitEdge(square, 3, 0.5)).toHaveLength(5);
    expect(splitEdge(square, 3, 0.5)[4]).toEqual({ x: 0, z: 2 });

    const circle = toFreeformPoints({ ...box({ width: 8, depth: 8 }), type: "cylinder" });
    const split = splitEdge(circle, 3, 0.3);
    expect(split).toHaveLength(5);
    expect(split[4].in && split[4].out).toBeTruthy();
    for (const p of sampleOutline(split).polygon) expect(offOutline(circle, p)).toBeLessThan(0.01);
  });
});

describe("oriented frames (the Figma-style rotate pivot)", () => {
  const l: FootPoint[] = [
    { x: 0, z: 0 },
    { x: 6, z: 0 },
    { x: 6, z: 2 },
    { x: 2, z: 2 },
    { x: 2, z: 6 },
    { x: 0, z: 6 },
  ];
  const shape: Freeform = { id: "freeform_1", type: "freeform", kind: "volume", y: 0, height: 1, color: "almost-white", points: l, createdBy: "human" };

  it("is the axis-aligned bounds at 0", () => {
    expect(orientedFrame([shape], 0)).toEqual({ x: 3, z: 3, width: 6, depth: 6, rotation: 0 });
  });

  it("turns with the shapes around its center, so turning back lands where it started", () => {
    const start = orientedFrame([shape], 0);
    const turned = { ...shape, ...rotateAround([shape], start, 30)[shape.id] } as Freeform;
    const frame = orientedFrame([turned], 30);
    expect(frame.x).toBeCloseTo(start.x, 1);
    expect(frame.z).toBeCloseTo(start.z, 1);
    expect(frame.width).toBeCloseTo(6, 1);
    // The axis-aligned bounds' center moved (that was the drift); the turned frame's didn't.
    const b = boundsOf([turned]);
    expect(Math.hypot((b.minX + b.maxX) / 2 - 3, (b.minZ + b.maxZ) / 2 - 3)).toBeGreaterThan(0.2);
    const back = { ...turned, ...rotateAround([turned], frame, -30)[shape.id] } as Freeform;
    back.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(l[i].x, 1);
      expect(p.z).toBeCloseTo(l[i].z, 1);
    });
  });

  it("resizes a free-form along a turned frame's own axes", () => {
    const turned = { ...shape, ...rotateAround([shape], { x: 3, z: 3 }, 90)[shape.id] } as Freeform;
    const frame = orientedFrame([turned], 90);
    // Twice as wide along the frame's own x, which after a 90° turn runs along world -z.
    const patch = resizeShape(turned, frame, { x: frame.x, z: frame.z, width: frame.width * 2, depth: frame.depth });
    const b = boundsOf([{ ...turned, ...patch } as Freeform]);
    expect(b.maxZ - b.minZ).toBeCloseTo(12, 1);
    expect(b.maxX - b.minX).toBeCloseTo(6, 1);
  });
});

describe("lines", () => {
  const arc: LinePoint[] = [
    { x: 0, y: 2, z: 0, out: { x: 1, y: 2, z: 0 } },
    { x: 6, y: 0, z: 0, in: { x: -1, y: 1, z: 0 } },
    { x: 6, y: 0, z: 4 },
  ];
  const line: Line = { id: "line_1", type: "line", color: "black", points: arc, thickness: 3, dashed: false, arrow: "end", createdBy: "human" };

  it("samples curved edges in 3D and ends on the last point; a curve's bounds include its bulge", () => {
    const path = polyline(line);
    expect(path).toHaveLength(CURVE_SEGMENTS + 2);
    expect(path.at(-1)).toEqual({ x: 6, y: 0, z: 4 });
    const [bottom, top] = verticalRange(line);
    expect(bottom).toBe(0);
    expect(top).toBeGreaterThan(2);
    expect(boundsOf([line]).maxX).toBe(6);
  });

  it("moves (up too), turns and mirrors through its points, keeping their y", () => {
    const up = moveShape(line, 1, 0.5, 0).points as LinePoint[];
    expect(up[0]).toEqual({ x: 1, y: 2.5, z: 0, out: { x: 1, y: 2, z: 0 } });
    const turned = rotateShape(line, { x: 0, z: 0 }, 90).points as LinePoint[];
    // +x turns to -z (counterclockwise seen from above); y stays.
    expect(turned[1]).toMatchObject({ x: 0, y: 0, z: -6 });
    expect(turned[0].out).toEqual({ x: 0, y: 2, z: -1 });
    const mirrored = mirrorAcross([line], "x")[line.id].points as LinePoint[];
    expect(mirrored[0]).toEqual({ x: 6, y: 2, z: 0, out: { x: -1, y: 2, z: 0 } });
    const twice = mirrorAcross([{ ...line, points: mirrored }], "x")[line.id].points;
    expect(twice).toEqual(arc);
  });

  it("reverses without changing the path's shape", () => {
    const back = reversePoints(arc);
    expect(back[0]).toEqual({ x: 6, y: 0, z: 4 });
    expect(back[1]).toEqual({ x: 6, y: 0, z: 0, out: { x: -1, y: 1, z: 0 } });
    expect(back[2]).toEqual({ x: 0, y: 2, z: 0, in: { x: 1, y: 2, z: 0 } });
    expect(polyline({ ...line, points: back }).reverse()[5].y).toBeCloseTo(polyline(line)[5].y);
  });

  it("finds what's wrong with a path: too few points, or neighbors in the same place", () => {
    expect(lineProblem(arc)).toBeNull();
    expect(lineProblem(arc.slice(0, 1))).toMatch(/at least 2/);
    expect(lineProblem([arc[0], { x: 0, y: 2, z: 0 }])).toMatch(/points 0 and 1 are in the same place/);
    // A line may cross itself.
    expect(lineProblem([{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 4 }, { x: 4, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }])).toBeNull();
  });

  it("splits a curved 3D edge without changing the path", () => {
    const split = splitEdge(arc, 0, 0.5);
    expect(split).toHaveLength(4);
    const mid = polyline({ ...line, points: arc })[CURVE_SEGMENTS / 2];
    expect(split[1].x).toBeCloseTo(mid.x);
    expect(split[1].y).toBeCloseTo(mid.y);
    expect(split[1].in!.y).toBeDefined();
  });
});

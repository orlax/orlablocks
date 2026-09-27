import { describe, expect, it } from "vitest";
import type { Box, Cylinder, Freeform, Ramp } from "./scene.types";
import { spiralPoints } from "./geometry";
import { hitMesh, prism, rampMesh, shapeMesh, type Mesh } from "./mesh";

/** Every edge is used by exactly two triangles, once in each direction: closed, and consistently wound. */
function watertight(m: Mesh): boolean {
  const edges = new Map<string, number>();
  for (let i = 0; i < m.indices.length; i += 3) {
    const t = [m.indices[i], m.indices[i + 1], m.indices[i + 2]];
    for (let k = 0; k < 3; k++) {
      const key = `${t[k]}>${t[(k + 1) % 3]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of edges) {
    const [a, b] = key.split(">");
    if (n !== 1 || edges.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** The signed volume (divergence theorem): positive when every triangle faces outward. */
function volume(m: Mesh): number {
  const p = m.positions;
  let v = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i] * 3, m.indices[i + 1] * 3, m.indices[i + 2] * 3];
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

const base = { y: 0, rotation: 0, color: "almost-white", createdBy: "human" } as const;
const box = (patch: Partial<Box>): Box => ({ ...base, id: "box_1", type: "box", kind: "volume", x: 0, z: 0, width: 4, depth: 2, height: 3, ...patch });

describe("prism", () => {
  it("extrudes a square into a closed, outward-facing box, in either winding", () => {
    const square = [
      { x: 0, z: 0 },
      { x: 2, z: 0 },
      { x: 2, z: 2 },
      { x: 0, z: 2 },
    ];
    for (const ring of [square, [...square].reverse()]) {
      const m = prism([ring], 0, 3)!;
      expect(watertight(m)).toBe(true);
      expect(volume(m)).toBeCloseTo(12);
    }
  });

  it("extrudes a region with a hole (a ring of walls)", () => {
    const outer = [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 4, z: 4 },
      { x: 0, z: 4 },
    ];
    const inner = [
      { x: 1, z: 3 },
      { x: 3, z: 3 },
      { x: 3, z: 1 },
      { x: 1, z: 1 },
    ];
    const m = prism([outer, inner], 0, 2)!;
    expect(watertight(m)).toBe(true);
    expect(volume(m)).toBeCloseTo((16 - 4) * 2);
  });

  it("gives nothing for an outline with no area", () => {
    expect(prism([[{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 0 }]], 0, 1)).toBeNull();
  });
});

describe("shapeMesh", () => {
  it("makes a volume its footprint extruded to its height", () => {
    const { body, floor } = shapeMesh(box({}));
    expect(watertight(body!)).toBe(true);
    expect(volume(body!)).toBeCloseTo(4 * 2 * 3);
    expect(floor).toBeNull();
  });

  it("makes a room's walls grow inward from the footprint, as thick as its wall", () => {
    const room = box({ kind: "room", width: 10, depth: 8 });
    expect(volume(shapeMesh(room).body!)).toBeCloseTo((80 - 9.6 * 7.6) * 3);
    const thick = box({ kind: "room", width: 10, depth: 8, wall: 1 });
    expect(volume(shapeMesh(thick).body!)).toBeCloseTo((80 - 8 * 6) * 3);
    expect(watertight(shapeMesh(thick).body!)).toBe(true);
    expect(shapeMesh(thick).floor).not.toBeNull();
  });

  it("makes a room too narrow for an inside a solid block", () => {
    const narrow = box({ kind: "room", width: 0.3, depth: 5 });
    expect(volume(shapeMesh(narrow).body!)).toBeCloseTo(0.3 * 5 * 3);
  });

  it("builds a curved free-form room's walls watertight", () => {
    const blob: Freeform = {
      id: "freeform_1",
      type: "freeform",
      kind: "room",
      y: 0,
      height: 3,
      color: "almost-white",
      createdBy: "human",
      points: [
        { x: 0, z: 0, out: { x: 2, z: -2 } },
        { x: 8, z: 0 },
        { x: 8, z: 6 },
        { x: 4, z: 3 },
        { x: 0, z: 6 },
      ],
    };
    const { body } = shapeMesh(blob);
    expect(watertight(body!)).toBe(true);
    expect(volume(body!)).toBeGreaterThan(0);
  });

  it("builds a smooth cylinder watertight, close to a true cylinder's volume", () => {
    const c: Cylinder = { ...base, id: "cylinder_1", type: "cylinder", kind: "volume", x: 0, z: 0, width: 4, depth: 4, height: 2 };
    const { body } = shapeMesh(c);
    expect(watertight(body!)).toBe(true);
    expect(volume(body!) / (Math.PI * 4 * 2)).toBeCloseTo(1, 2);
  });
});

describe("hitMesh", () => {
  it("is in world space: turned, moved and raised with the shape, a room's floor at its elevation", () => {
    const m = hitMesh(box({ kind: "room", x: 10, z: 5, y: 2, rotation: 90, width: 4, depth: 2 }))!;
    expect(m.min[0]).toBeCloseTo(9);
    expect(m.max[0]).toBeCloseTo(11);
    expect(m.min[2]).toBeCloseTo(3);
    expect(m.max[2]).toBeCloseTo(7);
    expect(m.min[1]).toBeCloseTo(2);
    expect(m.max[1]).toBeCloseTo(5);
  });
});

describe("taper and bevel", () => {
  it("tapers a box to a pyramid and a cylinder to a cone, watertight, with the right volume", () => {
    const pyramid = shapeMesh(box({ taper: 1 })).body!;
    expect(watertight(pyramid)).toBe(true);
    expect(volume(pyramid)).toBeCloseTo((4 * 2 * 3) / 3);
    const half = shapeMesh(box({ taper: 0.5 })).body!;
    expect(watertight(half)).toBe(true);
    // A frustum: h/3 × (A1 + A2 + √(A1·A2)), top 2 × 1.
    expect(volume(half)).toBeCloseTo((3 / 3) * (8 + 2 + 4));
    const c: Cylinder = { ...base, id: "cylinder_1", type: "cylinder", kind: "volume", x: 0, z: 0, width: 4, depth: 4, height: 3, sides: 6, taper: 1 };
    const cone = shapeMesh(c).body!;
    expect(watertight(cone)).toBe(true);
    // A hexagon on a radius-2 circle: area 3√3/2 × r².
    expect(volume(cone)).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * 4);
  });

  it("rounds a tall smooth cylinder's top into a dome", () => {
    const c: Cylinder = { ...base, id: "cylinder_1", type: "cylinder", kind: "volume", x: 0, z: 0, width: 4, depth: 4, height: 5, bevel: 1 };
    const dome = shapeMesh(c).body!;
    expect(watertight(dome)).toBe(true);
    // A cylinder of radius 2 and height 3, with a half-sphere of radius 2 on top.
    const expected = Math.PI * 4 * 3 + (2 / 3) * Math.PI * 8;
    expect(volume(dome) / expected).toBeCloseTo(1, 1);
    // Its top is still at its height, and at the center.
    const ys = dome.positions.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeCloseTo(5);
  });

  it("rounds a long box evenly, into a ridge at bevel 1", () => {
    const ridge = shapeMesh(box({ width: 10, depth: 2, height: 4, bevel: 1 })).body!;
    expect(watertight(ridge)).toBe(true);
    expect(volume(ridge)).toBeGreaterThan(0);
    expect(volume(ridge)).toBeLessThan(10 * 2 * 4);
  });

  it("tapers and bevels a concave free-form toward its centroid, watertight", () => {
    const blob: Freeform = {
      id: "freeform_1",
      type: "freeform",
      kind: "volume",
      y: 0,
      height: 6,
      color: "almost-white",
      createdBy: "human",
      taper: 0.6,
      bevel: 0.5,
      points: [
        { x: 0, z: 0 },
        { x: 10, z: 0, out: { x: 2, z: 3 } },
        { x: 9, z: 8 },
        { x: 5, z: 5 },
        { x: 0, z: 8 },
      ],
    };
    const hill = shapeMesh(blob).body!;
    expect(watertight(hill)).toBe(true);
    expect(volume(hill)).toBeGreaterThan(0);
    const all = shapeMesh({ ...blob, taper: 1, bevel: 1 }).body!;
    expect(watertight(all)).toBe(true);
  });
});

describe("ramps", () => {
  const ramp = (patch: Partial<Ramp>): Ramp => ({
    id: "ramp_1",
    type: "ramp",
    kind: "volume",
    width: 2,
    base: "solid",
    color: "almost-white",
    createdBy: "human",
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 6, y: 3, z: 0 },
    ],
    ...patch,
  });

  it("builds the same stairs whatever way they point (a length that isn't round reads every riser right)", () => {
    const aligned = rampMesh(ramp({ step: 0.25 }))!;
    const turned = rampMesh(ramp({ step: 0.25, points: [{ x: 0.4, y: 0, z: 1.5 }, { x: 5.6, y: 3, z: -1.5 }] }))!;
    expect(watertight(turned)).toBe(true);
    expect(turned.indices.length).toBe(aligned.indices.length);
    // The turned run is 6.0033 long, so its volume is that much bigger.
    expect(volume(turned) / volume(aligned)).toBeCloseTo(6.0033 / 6, 3);
  });

  it("makes a straight smooth ramp a watertight wedge", () => {
    const m = rampMesh(ramp({}))!;
    expect(watertight(m)).toBe(true);
    // A wedge 6 long, 2 wide, 3 tall, over a 0.02 m slab under all of it.
    expect(volume(m)).toBeCloseTo(0.5 * 6 * 3 * 2 + 6 * 2 * 0.02, 1);
  });

  it("makes stairs: 12 steps of 0.25, each flat, the last flush with the top", () => {
    const m = rampMesh(ramp({ step: 0.25 }))!;
    expect(watertight(m)).toBe(true);
    // Each step is a full tread high, so the stairs hold more than the wedge under them.
    const wedge = 0.5 * 6 * 3 * 2 + 6 * 2 * 0.02;
    expect(volume(m)).toBeGreaterThan(wedge);
    const ys = new Set<number>();
    for (let i = 1; i < m.positions.length; i += 3) ys.add(Math.round(m.positions[i] * 100) / 100);
    expect([...ys].filter((y) => y > 0).length).toBe(12);
    expect(Math.max(...ys)).toBeCloseTo(3);
  });

  it("goes either way: a stair walked down is the same solid", () => {
    const up = rampMesh(ramp({ step: 0.25 }))!;
    const down = rampMesh(ramp({ step: 0.25, points: [{ x: 6, y: 3, z: 0 }, { x: 0, y: 0, z: 0 }] }))!;
    expect(volume(down)).toBeCloseTo(volume(up));
  });

  it("floats as a slab, with a landing, around a corner", () => {
    const m = rampMesh(
      ramp({
        base: "floating",
        step: 0.2,
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 4, y: 1.6, z: 0 },
          { x: 6, y: 1.6, z: 0 },
          { x: 6, y: 3.2, z: -4 },
        ],
      }),
    )!;
    expect(watertight(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
  });

  it("curves: a spiral stair's mesh is watertight", () => {
    const m = rampMesh(ramp({ step: 0.2, width: 1.2, points: spiralPoints({ x: 0, z: 0, radius: 2, turn: 360, y: 0, rise: 3 }) }))!;
    expect(watertight(m)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
  });
});

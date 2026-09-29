import { describe, expect, it } from "vitest";
import { boundsOf, freeformCenter, localFootprint, rotateShape, tiltShape, toWorld3 } from "./geometry";
import { arrayLayout } from "./arrays";
import { expandInstance, setDefinitions } from "./entities";
import { apply, orientationYXZ, rotX, rotY, rotZ, tiltXZ, toXZY, toYXZ, mul } from "./rotation3";
import type { ArrayNode, Box, Freeform, Instance, Shape } from "./scene.types";

const base = { rotation: 0, color: "almost-white", createdBy: "human" } as const;
const close = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, digits = 1) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
};
const at = <T extends Shape>(s: T, patch: object) => ({ ...s, ...patch }) as T;

describe("rotations (14.4)", () => {
  it("splits orientations back into their angles", () => {
    const o = toYXZ(orientationYXZ(30, 20, -10));
    expect(o.yaw).toBeCloseTo(30);
    expect(o.pitch).toBeCloseTo(20);
    expect(o.roll).toBeCloseTo(-10);
    const t = toXZY(mul(tiltXZ(15, 25), rotY(40)));
    expect(t.pitch).toBeCloseTo(15);
    expect(t.roll).toBeCloseTo(25);
    expect(t.turn).toBeCloseTo(40);
  });

  it("matches toWorld3: a tilted box's corner is its orientation applied to it", () => {
    const b: Box = { ...base, id: "box_1", type: "box", kind: "volume", x: 3, z: 1, y: 2, width: 2, depth: 4, height: 6, rotation: 30, pitch: 20, roll: 10 };
    const corner = { x: 1, y: 6, z: 2 };
    const m = orientationYXZ(30, 20, 10);
    const r = apply(m, { x: corner.x, y: corner.y - 3, z: corner.z });
    close(toWorld3(b, corner), { x: 3 + r.x, y: 2 + 3 + r.y, z: 1 + r.z }, 6);
  });
});

describe("tiltShape (14.4)", () => {
  const box: Box = { ...base, id: "box_1", type: "box", kind: "volume", x: 4, z: 0, y: 0, width: 2, depth: 2, height: 2 };
  const pivot = { x: 0, y: 0, z: 0 };

  it("orbits a box's center around the pivot and tilts it, and back", () => {
    const tilted = at(box, tiltShape(box, rotZ(30), pivot));
    // Its center (4, 1, 0) turns 30° around z: up and west.
    const c = apply(rotZ(30), { x: 4, y: 1, z: 0 });
    expect(tilted.x).toBeCloseTo(c.x, 1);
    expect(tilted.y + 1).toBeCloseTo(c.y, 1);
    expect(tilted.roll).toBe(30);
    // Back again, to within the 2 decimals every step rounds to.
    const back = at(tilted, tiltShape(tilted, rotZ(-30), pivot));
    expect(back).toMatchObject({ z: 0, roll: 0, pitch: 0, rotation: 0 });
    close(back, box, 1);
  });

  it("tilts a group rigidly: every corner goes where the rotation takes it", () => {
    const a: Box = { ...box, rotation: 45 };
    const b: Box = { ...box, id: "box_2", x: -3, z: 2, rotation: 10, pitch: 5 };
    const m = mul(rotX(20), rotZ(-15));
    for (const s of [a, b]) {
      const t = at(s, tiltShape(s, m, pivot));
      for (const corner of [{ x: 1, y: 0, z: 1 }, { x: -1, y: 2, z: 1 }]) close(toWorld3(t, corner), apply(m, toWorld3(s, corner)));
    }
  });

  it("tilts a free-form around its outline's center, and bakes a turn into its points", () => {
    const f: Freeform = { ...base, id: "freeform_1", type: "freeform", kind: "volume", y: 0, height: 2, points: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 2 }, { x: 0, z: 2 }] };
    const tilted = at(f, { pitch: 20 });
    expect(freeformCenter(tilted)).toEqual({ x: 2, z: 1 });
    expect(localFootprint(tilted)[0]).toEqual({ x: -2, z: -1 });
    // Turning a tilted free-form turns it rigidly: a corner goes where a turn around y takes it.
    const turned = at(tilted, rotateShape(tilted, { x: 0, z: 0 }, 90));
    close(toWorld3(turned, { x: localFootprint(turned)[0].x, y: 2, z: localFootprint(turned)[0].z }), apply(rotY(90), toWorld3(tilted, { x: -2, y: 2, z: -1 })));
  });

  it("tilts an instance's shapes with it, around its pivot", () => {
    setDefinitions({ post: [{ ...base, id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 1, height: 4 }] });
    const inst: Instance = { ...base, id: "instance_1", type: "instance", entity: "post", x: 10, y: 0, z: 0, roll: 90 };
    const shapes = expandInstance(inst).filter((n) => n.type === "box") as Shape[];
    // Lying on its side toward -x: 4 m long along x, from x 6 to 10.
    const b = boundsOf(shapes);
    expect(b.minX).toBeCloseTo(6);
    expect(b.maxX).toBeCloseTo(10);
    expect(b.maxY - b.minY).toBeCloseTo(1);
  });

  it("tilts an array's items about its anchor, and a turn of a tilted array turns it rigidly", () => {
    const ring: ArrayNode = { id: "array_1", type: "array", entities: [{ entity: "post" }], layout: { type: "circle", x: 0, y: 0, z: 0, radius: 10, count: 4 }, pitch: 30, createdBy: "human" };
    const items = arrayLayout(ring).items;
    // The item at the north (-z) rises: pitch 30 leans +z down, so -z goes up.
    const north = items.find((i) => i.z < -1)!;
    expect(north.y).toBeCloseTo(5, 1);
    expect(north.pitch ?? 0).not.toBe(0);
    const turned = at(ring, rotateShape(ring, { x: 0, z: 0 }, 90));
    const before = items.map((i) => apply(rotY(90), i));
    const after = arrayLayout(turned).items;
    for (const p of before) expect(after.some((q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 0.1)).toBe(true);
  });
});

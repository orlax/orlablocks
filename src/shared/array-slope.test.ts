import { describe, it, expect } from "vitest";
import { arrayItems, arrayLayout, circleDistribution, scaleArray, mirrorArray, rotateArray, tiltArray } from "./arrays";
import { apply, orientationYXZ, tiltXZ, mul, rotY, rotZ } from "./rotation3";
import { MAX_ARRAY_ITEMS, NodeSchema, type ArrayNode, type PathLayout } from "./scene.types";
const array = (layout: ArrayNode["layout"], extra: Partial<ArrayNode> = {}): ArrayNode => ({ id: "array_1", type: "array", entities: [{ entity: "rail" }], createdBy: "human", layout, ...extra });
const path = (points: PathLayout["points"], extra: Partial<PathLayout> = {}): PathLayout => ({ type: "path", points, place: "count", count: 3, slope: true, ...extra });
const axis = (item: ReturnType<typeof arrayItems>[number]) => apply(orientationYXZ(item.rotation, item.pitch ?? 0, item.roll ?? 0), { x: 1, y: 0, z: 0 });
const near = (v: { x: number; y: number; z: number }, expected: number[]) => [v.x, v.y, v.z].forEach((n, i) => expect(n).toBeCloseTo(expected[i], 3));

describe("19.5 circle spacing", () => {
  it("fits maximum 3D centerline spacing, endpoints and old count behavior", () => {
    const l = { type: "circle", x: 0, y: 2, z: 0, radius: 2, count: 4 } as const;
    expect(arrayItems(array(l)).map(p => [p.x, p.y, p.z, p.rotation])).toEqual([[2,2,0,90],[0,2,-2,180],[-2,2,0,270],[0,2,2,0]]);
    for (const sweep of [0.01, 101, 296, 360]) for (const rise of [0, 12, -12]) {
      const layout = { ...l, sweep, rise, place: "spacing" as const, spacing: 1.95 };
      const d = circleDistribution(layout), items = arrayItems(array(layout));
      expect(d.spacing).toBeLessThanOrEqual(1.95);
      expect(items.length).toBe(d.count);
      expect(items[0]).toMatchObject({ x: 2, y: 2, z: 0 });
      expect(items.at(-1)!.y).toBeCloseTo(sweep === 360 ? 2 + rise * (d.count - 1) / d.count : 2 + rise, 2);
      if (sweep === 360) expect(items.at(-1)).not.toMatchObject({ x: 2, z: 0 });
      else expect(items.length).toBeGreaterThanOrEqual(2);
    }
  });
  it("caps before allocation and scales spacing with geometry; mirrors rise and skips reversibly", () => {
    const layout = { type: "circle", x: 0, y: 0, z: 0, radius: 1e10, place: "spacing", spacing: 0.1 } as const;
    const result = arrayLayout(array(layout));
    expect(result.total).toBeGreaterThan(MAX_ARRAY_ITEMS);
    expect(result.made).toBe(MAX_ARRAY_ITEMS);
    const a = array({ ...layout, radius: 4, sweep: 101, rise: 6, spacing: 1 }, { skip: [1, 999] });
    const scaled = { ...a, ...scaleArray(a, 2, { x: 0, y: 0, z: 0 }) } as ArrayNode;
    expect(circleDistribution(scaled.layout as typeof layout).count).toBe(circleDistribution(a.layout as typeof layout).count);
    const b = { ...a, ...mirrorArray(a, "x", 0) } as ArrayNode;
    expect(NodeSchema.parse(b)).toMatchObject({ skip: expect.arrayContaining([999]) });
    const restored = { ...b, ...mirrorArray(b, "x", 0) } as ArrayNode;
    expect(arrayItems(restored)).toEqual(arrayItems(a));
    const original = arrayItems(a).map(p => [-p.x, p.y, p.z].join(",")).sort();
    expect(arrayItems(b).map(p => [p.x, p.y, p.z].join(",")).sort()).toEqual(original);
  });
});

describe("19.5 slope frames", () => {
  it("aligns uphill/downhill/reversed paths and retains legacy upright poses", () => {
    for (const sign of [1,-1]) {
      const l = path([{x:0,y:0,z:0},{x:4,y:sign * 3,z:0}]);
      for (const p of arrayItems(array(l))) near(axis(p), [0.8, sign * 0.6, 0]);
      for (const p of arrayItems(array({ ...l, points: [...l.points].reverse() }))) near(axis(p), [-0.8, -sign * 0.6, 0]);
      for (const p of arrayItems(array({ ...l, slope: undefined }))) expect([p.pitch,p.roll]).toEqual([undefined,undefined]);
    }
  });
  it("handles vertical, repeated, zero length, corners, and outgoing distance joints deterministically", () => {
    for (const p of arrayItems(array(path([{x:0,y:0,z:0},{x:0,y:4,z:0}])))) near(axis(p),[0,1,0]);
    const zero = arrayItems(array(path([{x:2,y:3,z:4},{x:2,y:3,z:4}])));
    expect(zero.every(p => p.rotation === 0 && !p.pitch && !p.roll)).toBe(true);
    const points = [{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:3,z:0},{x:4,y:3,z:0}];
    const items = arrayItems(array(path(points, { place: "corners" })));
    near(axis(items[1]), [Math.SQRT1_2, Math.SQRT1_2, 0]);
    expect(items.every(p => Object.values(p).every(v => typeof v !== "number" || Number.isFinite(v)))).toBe(true);
    const joint = arrayItems(array(path(points.slice(0,3), {count:8})))[4];
    near(axis(joint), [0,1,0]);
  });
  it("composes local rotation offsets and world tilt, rotates/copies without losing slope", () => {
    const a = array(path([{x:0,y:0,z:0},{x:4,y:3,z:0}]), { rotation:30, pitch:20, roll:10 });
    const expected = mul(tiltXZ(20,10), mul(rotZ(Math.atan2(3,4)*180/Math.PI),rotY(30)));
    near(axis(arrayItems(a)[0]), Object.values(apply(expected,{x:1,y:0,z:0})));
    expect(NodeSchema.parse(a)).toMatchObject({layout:{slope:true}});
    const b = { ...a, ...tiltArray(a, tiltXZ(10,0), {x:0,y:0,z:0}) } as ArrayNode;
    near(axis(arrayItems(b)[0]),Object.values(apply(tiltXZ(10,0),axis(arrayItems(a)[0]))));
    const turned = { ...a, pitch:undefined, roll:undefined, ...rotateArray(a, {x:0,z:0},90) } as ArrayNode;
    near(axis(arrayItems(turned)[0]),Object.values(apply(rotY(90),axis(arrayItems({...a,pitch:undefined,roll:undefined})[0]))));
  });
});

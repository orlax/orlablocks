import { describe, expect, it } from "vitest";
import { boundsOf, scaleShape, transformShape } from "./geometry";
import { arrayLayout } from "./arrays";
import { expandInstance, setDefinitions } from "./entities";
import type { ArrayNode, Box, Freeform, Instance, Line, Ramp, Shape } from "./scene.types";

const base = { rotation: 0, color: "almost-white", createdBy: "human" } as const;
const room: Box = { ...base, id: "box_1", type: "box", kind: "room", x: 4, z: 2, y: 1, width: 6, depth: 4, height: 3 };
const origin = { x: 0, y: 0, z: 0 };
const at = (s: Shape, patch: object) => ({ ...s, ...patch }) as Shape;

describe("scaleShape (14.3)", () => {
  it("scales a room's place, size, height and walls about the pivot", () => {
    expect(scaleShape(room, 2, origin)).toEqual({ x: 8, z: 4, y: 2, width: 12, depth: 8, height: 6, wall: 0.4 });
    expect(scaleShape({ ...room, wall: 0.5 }, 0.5, { x: 4, y: 1, z: 2 })).toEqual({ x: 4, z: 2, y: 1, width: 3, depth: 2, height: 1.5, wall: 0.25 });
  });

  it("keeps angles and fractions: a tilted, tapered volume keeps its pitch and taper", () => {
    const hill: Box = { ...room, kind: "volume", taper: 0.5, bevel: 0.3, pitch: 10, rotation: 30 };
    const patch = scaleShape(hill, 3, origin);
    expect(patch).not.toHaveProperty("taper");
    expect(patch).not.toHaveProperty("pitch");
    expect(patch).not.toHaveProperty("wall");
  });

  it("scales a free-form's points and handles, a line's 3D points and a ramp's width and steps", () => {
    const f: Freeform = { ...base, id: "freeform_1", type: "freeform", kind: "volume", y: 0, height: 2, points: [{ x: 1, z: 0, out: { x: 1, z: 1 } }, { x: 0, z: 1 }, { x: -1, z: 0 }] };
    expect(scaleShape(f, 2, origin)).toMatchObject({ height: 4, points: [{ x: 2, z: 0, out: { x: 2, z: 2 } }, { x: 0, z: 2 }, { x: -2, z: 0 }] });
    const line: Line = { ...base, id: "line_1", type: "line", color: "red", thickness: 3, dashed: false, arrow: "none", points: [{ x: 1, y: 1, z: 1, out: { x: 0, y: 1, z: 0 } }, { x: 2, y: 2, z: 2 }] };
    const scaledLine = scaleShape(line, 2, origin);
    expect(scaledLine).toEqual({ points: [{ x: 2, y: 2, z: 2, out: { x: 0, y: 2, z: 0 } }, { x: 4, y: 4, z: 4 }] });
    const ramp: Ramp = { ...base, id: "ramp_1", type: "ramp", kind: "volume", width: 2, step: 0.25, base: "solid", points: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 0 }] };
    expect(scaleShape(ramp, 2, origin)).toEqual({ points: [{ x: 0, y: 0, z: 0 }, { x: 8, y: 4, z: 0 }], width: 4, step: 0.5 });
  });

  it("scales an instance's entity through its scale, about the pivot", () => {
    setDefinitions({ post: [{ ...base, id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 1, height: 2 }] });
    const inst: Instance = { ...base, id: "instance_1", type: "instance", entity: "post", x: 3, y: 0, z: 0 };
    const patch = scaleShape(inst, 2, origin);
    expect(patch).toEqual({ x: 6, y: 0, z: 0, scale: 2 });
    const shapes = expandInstance(at(inst, patch) as Instance).filter((n) => n.type === "box");
    expect(boundsOf(shapes as Shape[])).toMatchObject({ minX: 5, maxX: 7, maxY: 4 });
  });

  it("scales an array's layout and its items' scale", () => {
    const ring: ArrayNode = { id: "array_1", type: "array", entities: [{ entity: "post" }], layout: { type: "circle", x: 2, y: 0, z: 0, radius: 5, count: 4, rise: 2 }, jitter: 0.5, createdBy: "human" };
    const patch = scaleShape(ring, 2, origin);
    expect(patch).toEqual({ layout: { type: "circle", x: 4, y: 0, z: 0, radius: 10, count: 4, rise: 4 }, scale: 2, jitter: 1 });
    expect(arrayLayout(at(ring, patch) as ArrayNode).items).toHaveLength(4);
  });

  it("transforms in one go: scale, then turn, then mirror about the pivot, then move", () => {
    const box: Box = { ...room, kind: "volume", x: 1, z: 0, y: 0, width: 1, depth: 1, height: 1 };
    const patch = transformShape(box, { pivot: origin, scale: 2, rotate: 90, mirror: "z", move: { dx: 10, dy: 0, dz: 0 } });
    // Scaled to x 2, turned to z -2 (north), mirrored on z to +2, then moved 10 east.
    expect(patch).toMatchObject({ x: 10, z: 2, width: 2, depth: 2, height: 2 });
  });
});

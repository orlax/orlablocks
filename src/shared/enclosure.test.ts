import { describe, expect, it } from "vitest";
import { checkEnclosure } from "./enclosure";
import type { Box, Cylinder, SceneNode } from "./scene.types";

const base = { rotation: 0, color: "almost-white", createdBy: "agent" } as const;
const room: Box = { ...base, id: "box_1", type: "box", kind: "room", x: 0, z: 0, y: 0, width: 20, depth: 20, height: 6, wall: 1 };

describe("checkEnclosure (14.7)", () => {
  it("finds a closed room sealed up to its walls' top, with the air's volume", () => {
    const r = checkEnclosure([room], { from: { x: 0, y: 2, z: 0 }, cell: 1 });
    expect(r.sealed).toBe(true);
    if (r.sealed) expect(r.air.volume).toBeGreaterThan(18 * 18 * 5);
  });

  it("finds the door a room leaks through, where it is and how wide", () => {
    const door: Box = { ...base, id: "box_2", type: "box", kind: "hole", x: 0, z: 10, y: 0, width: 3, depth: 4, height: 3 };
    const nodes: SceneNode[] = [{ id: "group_1", type: "group", createdBy: "agent" }, { ...room, parent: "group_1" }, { ...door, parent: "group_1" }];
    const r = checkEnclosure(nodes, { from: { x: 0, y: 1, z: 0 }, cell: 1 });
    expect(r.sealed).toBe(false);
    if (r.sealed) return;
    const g = r.escapes[0];
    expect(Math.abs(g.at.x)).toBeLessThan(2);
    expect(g.at.z).toBeGreaterThan(7);
    expect(g.width).toBeGreaterThanOrEqual(2);
    expect(g.width).toBeLessThanOrEqual(4);
    expect(g.y[1]).toBeLessThanOrEqual(4);
    expect(g.between).toEqual(["box_1"]);
  });

  it("finds the gaps in a ring of tapered peaks above where they overlap, and none below", () => {
    // Eight cones round a 40 m circle, 16 m wide at the base (overlapping there) and pointed at 40 m.
    const peaks: Cylinder[] = Array.from({ length: 8 }, (_, n) => {
      const a = (n / 8) * 2 * Math.PI;
      return { ...base, id: `cylinder_${n + 1}`, type: "cylinder", kind: "volume", x: Math.cos(a) * 20, z: Math.sin(a) * 20, y: 0, width: 18, depth: 18, height: 40, taper: 1 };
    });
    const low = checkEnclosure(peaks, { from: { x: 0, y: 1, z: 0 }, band: [0, 4], cell: 1 });
    expect(low.sealed).toBe(true);
    const high = checkEnclosure(peaks, { from: { x: 0, y: 1, z: 0 }, band: [0, 30], cell: 1 });
    expect(high.sealed).toBe(false);
    if (!high.sealed) {
      expect(high.escapes.length).toBeGreaterThanOrEqual(2);
      expect(high.escapes[0].between.length).toBe(2);
    }
  });

  it("refuses a start inside a solid", () => {
    expect(() => checkEnclosure([{ ...room, kind: "volume" }], { from: { x: 0, y: 1, z: 0 } })).toThrow(/inside box_1/);
  });
});

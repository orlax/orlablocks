import { describe, expect, it } from "vitest";
import { sectionAt } from "./slice";
import type { Box, Cylinder } from "./scene.types";

const base = { rotation: 0, color: "almost-white", createdBy: "agent" } as const;

describe("sectionAt (14.7)", () => {
  // Eight cones round a 40 m circle, overlapping at their bases and pointed at 40 m.
  const peaks: Cylinder[] = Array.from({ length: 8 }, (_, n) => {
    const a = (n / 8) * 2 * Math.PI;
    return { ...base, id: `cylinder_${n + 1}`, type: "cylinder", kind: "volume", x: Math.cos(a) * 20, z: Math.sin(a) * 20, y: 0, width: 18, depth: 18, height: 40, taper: 1 };
  });

  it("cuts each solid into an outline at the height, with no gaps where they overlap", () => {
    const low = sectionAt(peaks, 2);
    expect(low.outlines).toHaveLength(8);
    expect(low.outlines[0].loops[0].length).toBeGreaterThan(10);
    expect(low.gaps).toEqual([]);
  });

  it("reports the gaps between neighbours higher up, narrowest first, up to the width asked", () => {
    const high = sectionAt(peaks, 16, { gap: 10 });
    expect(high.gaps.length).toBe(8);
    expect(high.gaps[0].width).toBeGreaterThan(0);
    expect(high.gaps[0].between[0]).toMatch(/^cylinder_/);
    expect(sectionAt(peaks, 16, { gap: 0.5 }).gaps).toEqual([]);
  });

  it("gives a room its outer and inner walls, and holes as holes", () => {
    const room: Box = { ...base, id: "box_1", type: "box", kind: "room", x: 0, z: 0, y: 0, width: 10, depth: 10, height: 4 };
    const door: Box = { ...base, id: "box_2", type: "box", kind: "hole", x: 0, z: 5, y: 0, width: 2, depth: 1, height: 2 };
    const s = sectionAt([room, door], 1);
    expect(s.outlines.find((o) => o.owner === "box_1")!.loops).toHaveLength(2);
    expect(s.outlines.find((o) => o.owner === "box_2")!.hole).toBe(true);
  });
});

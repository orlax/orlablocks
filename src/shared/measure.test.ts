import { describe, expect, it } from "vitest";
import { measurePath } from "./measure";
import type { Box, Line } from "./scene.types";

const base = { rotation: 0, color: "almost-white", createdBy: "agent" } as const;
const line = (points: { x: number; y: number; z: number }[]): Line => ({ ...base, id: "line_1", type: "line", color: "red", thickness: 3, dashed: false, arrow: "none", points });

describe("measurePath (14.8)", () => {
  it("measures length, time, slopes and climb rates, and the stretches over the limits", () => {
    // 100 m flat, then 30 m up over 40 m on the ground (50 m along).
    const route = line([{ x: 0, y: 10, z: 0 }, { x: 100, y: 10, z: 0 }, { x: 140, y: 40, z: 0 }]);
    const m = measurePath([route], "line_1", { speed: 10, climbRate: 5, maxSlope: 30 });
    expect(m.length).toBeCloseTo(150, 0);
    expect(m.time).toBeCloseTo(15, 0);
    expect(m.height).toEqual([10, 40]);
    expect((m.steepestClimb as { value: number }).value).toBeCloseTo(36.87, 0);
    // 30 m up in 5 s is 6 m/s: over the 5 allowed, on the climb only.
    expect((m.fastestClimb as { value: number }).value).toBeCloseTo(6, 0);
    const over = m.overClimbRate as { from: { along: number } }[];
    expect(over).toHaveLength(1);
    expect(over[0].from.along).toBeGreaterThanOrEqual(99);
    expect(m.overSlope as unknown[]).toHaveLength(1);
  });

  it("finds the tightest clearance, against what, and the stretches closer than the probe", () => {
    const pillar: Box = { ...base, id: "box_1", type: "box", kind: "volume", x: 50, z: 3, y: 0, width: 2, depth: 2, height: 30 };
    const route = line([{ x: 0, y: 10, z: 0 }, { x: 100, y: 10, z: 0 }]);
    const m = measurePath([pillar, route], "line_1", { probe: 5 });
    const c = m.clearance as { tightest: number; against: string };
    // The pillar's near face is at z 2: 2 m from the path.
    expect(c.tightest).toBeCloseTo(2, 0);
    expect(c.against).toBe("box_1");
    expect((m.underProbe as unknown[]).length).toBe(1);
    const through = measurePath([pillar, line([{ x: 0, y: 10, z: 3 }, { x: 100, y: 10, z: 3 }])], "line_1", { probe: 1 });
    expect(through.clearance).toMatchObject({ tightest: 0, inside: true });
  });
});

import { describe, expect, it } from "vitest";
import type { SceneNode } from "../shared/scene.types";
import { gridLayout, labelTag, labelTargets, pairLayout, legendLine, lookAt, niceLength, planFrame, planSize, sheetLayout, stripLayout, walkFrames } from "./renders";

const box = (id: string, x: number, z: number, extra: Partial<SceneNode> = {}): SceneNode =>
  ({ id, type: "box", kind: "volume", x, z, y: 0, width: 2, depth: 2, height: 3, rotation: 0, color: "stone", createdBy: "human", ...extra }) as SceneNode;
const group = (id: string, extra: Partial<SceneNode> = {}): SceneNode => ({ id, type: "group", createdBy: "human", ...extra }) as SceneNode;

describe("render planning", () => {
  it("tags labels A..Z, then AA", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(labelTag)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
  });

  it("labels the top level at each node's top center, without notes, lines or hidden nodes", () => {
    const nodes: SceneNode[] = [
      group("group_1", { name: "crypt" }),
      box("box_1", 0, 0, { parent: "group_1" }),
      box("box_2", 10, 0),
      box("box_3", 20, 0, { hidden: true }),
      { id: "note_1", type: "note", x: 0, y: 0, z: 0, text: "", color: "yellow", status: "open", createdBy: "human" } as SceneNode,
    ];
    const targets = labelTargets(nodes, undefined, new Set(["box_3"]));
    expect(targets).toEqual([
      { tag: "A", id: "group_1", name: "crypt", anchor: { x: 0, y: 3, z: 0 } },
      { tag: "B", id: "box_2", anchor: { x: 10, y: 3, z: 0 } },
    ]);
    expect(legendLine(targets[0])).toBe('A = group_1 "crypt"');
    // One group asked for: what's in it.
    expect(labelTargets(nodes, ["group_1"], new Set()).map((t) => t.id)).toEqual(["box_1"]);
  });

  it("labels only the groups past the limit", () => {
    const many = Array.from({ length: 45 }, (_, i) => box(`box_${i + 1}`, i * 3, 0));
    const nodes = [...many, group("group_1"), box("box_99", 0, 20, { parent: "group_1" })];
    expect(labelTargets(nodes, undefined, new Set()).map((t) => t.id)).toEqual(["group_1"]);
  });

  it("fits a plan around its bounds with a margin, widened to the image", () => {
    const b = { minX: 0, maxX: 20, minY: 0, maxY: 3, minZ: 0, maxZ: 10 };
    const f = planFrame(b, 2);
    expect(f.x).toBe(10);
    expect(f.z).toBe(5);
    expect(f.width / f.height).toBeCloseTo(2, 6);
    expect(f.width).toBeCloseTo(22.4, 6);
    expect(planSize(b, 1000)).toEqual({ width: 1000, height: 556 });
    expect(planSize({ ...b, maxX: 100 }, 1000)).toEqual({ width: 1000, height: 556 });
    expect(planSize({ ...b, maxX: 5, maxZ: 20 }, 1000)).toEqual({ width: 556, height: 1000 });
  });

  it("lays out a sheet in four 4:3 panels, and a strip in rows of up to four 16:9 frames", () => {
    const sheet = sheetLayout(1024);
    expect(sheet).toMatchObject({ width: 1024, height: 768 });
    expect(sheet.cells[3]).toEqual({ x: 512, y: 384, width: 512, height: 384 });
    const strip = stripLayout(5, 1024);
    expect(strip.cells).toHaveLength(5);
    expect(strip.cells[4]).toEqual({ x: 0, y: 144, width: 256, height: 144 });
    expect(strip).toMatchObject({ width: 1024, height: 288 });
    expect(stripLayout(3, 900)).toMatchObject({ width: 900, height: 168 });
  });

  it("looks from an eye at a point: north is 0, west 90, up is +", () => {
    expect(lookAt({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -5 })).toEqual({ yaw: 0, pitch: 0 });
    expect(lookAt({ x: 0, y: 0, z: 0 }, { x: -5, y: 0, z: 0 }).yaw).toBeCloseTo(90, 6);
    expect(lookAt({ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 0 }).pitch).toBeCloseTo(45, 6);
  });

  it("spaces a walk's frames along the path, looking ahead", () => {
    const frames = walkFrames(
      [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: -10 },
        { x: 10, y: 0, z: -10 },
      ],
      5,
    );
    expect(frames.map((f) => [f.feet.x, f.feet.z])).toEqual([
      [0, 0],
      [0, -5],
      [0, -10],
      [5, -10],
      [10, -10],
    ]);
    expect(frames[0].yaw).toBeCloseTo(0, 6);
    expect(frames[4].yaw).toBeCloseTo(270, 6);
    // A stair up looks a bit up.
    const up = walkFrames([{ x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: -4 }], 3);
    expect(up[0].pitch).toBeGreaterThan(0);
    expect(up[0].pitch).toBeLessThan(45);
  });

  it("rounds scale lengths to 1, 2 or 5 times a power of ten", () => {
    expect([0.8, 1.6, 4, 9, 13, 30, 80].map(niceLength)).toEqual([1, 2, 5, 10, 10, 20, 100]);
  });

  it("lays re-checked shots out as rows of before and now, and a model sheet as a near-square grid", () => {
    expect(pairLayout([16 / 9], 1024)).toEqual({ width: 1024, height: 288, rows: [{ before: { x: 0, y: 0, width: 512, height: 288 }, now: { x: 512, y: 0, width: 512, height: 288 } }] });
    // Six 16:9 rows would be 1728 tall: all shrink to fit 1024.
    const six = pairLayout(Array(6).fill(16 / 9), 1024);
    expect(six.height).toBeLessThanOrEqual(1024);
    expect(six.rows[5].now.x).toBe(six.width / 2);
    expect(gridLayout(1, 1024)).toMatchObject({ width: 1024, height: 768 });
    const nine = gridLayout(9, 1200);
    expect(nine.cells).toHaveLength(9);
    expect(nine.cells[8]).toEqual({ x: 800, y: 600, width: 400, height: 300 });
    expect(Math.max(gridLayout(24, 1024).width, gridLayout(24, 1024).height)).toBeLessThanOrEqual(1024);
  });
});

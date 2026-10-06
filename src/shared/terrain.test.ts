import { describe, expect, it } from "vitest";
import { evaluateTerrain, terrainSources, terrainProblems } from "./terrain";
import type { Box, Group, SceneNode, Terrain } from "./scene.types";

export const terrain: Terrain = { id: "terrain_1", type: "terrain", x: 0, z: 0, y: 0, width: 32, depth: 32, resolution: 129, source: "group_1", color: "green", createdBy: "human" };
export const group: Group = { id: "group_1", type: "group", createdBy: "human" };
export const box: Box = { id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 8, depth: 8, height: 4, rotation: 0, color: "green", createdBy: "human", parent: group.id, terrain: { operation: "raise", fade: 4 } };
const sample = (nodes: SceneNode[], x: number, z = 0) => evaluateTerrain(terrain, nodes).heights[Math.round((z + 16) * 4) * 129 + Math.round((x + 16) * 4)];

describe("terrain heightfield", () => {
  it("starts at the base, keeps plateau interiors, fades outward and has finite support", () => {
    const nodes = [group, box];
    expect(evaluateTerrain({ ...terrain, y: -3 }, []).min).toBe(-3);
    expect(sample(nodes, 0)).toBe(4);
    expect(sample(nodes, 4)).toBe(4);
    expect(sample(nodes, 6)).toBe(2);
    expect(sample(nodes, 8)).toBe(0);
    expect(sample([group, { ...box, terrain: { operation: "raise", fade: 0 } }], 4.25)).toBe(0);
  });
  it("samples actual tapered and beveled geometry", () => {
    expect(sample([group, { ...box, taper: 1 }], 0)).toBeCloseTo(4);
    expect(sample([group, { ...box, taper: 1 }], 2)).toBeCloseTo(2);
    expect(sample([group, { ...box, bevel: 1 }], 3)).toBeGreaterThan(0);
    expect(sample([group, { ...box, bevel: 1 }], 3)).toBeLessThan(4);
  });
  it("applies Set and Lower sequentially, including negative ground", () => {
    const cut: Box = { ...box, id: "box_2", y: -5, height: 2, terrain: { operation: "lower", fade: 4 } };
    expect(sample([group, box, cut], 0)).toBe(-3);
    expect(sample([group, cut, box], 0)).toBe(4);
    expect(sample([group, box, { ...cut, y: 0, terrain: { operation: "set", fade: 2 } }], 0)).toBe(2);
  });
  it("uses depth-first outliner order rather than global flat list order", () => {
    const nested: Group = { ...group, id: "group_2", parent: group.id };
    const later: Box = { ...box, id: "box_2" };
    const nodes = [group, nested, later, { ...box, parent: nested.id }];
    expect(terrainSources(terrain, nodes).map((n) => n.id)).toEqual([box.id, later.id]);
    expect(terrainSources(terrain, [group, { ...nested, hidden: true }, later, { ...box, parent: nested.id }])).toEqual([later]);
  });
  it("rejects overlapping ownership, rooms and terrain dependencies", () => {
    expect(terrainProblems([group, box, terrain])).toEqual([]);
    expect(terrainProblems([group, { ...box, kind: "room" }, terrain])[0]).toContain("volume");
    expect(terrainProblems([group, box, terrain, { ...terrain, id: "terrain_2" }])[0]).toContain("overlaps");
    expect(terrainProblems([group, { ...terrain, parent: group.id }])[0]).toContain("sources");
  });
  it("invalidates cached terrain on source movement and reordering", () => {
    const first = evaluateTerrain(terrain, [group, box]);
    expect(evaluateTerrain(terrain, [group, box])).toBe(first);
    expect(sample([group, { ...box, x: 12 }], 0)).toBe(0);
  });
});

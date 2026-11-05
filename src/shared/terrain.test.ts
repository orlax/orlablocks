import { rayMeshFirst } from "./ray";
import { holeScope, holeWarnings } from "./holes";
import { describe, expect, it } from "vitest";
import { evaluateTerrain, terrainSources, terrainProblems, previewTerrain, rayTerrainFirst } from "./terrain";
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

describe("free-form and ramp terrain inputs", () => {
  it("keeps a concave cutout clear and extends the nearest boundary height into its fade", () => {
    const shape: import("./scene.types").Freeform = { id: "freeform_1", type: "freeform", kind: "volume", parent: group.id, points: [{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 4, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 4 }, { x: -4, z: 4 }], y: 0, height: 4, color: "green", createdBy: "human", terrain: { operation: "raise", fade: 2 } };
    expect(terrainProblems([group, shape, terrain])).toEqual([]);
    expect(sample([group, shape], -2, 2)).toBe(4);
    expect(sample([group, shape], 3, 3)).toBe(0);
    expect(sample([group, shape], 1, 2)).toBeCloseTo(2);
  });
  it("samples a curved free-form's upper surface", () => {
    const shape: import("./scene.types").Freeform = { id: "freeform_1", type: "freeform", kind: "volume", parent: group.id, points: [{ x: -4, z: -4, out: { x: 2, z: -2 } }, { x: 4, z: -4, in: { x: -2, z: -2 } }, { x: 4, z: 4 }, { x: -4, z: 4 }], y: 0, height: 4, color: "green", createdBy: "human" };
    expect(sample([group, shape], 0, -4.5)).toBe(4);
    expect(sample([group, shape], 0, -6)).toBe(0);
  });
  it("retains ramp width and rising boundary heights, with finite outward fade", () => {
    const ramp: import("./scene.types").Ramp = { id: "ramp_1", type: "ramp", kind: "volume", parent: group.id, points: [{ x: -4, y: 2, z: 0 }, { x: 4, y: 6, z: 0 }], width: 4, base: "solid", color: "green", createdBy: "human", terrain: { operation: "set", fade: 2 } };
    expect(sample([group, ramp], 0)).toBeCloseTo(4);
    expect(sample([group, ramp], 2, 2)).toBeCloseTo(5);
    expect(sample([group, ramp], 2, 3)).toBeCloseTo(2.5);
    expect(sample([group, ramp], 2, 4)).toBe(0);
    expect(terrainProblems([group, ramp, terrain])).toEqual([]);
    expect(terrainProblems([group, { ...ramp, step: 0.2 }, terrain])[0]).toContain("smooth ramps");
    const curved = { ...ramp, points: [{ x: -4, y: 2, z: -2, out: { x: 2, z: 4 } }, { x: 4, y: 6, z: -2, in: { x: -2, z: 4 } }] };
    expect(sample([group, curved], 0, 1)).toBeCloseTo(4, 1);
    expect(sample([group, { ...ramp, points: [{ x: -4, y: -6, z: 0 }, { x: 4, y: -2, z: 0 }] }], 0)).toBeCloseTo(-4);
  });
});

it("reuses canonical heights across cosmetic edits, invalidates geometry and keeps previews separate", () => {
  const nodes = [group, box];
  const t = { ...terrain, id: "cache-terrain", resolution: 257 as const };
  const first = evaluateTerrain(t, nodes);
  expect(evaluateTerrain({ ...t, name: "renamed", color: "blue" }, [group, { ...box, color: "red", locked: true, name: "input" }])).toBe(first);
  const preview = evaluateTerrain(previewTerrain(t, true), nodes);
  expect(preview.heights).toHaveLength(129 * 129);
  expect(evaluateTerrain(t, nodes).heights).toHaveLength(257 * 257);
  expect(evaluateTerrain({ ...t, y: 10 }, nodes).min).toBe(10);
  expect(evaluateTerrain(t, [group, { ...box, hidden: true }]).max).toBe(0);
});

it("picks the exact canonical triangles by cell traversal, from above, below, edges and oblique rays", () => {
  const t = { ...terrain, id: "pick-terrain" }, field = evaluateTerrain(t, [group, box]);
  const mesh = { ...field.mesh, min: [-16, field.min, -16] as [number, number, number], max: [16, field.max, 16] as [number, number, number] };
  const rays: import("./ray").Ray[] = [
    { origin: { x: 0, y: 10, z: 0 }, dir: { x: 0, y: -2, z: 0 } },
    { origin: { x: 0, y: -10, z: 0 }, dir: { x: 0, y: 1, z: 0 } },
    { origin: { x: 16, y: 10, z: 16 }, dir: { x: 0, y: -1, z: 0 } },
    { origin: { x: 20, y: 10, z: 0 }, dir: { x: 0, y: -1, z: 0 } },
  ];
  for (let i = 0; i < 30; i++) rays.push({ origin: { x: -22 + i * 1.5, y: 12, z: -20 }, dir: { x: Math.sin(i) * 0.7, y: -1, z: 1.2 } });
  for (const ray of rays) {
    const exact = rayMeshFirst(ray, mesh), hit = rayTerrainFirst(ray, t, field);
    if (!exact) expect(hit).toBeNull();
    else { expect(hit?.t).toBeCloseTo(exact.t, 7); expect(hit?.normal.y).toBeCloseTo(exact.normal.y, 7); }
  }
});

describe("terrain holes", () => {
  const hole: Box = { ...box, id: "hole", kind: "hole", y: -1, height: 2, width: 4, depth: 4, terrain: undefined };
  const at = (f: ReturnType<typeof evaluateTerrain>, x: number, z: number) => f.surface[Math.floor((z + 16) * 4) * 128 + Math.floor((x + 16) * 4)];
  it("cuts final surface intersections, leaves heights intact and picks through empty cells", () => {
    const f = evaluateTerrain(terrain, [group, hole]);
    expect(at(f, .125, .125)).toBe(0);
    expect(at(f, 3, 0)).toBe(1);
    expect(f.heights.every((h) => h === 0)).toBe(true);
    expect(f.mesh.indices.length).toBe((128 * 128 - 16 * 16) * 6);
    expect(rayTerrainFirst({ origin: { x: .125, y: 10, z: .125 }, dir: { x: 0, y: -1, z: 0 } }, terrain, f)).toBeNull();
    expect(rayTerrainFirst({ origin: { x: 4.125, y: 10, z: .125 }, dir: { x: 0, y: -1, z: 0 } }, terrain, f)?.t).toBe(10);
    for (const y of [2, -4]) expect(evaluateTerrain(terrain, [group, { ...hole, y }]).surface.includes(0)).toBe(false);
    expect(evaluateTerrain(terrain, [group, box, hole]).surface.includes(0)).toBe(false);
    expect(evaluateTerrain(terrain, [group, hole, box]).surface.includes(0)).toBe(false);
  });
  it("owns only visible source holes, including nested holes, and invalidates mask caches", () => {
    const nested = { ...group, id: "nested", parent: group.id };
    expect(evaluateTerrain(terrain, [group, { ...hole, parent: undefined }]).surface.includes(0)).toBe(false);
    expect(evaluateTerrain(terrain, [group, nested, { ...hole, parent: nested.id }]).surface.includes(0)).toBe(true);
    expect(evaluateTerrain(terrain, [group, { ...nested, hidden: true }, { ...hole, parent: nested.id }]).surface.includes(0)).toBe(false);
    expect(evaluateTerrain(terrain, [group, { ...hole, hidden: true }]).surface.includes(0)).toBe(false);
    const f = evaluateTerrain(terrain, [group, hole]);
    expect(evaluateTerrain({ ...terrain, color: "red" }, [group, { ...hole, color: "red" }])).toBe(f);
    expect(at(evaluateTerrain(terrain, [group, { ...hole, x: 8 }]), .125, .125)).toBe(1);
    expect(terrainProblems([terrain, group, hole])).toEqual([]);
    expect(holeScope([terrain, group, box, hole], hole)).toEqual([]);
    expect(holeWarnings([terrain, group, box, hole])).toEqual([]);
    expect(terrainProblems([terrain, group, { ...hole, pitch: 10 }])[0]).toContain("tilted");
  });
  it("uses the cutter's true tapered and beveled cross-section, yaw and concave footprint", () => {
    const wide = { ...hole, y: -1, height: 2, width: 8, depth: 8 };
    expect(at(evaluateTerrain(terrain, [group, wide]), 3, 0)).toBe(0);
    expect(at(evaluateTerrain(terrain, [group, { ...wide, taper: 1 }]), 3, 0)).toBe(1);
    const top = { ...wide, y: -1.9, bevel: 1 };
    expect(at(evaluateTerrain(terrain, [group, top]), 3.9, 0)).toBe(1);
    expect(at(evaluateTerrain(terrain, [group, { ...hole, width: 8, depth: 1, rotation: 90 }]), 0, 3)).toBe(0);
    const concave: import("./scene.types").Freeform = { id: "concave", type: "freeform", kind: "hole", parent: group.id, y: -1, height: 2, color: "red", createdBy: "human", points: [{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 4, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 4 }, { x: -4, z: 4 }] };
    const f = evaluateTerrain(terrain, [group, concave]);
    expect(at(f, -2, 2)).toBe(0); expect(at(f, 2, 2)).toBe(1);
    const cylinder: import("./scene.types").Cylinder = { ...hole, type: "cylinder" };
    expect(at(evaluateTerrain(terrain, [group, cylinder]), .125, .125)).toBe(0);
  });
  it("documents sub-cell center sampling, unions cuts and supports an entirely empty surface", () => {
    const tiny = { ...hole, width: .05, depth: .05 };
    expect(evaluateTerrain(terrain, [group, tiny]).surface.includes(0)).toBe(false);
    expect(evaluateTerrain(terrain, [group, { ...tiny, x: .125, z: .125 }]).surface.includes(0)).toBe(true);
    const f = evaluateTerrain(terrain, [group, hole, { ...hole, id: "other", x: 1 }]);
    expect(f.surface.filter((v) => !v).length).toBe(20 * 16);
    const empty = evaluateTerrain(terrain, [group, { ...hole, width: 40, depth: 40 }]);
    expect(empty.mesh.indices).toHaveLength(0); expect(Number.isFinite(empty.min)).toBe(true);
    expect(previewTerrain({ ...terrain, resolution: 513 }, true, [group, hole]).resolution).toBe(513);
  });
  it("cuts only the intersecting portion of a slope after height operations", () => {
    const ramp: import("./scene.types").Ramp = { id: "ramp", type: "ramp", parent: group.id, points: [{ x: -4, y: 1, z: 0 }, { x: 4, y: 5, z: 0 }], width: 4, kind: "volume", base: "solid", color: "green", createdBy: "human" };
    const f = evaluateTerrain(terrain, [group, ramp, { ...hole, width: 8, depth: 4, y: 2, height: 2 }]);
    expect(at(f, -3, 0)).toBe(1); expect(at(f, .125, 0)).toBe(0); expect(at(f, 3, 0)).toBe(1);
  });
});

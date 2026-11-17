import { afterEach, describe, expect, it } from "vitest";
import { expandNodes, setDefinitions } from "./entities";
import { boundsOf } from "./geometry";
import { cutsFloor, cutters, holeScope, holeWarnings } from "./holes";
import { migrateProjectCuts } from "./migrations/cutTags";
import type { Box, SceneNode } from "./scene.types";
const box = (id: string, patch: Partial<Box> = {}): Box => ({ id, type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 10, depth: 8, height: 3, rotation: 0, color: "white", createdBy: "human", ...patch });
const group = (id: string, parent?: string): SceneNode => ({ id, type: "group", parent, createdBy: "human" });
afterEach(() => setDefinitions({}));
describe("cut tags", () => {
  it("cuts matching solids across arbitrary groups, including top-level holes; never inherits parent tags", () => {
    const hole = box("h", { kind: "hole", cutTags: ["lobby", "roof"] });
    const nodes = [group("g"), group("nested", "g"), hole, box("wall", { parent: "nested", cutTags: ["lobby"] }), box("roof", { cutTags: ["roof"] }), box("unmatched", { parent: "g" })];
    expect(holeScope(nodes, hole).map((n) => n.id)).toEqual(["wall", "roof"]);
    expect(cutters(nodes).get("wall")?.map((h) => h.id)).toEqual(["h"]);
    expect(holeScope(nodes, { ...hole, parent: "nested" })).toEqual(holeScope(nodes, hole));
    expect(holeScope(nodes, { ...hole, cutTags: [] })).toEqual([]);
    expect(holeScope(nodes, { ...hole, cutTags: undefined })).toEqual([]);
  });
  it("requires geometric overlap and never cuts holes; floor rules stay unchanged", () => {
    const h = box("h", { kind: "hole", cutTags: ["x"] });
    const nodes = [h, box("solid", { cutTags: ["x"] }), box("far", { x: 100, cutTags: ["x"] }), box("h2", { kind: "hole", cutTags: ["x"] })];
    expect(holeScope(nodes, h).map((n) => n.id)).toEqual(["solid", "far"]);
    expect([...cutters(nodes).keys()]).toEqual(["solid"]);
    expect(cutsFloor(h, box("room", { kind: "room" }))).toBe(false);
    expect(cutsFloor({ ...h, y: -0.1 }, box("room", { kind: "room" }))).toBe(true);
    expect(holeWarnings([box("h", { kind: "hole" })])[0]).toContain("no cut tags");
    expect(holeWarnings([h])[0]).toContain("no solids");
  });
  it("matches the full scope and bounds scan across edits, keeping order and excluding terrain-source holes", () => {
    const hole = box("h1", { kind: "hole", pitch: 15, cutTags: ["b", "a", "b"] });
    const other = box("h2", { kind: "hole", cutTags: ["a"] });
    const terrainHole = { ...other, id: "terrainHole", parent: "nested" };
    const nodes: SceneNode[] = [
      box("both", { cutTags: ["a", "b"] }), box("a", { width: 4, cutTags: ["a"] }),
      box("b", { x: 24, cutTags: ["b"] }),
      hole, other, terrainHole, group("nested", "source"), group("source"),
      { id: "terrain", type: "terrain", x: 0, y: 0, z: 0, width: 20, depth: 20, color: "white", resolution: 129, source: "source", createdBy: "human" },
    ];
    function check(scene: SceneNode[], holes: Box[]) {
      const expected = new Map<string, Box[]>();
      for (const h of holes) {
        const a = boundsOf([h]);
        for (const target of holeScope(scene, h)) {
          const b = boundsOf([target]);
          if (a.minX >= b.maxX || b.minX >= a.maxX || a.minY >= b.maxY || b.minY >= a.maxY || a.minZ >= b.maxZ || b.minZ >= a.maxZ) continue;
          expected.set(target.id, [...(expected.get(target.id) ?? []), h]);
        }
      }
      expect([...cutters(scene)]).toEqual([...expected]);
    }
    check(nodes, [hole, other, terrainHole]);
    const moved = { ...hole, x: 24, cutTags: ["b"] };
    check(nodes.map((n) => n === hole ? moved : n), [moved, other, terrainHole]);
    check(nodes, [hole, other, terrainHole]);
  });
  it("namespaces internal definition tags per placement while external placement tags cross groups", () => {
    setDefinitions({ door: [box("solid", { cutTags: ["internal"] }), box("untouched"), box("hole", { kind: "hole", cutTags: ["internal"] })] });
    const i = (id: string): SceneNode => ({ id, type: "instance", entity: "door", x: 0, y: 0, z: 0, rotation: 0, createdBy: "human" });
    const expanded = expandNodes([i("a"), i("b")]);
    expect(cutters(expanded).get("a/solid")?.map((h) => h.id)).toEqual(["a/hole"]);
    const external = expandNodes([{ ...i("a"), cutTags: ["lobby"] } as SceneNode, box("wall", { cutTags: ["lobby"] })]);
    expect(cutters(external).get("wall")?.map((h) => h.id)).toEqual(["a/hole"]);
    expect(cutters(external).has("a/untouched")).toBe(false);
  });
  it("keeps migrated sets independent when geometry from two scenes is pasted together", () => {
    const scene = [group("g"), box("wall", { parent: "g" }), box("hole", { kind: "hole", parent: "g" })];
    const converted = migrateProjectCuts({}, { a: scene, b: scene }, "example");
    const pasted = converted.scenes.b.map((n) => ({ ...n, id: `copy-${n.id}`, ...(n.parent ? { parent: `copy-${n.parent}` } : {}) }));
    const cuts = cutters([...converted.scenes.a, ...pasted]);
    expect(cuts.get("wall")?.map((h) => h.id)).toEqual(["hole"]);
    expect(cuts.get("copy-wall")?.map((h) => h.id)).toEqual(["copy-hole"]);
  });
  it("migrates nested definitions, scenes and arrays with exact eligible scope including distant solids", () => {
    const defs = { door: [box("frame"), box("hole", { kind: "hole" })] };
    const nodes: SceneNode[] = [group("building"), group("room", "building"), box("wall", { parent: "room" }), box("far", { x: 100, parent: "room" }), { id: "a", type: "array", parent: "room", entities: [{ entity: "door" }], layout: { type: "circle", x: 0, y: 0, z: 0, radius: 5, count: 3 }, createdBy: "human" }];
    const result = migrateProjectCuts(defs, { scene: nodes });
    const migrated = result.scenes.scene;
    const expanded = expandNodes(migrated);
    const h = expanded.find((n) => n.id === "a/0/hole") as Box;
    expect(holeScope(expanded, h).map((n) => n.id)).toContain("far");
    expect(migrated.find((n) => n.id === "a")).toHaveProperty("cutTagParts");
    expect(migrated.map((n) => n.id)).toEqual(nodes.map((n) => n.id));
  });
});

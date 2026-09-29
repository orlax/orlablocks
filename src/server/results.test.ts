import { beforeEach, describe, expect, it } from "vitest";
import { setDefinitions } from "../shared/entities";
import type { ArrayNode, OpenScene, SceneNode } from "../shared/scene.types";
import { describeScene, findNodes, MAX_MATCHES } from "./outline";
import { compactNode, compactNodes, MAX_ITEM_LINES } from "./results";

/** A slab 2 × 2 × 0.5 around its pivot. */
const SLAB: SceneNode[] = [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 2, depth: 2, height: 0.5, rotation: 0, color: "gray", createdBy: "human" }];

const ring = (count: number, fields: Partial<ArrayNode> = {}): ArrayNode => ({
  id: "array_1",
  type: "array",
  entities: [{ entity: "slab" }],
  layout: { type: "circle", x: 0, y: 3, z: 0, radius: 10, count },
  createdBy: "agent",
  ...fields,
});
const line: SceneNode = {
  id: "line_1",
  type: "line",
  points: Array.from({ length: 30 }, (_, i) => ({ x: i, y: 0, z: 0 })),
  color: "red",
  thickness: 2,
  dashed: false,
  arrow: "none",
  createdBy: "agent",
};
const open: OpenScene = { project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "S" } };
const scene = (nodes: SceneNode[]) => ({ nodes, selection: [], view: { focus: { x: 0, z: 0 }, yaw: 45, bounds: { x: -30, z: -20, width: 60, depth: 40 } } });

beforeEach(() => setDefinitions({ slab: SLAB }));

describe("compact results", () => {
  it("say a line's points by count, not point by point", () => {
    const c = compactNode([line], line);
    expect(c).toMatchObject({ id: "line_1", type: "line", points: 30 });
    expect(c.bounds).toEqual({ x: 14.5, z: 0, y: 0, width: 29, depth: 0, height: 0 });
    expect(JSON.stringify(c)).not.toContain('"x":3,');
  });

  it("give an array's count and tops by default, and its item lines only when asked (14.2)", () => {
    const short = compactNode([], ring(4));
    expect(short.items).toBe(4);
    expect(short.tops).toBe("3.5");
    expect(typeof short.at).toBe("string");
    const c = compactNode([], ring(4), { items: true });
    // Item 1 is at 90° (north, -z), turned tangent; its top is the slab's 0.5 above y 3.
    expect(c.at).toEqual(["array_1/0 → 10, 3, 0 · top 3.5 · 90°", "array_1/1 → 0, 3, -10 · top 3.5 · 180°", "array_1/2 → -10, 3, 0 · top 3.5 · 270°", "array_1/3 → 0, 3, 10 · top 3.5 · 0°"]);
  });

  it("list the first item lines of a long array, then say how to read the rest", () => {
    const at = compactNode([], ring(50), { items: true }).at as string[];
    expect(at).toHaveLength(MAX_ITEM_LINES + 1);
    expect(at.at(-1)).toBe(`… 10 more: get_scene { root: "array_1" }`);
  });

  it("leave skipped items out, keeping their indices", () => {
    const at = compactNode([], ring(4, { skip: [1] }), { items: true }).at as string[];
    expect(at.map((l) => l.split(" ")[0])).toEqual(["array_1/0", "array_1/2", "array_1/3"]);
  });

  it("never echo a followed node's points in a following array's layout", () => {
    const following: ArrayNode = {
      ...ring(1),
      layout: { type: "path", along: { id: "line_1" }, points: line.type === "line" ? line.points : [], place: "spacing", spacing: 5 },
    };
    const c = compactNode([line, following], following);
    expect(c.layout).toMatchObject({ type: "path", along: { id: "line_1" }, points: 30 });
  });

  it("follow the order asked for and skip IDs that are gone", () => {
    expect(compactNodes([line, ring(1)], ["array_1", "nope", "line_1"]).map((c) => c.id)).toEqual(["array_1", "line_1"]);
  });
});

describe("finding array items", () => {
  it("lists every item's line for get_scene { root: array }", () => {
    const outline = describeScene(open, scene([ring(4)]), { root: "array_1" });
    expect(outline.detail).toBe("one array, with its items");
    expect(outline.root?.at).toHaveLength(4);
  });

  it("finds the items near a point, nearest first", () => {
    // Near the north item, within reach of it but not of the others.
    const { found } = findNodes([ring(4)], { type: "item", near: { x: 0, z: -12, radius: 2 } });
    expect(found.map((f) => f.id)).toEqual(["array_1/1"]);
    expect(found[0]).toMatchObject({ type: "item", entity: "slab", parent: "array_1", distance: 1 });
    // A wider search, nearest first.
    expect(findNodes([ring(4)], { type: "item", near: { x: 8, z: -8, radius: 20 } }).found.map((f) => f.id).slice(0, 2).sort()).toEqual(["array_1/0", "array_1/1"]);
  });

  it("lists an array's items under it", () => {
    expect(findNodes([ring(3)], { under: "array_1" }).found.map((f) => f.at)).toEqual([
      "array_1/0 → 10, 3, 0 · top 3.5 · 90°",
      "array_1/1 → -5, 3, -8.66 · top 3.5 · 210°",
      "array_1/2 → -5, 3, 8.66 · top 3.5 · 330°",
    ]);
  });

  it("hints at items when a near search finds an array", () => {
    expect(findNodes([ring(4)], { near: { x: 0, z: -12, radius: 3 } }).hint).toMatch(/array_1 has items near there/);
  });

  it("caps the items it lists", () => {
    const big = ring(300);
    const result = findNodes([big], { under: "array_1" });
    expect(result.found).toHaveLength(MAX_MATCHES);
    expect(result.more).toBe(`${300 - MAX_MATCHES} more not listed: narrow the search`);
  });
});

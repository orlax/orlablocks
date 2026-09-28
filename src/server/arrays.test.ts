import { beforeEach, describe, expect, it } from "vitest";
import { arrayItems, arrayLayout } from "../shared/arrays";
import { expandNodes, ownerOf, setDefinitions } from "../shared/entities";
import { boundsOf, mirrorShape, moveShape, rotateShape } from "../shared/geometry";
import { cutters } from "../shared/holes";
import { MAX_ARRAY_ITEMS, type ArrayLayout, type ArrayNode, type Cylinder, type SceneNode } from "../shared/scene.types";
import { countsText } from "../shared/tree";
import { createSceneStore, SceneError } from "./scene";

/** A 1 × 1 × 1 block around the pivot. */
const BLOCK: SceneNode[] = [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 0.5, height: 1, rotation: 0, color: "gray", createdBy: "human" }];
/** A window: a box hole 1.2 wide (along x), 0.6 deep, 2 tall. */
const WINDOW: SceneNode[] = [{ id: "box_1", type: "box", kind: "hole", x: 0, z: 0, y: 0, width: 1.2, depth: 0.6, height: 2, rotation: 0, color: "white", createdBy: "human" }];

const array = (layout: ArrayLayout, fields: Partial<ArrayNode> = {}): ArrayNode => ({
  id: "array_1",
  type: "array",
  entities: [{ entity: "block" }],
  layout,
  createdBy: "human",
  ...fields,
});
type PathLayout = Extract<ArrayLayout, { type: "path" }>;
const path = (points: [number, number][], fields: Partial<PathLayout> = {}): PathLayout => ({
  type: "path",
  points: points.map(([x, z]) => ({ x, y: 0, z })),
  place: "spacing",
  spacing: 1,
  ...fields,
});
const where = (a: ArrayNode) => arrayItems(a).map((i) => [i.x, i.z, i.rotation]);

beforeEach(() => setDefinitions({ block: BLOCK, window: WINDOW, other: BLOCK }));

describe("a path's items", () => {
  it("fits the spacing to the path, with an item at each end of an open path", () => {
    // 10 m at "every 3 m" is 3 gaps of 3.33 m.
    expect(where(array(path([[0, 0], [10, 0]], { spacing: 3 })))).toEqual([
      [0, 0, 0],
      [3.33, 0, 0],
      [6.67, 0, 0],
      [10, 0, 0],
    ]);
  });

  it("faces along the path: an entity's +x turned toward the way it goes", () => {
    // Going north (-z) is a quarter turn counterclockwise seen from above.
    expect(where(array(path([[0, 0], [0, -2]])))).toEqual([
      [0, 0, 90],
      [0, -1, 90],
      [0, -2, 90],
    ]);
    // Fixed keeps the entity as drawn, turned by the array's rotation.
    expect(where(array(path([[0, 0], [0, -2]]), { facing: "fixed", rotation: 30 })).map((w) => w[2])).toEqual([30, 30, 30]);
  });

  it("doesn't repeat the first item on a closed path", () => {
    const items = arrayItems(array(path([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, spacing: 5 })));
    expect(items).toHaveLength(8);
    expect(items.map((i) => [i.x, i.z])).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 5],
      [10, 10],
      [5, 10],
      [0, 10],
      [0, 5],
    ]);
  });

  it("places count items evenly, both ends included", () => {
    expect(where(array(path([[0, 0], [10, 0]], { place: "count", count: 3, spacing: undefined })))).toEqual([
      [0, 0, 0],
      [5, 0, 0],
      [10, 0, 0],
    ]);
  });

  it("places one on every corner, or one mid-edge", () => {
    const square = path([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    const corners = arrayItems(array({ ...square, place: "corners" }));
    expect(corners.map((i) => [i.x, i.z])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    // A corner faces along the bisector of its edges: from (0, 10) to (0, 0) to (10, 0) is diagonal.
    expect(corners[0].rotation).toBe(45);
    const mid = arrayItems(array({ ...square, place: "midpoints" }));
    expect(mid.map((i) => [i.x, i.z, i.rotation])).toEqual([
      [5, 0, 0],
      [10, 5, 270],
      [5, 10, 180],
      [0, 5, 90],
    ]);
  });

  it("stacks up a vertical path, at each point's height", () => {
    const items = arrayItems(array({ type: "path", points: [{ x: 1, y: 0, z: 2 }, { x: 1, y: 3, z: 2 }], place: "spacing", spacing: 1 }));
    expect(items.map((i) => [i.x, i.y, i.z])).toEqual([
      [1, 0, 2],
      [1, 1, 2],
      [1, 2, 2],
      [1, 3, 2],
    ]);
  });

  it("leaves skipped items out, keeping the others' indices", () => {
    const items = arrayItems(array(path([[0, 0], [4, 0]]), { skip: [1, 3] }));
    expect(items.map((i) => [i.index, i.x])).toEqual([
      [0, 0],
      [2, 2],
      [4, 4],
    ]);
  });

  it("makes at most MAX_ARRAY_ITEMS items, and says how many the layout places", () => {
    const { items, total } = arrayLayout(array(path([[0, 0], [100, 0]], { spacing: 0.1 })));
    expect(total).toBe(1001);
    expect(items).toHaveLength(MAX_ARRAY_ITEMS);
  });
});

describe("a circle's and a grid's items", () => {
  const circle = (fields: Partial<Extract<ArrayLayout, { type: "circle" }>> = {}): ArrayLayout => ({ type: "circle", x: 0, y: 1, z: 0, radius: 10, count: 4, ...fields });

  it("goes counterclockwise from east, facing along the circle by default", () => {
    expect(arrayItems(array(circle())).map((i) => [i.x, i.y, i.z, i.rotation])).toEqual([
      [10, 1, 0, 90],
      [0, 1, -10, 180],
      [-10, 1, 0, 270],
      [0, 1, 10, 0],
    ]);
  });

  it("faces out or in", () => {
    expect(arrayItems(array(circle(), { facing: "out" })).map((i) => i.rotation)).toEqual([0, 90, 180, 270]);
    expect(arrayItems(array(circle(), { facing: "in" })).map((i) => i.rotation)).toEqual([180, 270, 0, 90]);
  });

  it("puts items at both ends of an arc", () => {
    expect(arrayItems(array(circle({ count: 3, sweep: 180, start: 90 }))).map((i) => [i.x, i.z])).toEqual([
      [0, -10],
      [-10, 0],
      [0, 10],
    ]);
  });

  it("lays a grid out around its center, turned with it, and staggers rows", () => {
    const grid: ArrayLayout = { type: "grid", x: 10, y: 0, z: 0, columns: 3, rows: 2, spacing: { x: 2, z: 4 } };
    expect(where(array(grid))).toEqual([
      [8, -2, 0],
      [10, -2, 0],
      [12, -2, 0],
      [8, 2, 0],
      [10, 2, 0],
      [12, 2, 0],
    ]);
    expect(where(array({ ...grid, stagger: true })).slice(3)).toEqual([
      [9, 2, 0],
      [11, 2, 0],
      [13, 2, 0],
    ]);
    // Turned a quarter: columns run north (-z), and the items turn with the grid.
    expect(where(array({ ...grid, rotation: 90, rows: 1 }))).toEqual([
      [10, 2, 90],
      [10, 0, 90],
      [10, -2, 90],
    ]);
  });

  it("stacks a grid's layers", () => {
    const items = arrayItems(array({ type: "grid", x: 0, y: 1, z: 0, columns: 1, rows: 1, layers: 3, spacing: { x: 1, z: 1, y: 2.5 } }));
    expect(items.map((i) => i.y)).toEqual([1, 3.5, 6]);
  });
});

describe("noise and entities", () => {
  it("is the same for the same seed, and changes with it", () => {
    const noisy = (seed: number) => where(array(path([[0, 0], [10, 0]]), { jitter: 0.5, turnJitter: 20, seed }));
    expect(noisy(7)).toEqual(noisy(7));
    expect(noisy(7)).not.toEqual(noisy(8));
    for (const [x, z, r] of noisy(7)) {
      expect(z).toBeGreaterThanOrEqual(-0.5);
      expect(z).toBeLessThanOrEqual(0.5);
      expect(r <= 20 || r >= 340).toBe(true);
      expect(Number.isFinite(x)).toBe(true);
    }
  });

  it("keeps an item's noise when the path grows", () => {
    const short = where(array(path([[0, 0], [10, 0]], { spacing: 1 }), { turnJitter: 30 }));
    const long = where(array(path([[0, 0], [20, 0]], { spacing: 1 }), { turnJitter: 30 }));
    expect(long.slice(0, 11).map((w) => w[2])).toEqual(short.map((w) => w[2]));
  });

  it("chooses entities by weight", () => {
    const items = arrayItems(
      array({ type: "grid", x: 0, y: 0, z: 0, columns: 20, rows: 20, spacing: { x: 1, z: 1 } }, { entities: [{ entity: "block", weight: 3 }, { entity: "other" }] }),
    );
    const blocks = items.filter((i) => i.entity === "block").length;
    expect(blocks / items.length).toBeGreaterThan(0.68);
    expect(blocks / items.length).toBeLessThan(0.82);
  });
});

describe("an array as a node", () => {
  it("expands into instances in its own place: a hit on an item's part belongs to the array", () => {
    const nodes = expandNodes([array(path([[0, 0], [2, 0]]), { parent: "group_1" })]);
    expect(nodes.map((n) => [n.id, n.parent])).toEqual([
      ["array_1/0", "group_1"],
      ["array_1/0/box_1", "array_1/0"],
      ["array_1/1", "group_1"],
      ["array_1/1/box_1", "array_1/1"],
      ["array_1/2", "group_1"],
      ["array_1/2/box_1", "array_1/2"],
    ]);
    expect(ownerOf("array_1/2/box_1")).toBe("array_1");
  });

  it("cuts its tower's walls: a window array in the tower's group", () => {
    const tower: Cylinder = { id: "cylinder_1", type: "cylinder", sides: 10, kind: "room", parent: "group_1", x: 0, z: 0, y: 0, width: 20, depth: 20, height: 8, rotation: 0, color: "gray", createdBy: "human" };
    const nodes: SceneNode[] = [
      { id: "group_1", type: "group", createdBy: "human" },
      tower,
      array({ type: "circle", x: 0, y: 3, z: 0, radius: 9.41, count: 10 }, { entities: [{ entity: "window" }], parent: "group_1" }),
    ];
    const cuts = cutters(expandNodes(nodes));
    expect(cuts.get("cylinder_1")).toHaveLength(10);
  });

  it("has its items' bounds, and moves, turns and mirrors its layout", () => {
    const a = array(path([[0, 0], [4, 0]]));
    expect(boundsOf([a])).toEqual({ minX: -0.5, maxX: 4.5, minY: 0, maxY: 1, minZ: -0.25, maxZ: 0.25 });
    expect(moveShape(a, 1, 2, 3)).toEqual({ layout: { ...a.layout, points: [{ x: 1, y: 2, z: 3 }, { x: 5, y: 2, z: 3 }] } });
    const turned = { ...a, ...rotateShape(a, { x: 0, z: 0 }, 90) } as ArrayNode;
    expect(where(turned).at(-1)).toEqual([0, -4, 90]);
    const c = array({ type: "circle", x: 3, y: 0, z: 0, radius: 2, count: 3, start: 10 }, { facing: "out", rotation: 15, skip: [0] });
    const mirrored = { ...c, ...mirrorShape(c, "x", 0) } as ArrayNode;
    // Each item goes to its mirrored place, turned as a mirrored instance is (180 - its turn).
    const reflect = (items: number[][]) => items.map(([x, z, r]) => [-x, z, (180 - r + 360) % 360]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const sorted = (items: number[][]) => [...items].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    expect(sorted(where(mirrored))).toEqual(reflect(where(c)));
    expect({ ...mirrored, ...mirrorShape(mirrored, "x", 0) }).toEqual(c);
  });

  it("counts as an array with its items", () => {
    expect(countsText([array(path([[0, 0], [4, 0]])), array(path([[0, 0], [1, 0]]), { id: "array_2" })])).toBe("2 arrays (7 items)");
  });
});

describe("the store's arrays", () => {
  const store = () => createSceneStore({ entityName: (id) => (["block", "window", "other"].includes(id) ? id : undefined) });

  it("draws one, with its layout stored as given, rounded, and defaults left out", () => {
    const s = store();
    const [a] = s.drawShapes([{ type: "array", entity: "block", layout: { type: "circle", x: 1.234, z: 0, radius: 5, count: 6, sweep: 360 } }], "agent");
    expect(a).toEqual({ id: "array_1", type: "array", entities: [{ entity: "block" }], layout: { type: "circle", x: 1.23, y: 0, z: 0, radius: 5, count: 6 }, createdBy: "agent" });
    // A path's spacing defaults to 1.5 × the entity's width.
    const [b] = s.drawShapes([{ type: "array", entity: "window", layout: { type: "path", points: [{ x: 0, y: 0, z: 0 }, { x: 9, y: 0, z: 0 }] } }], "agent");
    expect(b).toMatchObject({ layout: { place: "spacing", spacing: 1.8 } });
  });

  it("refuses unknown entities and incomplete layouts", () => {
    const s = store();
    expect(() => s.drawShapes([{ type: "array", entity: "tree", layout: { type: "circle", x: 0, z: 0, radius: 5, count: 6 } }], "agent")).toThrow(/no entity "tree"/);
    expect(() => s.drawShapes([{ type: "array", entity: "block", layout: { type: "path", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], place: "count" } }], "agent")).toThrow(
      /needs a count/,
    );
    expect(() => s.drawShapes([{ type: "array", layout: { type: "circle", x: 0, z: 0, radius: 5, count: 6 } }], "agent")).toThrow(/either entity or entities/);
  });

  it("merges layout changes, and switches a path to count when given a count", () => {
    const s = store();
    const [a] = s.drawShapes([{ type: "array", entity: "block", layout: { type: "path", points: [{ x: 0, y: 0, z: 0 }, { x: 9, y: 0, z: 0 }], spacing: 3 } }], "agent");
    const [changed] = s.updateNodes([{ id: a.id, layout: { count: 5 }, jitter: 0.25 }], "human") as ArrayNode[];
    expect(changed.layout).toEqual({ type: "path", points: [{ x: 0, y: 0, z: 0 }, { x: 9, y: 0, z: 0 }], place: "count", count: 5 });
    expect(changed.jitter).toBe(0.25);
    expect(s.getHistory().undoLabel).toBe(`Edit ${a.id}`);
    // Another type is a whole new layout.
    const [circle] = s.updateNodes([{ id: a.id, layout: { type: "circle", x: 0, z: 0, radius: 3, count: 4 } }], "human") as ArrayNode[];
    expect(circle.layout).toEqual({ type: "circle", x: 0, y: 0, z: 0, radius: 3, count: 4 });
    expect(() => s.updateNodes([{ id: a.id, layout: { type: "grid", x: 0, z: 0 } }], "human")).toThrow(SceneError);
    expect(() => s.updateNodes([{ id: a.id, width: 3 }], "human")).toThrow(/is an array, with no width/);
  });

  it("makes one from an instance, which becomes its first item", () => {
    const s = store();
    const [inst] = s.drawShapes([{ type: "instance", entity: "block", x: 2, z: 3, y: 1, rotation: 90, name: "row" }], "human");
    const a = s.makeArray(inst.id, "human");
    expect(s.getScene().nodes).toEqual([a]);
    expect(a).toMatchObject({ id: "array_1", name: "row", entities: [{ entity: "block" }] });
    expect(arrayItems(a)[0]).toMatchObject({ x: 2, y: 1, z: 3, rotation: 90 });
    // Along its local +x (north at 90°), 4 items 1.5 m apart.
    expect(arrayItems(a).map((i) => [i.x, i.z])).toEqual([
      [2, 3],
      [2, 1.5],
      [2, 0],
      [2, -1.5],
    ]);
    expect(s.getHistory().undoLabel).toBe("Array instance_1");
    s.undo();
    expect(s.getScene().nodes).toEqual([inst]);
  });

  it("detaches an array into a group of instances where its items were", () => {
    const s = store();
    const [a] = s.drawShapes([{ type: "array", entity: "block", name: "row", layout: { type: "path", points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], spacing: 1 }, skip: [1] }], "agent");
    const [group] = s.detachInstances([a.id], "human");
    expect(group).toMatchObject({ type: "group", name: "row" });
    const inside = s.getScene().nodes.filter((n) => n.parent === group.id);
    expect(inside.map((n) => n.type === "instance" && [n.entity, n.x, n.z])).toEqual([
      ["block", 0, 0],
      ["block", 2, 0],
    ]);
  });

  it("moves, copies and pastes an array as a node", () => {
    const s = store();
    const [a] = s.drawShapes([{ type: "array", entity: "block", layout: { type: "circle", x: 0, z: 0, radius: 2, count: 3 } }], "agent");
    s.moveNodes({ ids: [a.id], dx: 1 }, "human");
    expect((s.getScene().nodes[0] as ArrayNode).layout).toMatchObject({ x: 1 });
    const [copy] = s.duplicateNodes({ ids: [a.id], dz: 5 }, "human");
    expect(copy).toMatchObject({ id: "array_2", layout: { x: 1, z: 5 } });
    const [pasted] = s.pasteNodes({ nodes: [a], focus: { x: 10, z: 10 }, parent: null }, "human");
    expect(pasted).toMatchObject({ id: "array_3", type: "array" });
  });
});

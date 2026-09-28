import { beforeEach, describe, expect, it } from "vitest";
import { arrayItems, arrayLayout, arrayShortfall } from "../shared/arrays";
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

describe("a scatter's items", () => {
  const scatter = (fields: Partial<Extract<ArrayLayout, { type: "scatter" }>> = {}): ArrayLayout => ({ type: "scatter", x: 0, y: 0, z: 0, radius: 10, count: 30, minDistance: 1.5, ...fields });
  const apart = (items: { x: number; z: number }[]) =>
    Math.min(...items.flatMap((a, i) => items.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z))));

  it("stays in its circle, at least minDistance apart, the same for the same seed", () => {
    const items = arrayItems(array(scatter(), { seed: 3 }));
    expect(items).toHaveLength(30);
    for (const i of items) expect(Math.hypot(i.x, i.z)).toBeLessThanOrEqual(10.01);
    expect(apart(items)).toBeGreaterThanOrEqual(1.49);
    expect(arrayItems(array(scatter(), { seed: 3 }))).toEqual(items);
    expect(arrayItems(array(scatter(), { seed: 4 }))).not.toEqual(items);
  });

  it("keeps its earlier items when the count grows", () => {
    const few = arrayItems(array(scatter({ count: 10 })));
    const more = arrayItems(array(scatter({ count: 20 })));
    expect(more.slice(0, 10).map((i) => [i.x, i.z])).toEqual(few.map((i) => [i.x, i.z]));
  });

  it("stays in its area, and says how many fit when they can't all", () => {
    const area = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 0, z: 10 },
    ];
    const a = array({ type: "scatter", y: 2, area, count: 20, minDistance: 1 });
    for (const i of arrayItems(a)) {
      expect(i.x + i.z).toBeLessThanOrEqual(10.01);
      expect(i.y).toBe(2);
    }
    const crowded = array({ type: "scatter", y: 0, x: 0, z: 0, radius: 2, count: 100, minDistance: 1.5 });
    const { items, total } = arrayLayout(crowded);
    expect(total).toBe(100);
    expect(items.length).toBeLessThan(100);
    expect(arrayShortfall(crowded)).toMatch(new RegExp(`^${items.length} of 100 fit 1.5 m apart`));
  });

  it("turns the same pattern when the array turns, and moves it when it moves", () => {
    const a = array(scatter({ count: 8 }), { facing: "fixed" });
    const turned = { ...a, ...rotateShape(a, { x: 0, z: 0 }, 90) } as ArrayNode;
    const before = arrayItems(a);
    const after = arrayItems(turned);
    // +90° counterclockwise seen from above takes (x, z) to (z, -x), and a fixed item turns with the frame.
    after.forEach((p, k) => {
      expect(p.x).toBeCloseTo(before[k].z, 1);
      expect(p.z).toBeCloseTo(-before[k].x, 1);
      expect(p.rotation).toBe(90);
    });
    const moved = arrayItems({ ...a, ...moveShape(a, 5, 1, 0) } as ArrayNode);
    moved.forEach((p, k) => {
      expect(p.x).toBeCloseTo(before[k].x + 5, 1);
      expect(p.y).toBe(1);
    });
  });

  it("is stored with the widest entity's width apart by default, and switches between a circle and an area", () => {
    const s = createSceneStore({ entityName: (id) => (["block", "window"].includes(id) ? id : undefined) });
    const [a] = s.drawShapes([{ type: "array", entities: [{ entity: "block" }, { entity: "window", weight: 2 }], layout: { type: "scatter", x: 0, z: 0, radius: 8, count: 12 } }], "agent");
    expect(a).toMatchObject({ entities: [{ entity: "block" }, { entity: "window", weight: 2 }], layout: { type: "scatter", x: 0, z: 0, radius: 8, count: 12, minDistance: 1.2 } });
    const area = [
      { x: -5, z: -5 },
      { x: 5, z: -5 },
      { x: 5, z: 5 },
      { x: -5, z: 5 },
    ];
    const [inArea] = s.updateNodes([{ id: a.id, layout: { area } }], "human") as ArrayNode[];
    expect(inArea.layout).toEqual({ type: "scatter", y: 0, area, count: 12, minDistance: 1.2 });
    const [inCircle] = s.updateNodes([{ id: a.id, layout: { radius: 3 } }], "human") as ArrayNode[];
    expect(inCircle.layout).toEqual({ type: "scatter", y: 0, x: 0, z: 0, radius: 3, count: 12, minDistance: 1.2 });
    expect(() => s.drawShapes([{ type: "array", entity: "block", layout: { type: "scatter", count: 3 } }], "agent")).toThrow(/either x, z and radius/);
    s.updateNodes([{ id: a.id, seed: 42 }], "human");
    expect(s.getHistory().undoLabel).toBe(`Reroll ${a.id}`);
  });
});

describe("following an outline", () => {
  const store = () => createSceneStore({ entityName: (id) => (["block", "window"].includes(id) ? id : undefined) });
  const room = { kind: "room" as const, x: 0, z: 0, width: 10, depth: 6, height: 4, name: "keep" };
  const follower = (id: string, fields: Record<string, unknown> = {}) => ({
    type: "array" as const,
    entity: "block",
    layout: { type: "path" as const, along: { id }, spacing: 2, ...fields },
  });

  it("stands on a room's wall top, on the wall's centerline, all the way round", () => {
    const s = store();
    const [keep] = s.drawShapes([room], "agent");
    const [a] = s.drawShapes([follower(keep.id)], "agent") as ArrayNode[];
    expect(a.layout).toMatchObject({ type: "path", closed: true, along: { id: keep.id }, place: "spacing", spacing: 2 });
    const items = arrayItems(a);
    // A 9.8 × 5.8 centerline (the wall is 0.2 thick) is 31.2 m round: 16 gaps of 1.95 m.
    expect(items).toHaveLength(16);
    for (const i of items) {
      expect(i.y).toBe(4);
      expect(Math.abs(i.x) === 4.9 || Math.abs(i.z) === 2.9).toBe(true);
    }
  });

  it("follows the room when it changes, in the room's own step, and undo takes both back", () => {
    const s = store();
    const [keep] = s.drawShapes([room], "agent");
    const [a] = s.drawShapes([follower(keep.id)], "agent");
    s.updateNodes([{ id: keep.id, width: 14 }], "human");
    s.updateNodes([{ id: keep.id, height: 6 }], "human");
    const moved = s.getScene().nodes.find((n) => n.id === a.id) as ArrayNode;
    expect(arrayItems(moved).length).toBeGreaterThan(16);
    expect(arrayItems(moved)[0].y).toBe(6);
    expect(s.getHistory().undoLabel).toBe(`Change height of ${keep.id}`);
    s.undo();
    s.undo();
    expect(arrayItems(s.getScene().nodes.find((n) => n.id === a.id) as ArrayNode)).toHaveLength(16);
  });

  it("goes with its room in a group move, and refuses to move alone", () => {
    const s = store();
    const [keep] = s.drawShapes([room], "agent");
    const [a] = s.drawShapes([follower(keep.id)], "agent");
    const g = s.groupNodes({ ids: [keep.id, a.id] }, "agent");
    s.moveNodes({ ids: [g.id], dx: 5 }, "human");
    const after = s.getScene().nodes.find((n) => n.id === a.id) as ArrayNode;
    expect(Math.min(...arrayItems(after).map((i) => i.x))).toBe(0.1);
    expect(() => s.moveNodes({ ids: [a.id], dx: 1 }, "human")).toThrow(/follows box_1/);
  });

  it("unlinks when its target is removed, keeping its path; undo links it again", () => {
    const s = store();
    const [keep] = s.drawShapes([room], "agent");
    const [a] = s.drawShapes([follower(keep.id)], "agent");
    s.removeNodes([keep.id], "human");
    const left = s.getScene().nodes.find((n) => n.id === a.id) as ArrayNode;
    expect(left.layout).not.toHaveProperty("along");
    expect(arrayItems(left)).toHaveLength(16);
    s.undo();
    expect((s.getScene().nodes.find((n) => n.id === a.id) as ArrayNode).layout).toHaveProperty("along", { id: keep.id });
  });

  it("follows the free-form a box becomes, and copies follow their copied target", () => {
    const s = store();
    const [keep] = s.drawShapes([room], "agent");
    const [a] = s.drawShapes([follower(keep.id)], "agent");
    const before = arrayItems(a as ArrayNode).map((i) => [i.x, i.z]);
    const [ff] = s.updateNodes([{ id: keep.id, type: "freeform" }], "human");
    const now = s.getScene().nodes.find((n) => n.id === a.id) as ArrayNode;
    expect(now.layout).toHaveProperty("along", { id: ff.id });
    expect(arrayItems(now).map((i) => [i.x, i.z])).toEqual(before);
    const g = s.groupNodes({ ids: [ff.id, a.id] }, "agent");
    s.duplicateNodes({ ids: [g.id], dx: 20 }, "human");
    const copies = s.getScene().nodes.filter((n) => n.type === "array" && n.id !== a.id) as ArrayNode[];
    expect(copies).toHaveLength(1);
    const copiedTarget = s.getScene().nodes.find((n) => n.type === "freeform" && n.id !== ff.id)!;
    expect(copies[0].layout).toHaveProperty("along", { id: copiedTarget.id });
    // Copied alone, it's unlinked.
    const [alone] = s.duplicateNodes({ ids: [a.id], dz: 10 }, "human") as ArrayNode[];
    expect(alone.layout).not.toHaveProperty("along");
  });

  it("puts one on every corner or mid-edge, and follows a volume's edge, a floor, a ramp and a line", () => {
    const s = store();
    const [tower] = s.drawShapes([{ type: "cylinder", sides: 10, kind: "room", x: 0, z: 0, width: 20, depth: 20, height: 8 }], "agent");
    const [mid] = s.drawShapes([follower(tower.id, { place: "midpoints", spacing: undefined })], "agent");
    expect(arrayItems(mid as ArrayNode)).toHaveLength(10);
    // Mid-face on the wall's centerline: 10 cos 18° − 0.1.
    for (const i of arrayItems(mid as ArrayNode)) expect(Math.hypot(i.x, i.z)).toBeCloseTo(9.41, 1);
    const [block] = s.drawShapes([{ kind: "volume", x: 30, z: 0, width: 4, depth: 4, height: 1 }], "agent");
    const [corners] = s.drawShapes([follower(block.id, { place: "corners", spacing: undefined })], "agent");
    expect(arrayItems(corners as ArrayNode).map((i) => [i.x, i.y, i.z])).toEqual([
      [28, 1, 2],
      [32, 1, 2],
      [32, 1, -2],
      [28, 1, -2],
    ]);
    const [floor] = s.drawShapes([{ type: "array", entity: "block", layout: { type: "path", along: { id: tower.id, at: "bottom" }, place: "count", count: 4 } }], "agent");
    expect(arrayItems(floor as ArrayNode)[0].y).toBe(0);
    const [ramp] = s.drawShapes([{ type: "ramp", points: [{ x: 0, y: 0, z: 40 }, { x: 10, y: 5, z: 40 }], width: 2 }], "agent");
    const [posts] = s.drawShapes([{ type: "array", entity: "block", layout: { type: "path", along: { id: ramp.id, offset: 1 }, place: "count", count: 3 } }], "agent");
    // To the right of travel going east is south (+z); the posts climb with the ramp.
    expect(arrayItems(posts as ArrayNode).map((i) => [i.x, i.y, i.z])).toEqual([
      [0, 0, 41],
      [5, 2.5, 41],
      [10, 5, 41],
    ]);
    const [line] = s.drawShapes([{ type: "line", points: [{ x: 0, y: 1, z: 60 }, { x: 4, y: 1, z: 60 }] }], "agent");
    const [torches] = s.drawShapes([{ type: "array", entity: "block", layout: { type: "path", along: { id: line.id }, spacing: 2 } }], "agent");
    expect(arrayItems(torches as ArrayNode).map((i) => i.x)).toEqual([0, 2, 4]);
  });

  it("refuses what it can't follow, and unlinks on request", () => {
    const s = store();
    const [keep] = s.drawShapes([room], "agent");
    const [tilted] = s.drawShapes([{ kind: "volume", x: 20, z: 0, width: 2, depth: 2, height: 2, pitch: 30 }], "agent");
    expect(() => s.drawShapes([follower(tilted.id)], "agent")).toThrow(/tilted/);
    expect(() => s.drawShapes([follower("box_99")], "agent")).toThrow(/no node "box_99"/);
    const [a] = s.drawShapes([follower(keep.id)], "agent");
    const [unlinked] = s.updateNodes([{ id: a.id, layout: { along: null } }], "human") as ArrayNode[];
    expect(unlinked.layout).not.toHaveProperty("along");
    const [again] = s.updateNodes([{ id: a.id, layout: { along: { id: keep.id, offset: 0 } } }], "human") as ArrayNode[];
    expect(again.layout).toHaveProperty("along", { id: keep.id, offset: 0 });
    expect(arrayItems(again).every((i) => Math.abs(i.x) === 5 || Math.abs(i.z) === 3)).toBe(true);
  });
});

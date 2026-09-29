import { beforeEach, describe, expect, it } from "vitest";
import { arrayItems } from "../shared/arrays";
import { setDefinitions } from "../shared/entities";
import type { ArrayNode, Instance, Line, SceneNode } from "../shared/scene.types";
import { expandStops, surfaceAt, throughPoints, topOf } from "../shared/surfaces";
import { createSceneStore } from "./scene";

/** A slab 2 × 2 × 0.5 around its pivot, and a jet 0.4 × 0.4 × 1. */
const SLAB: SceneNode[] = [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 2, depth: 2, height: 0.5, rotation: 0, color: "gray", createdBy: "human" }];
const JET: SceneNode[] = [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 0.4, depth: 0.4, height: 1, rotation: 0, color: "orange", createdBy: "human" }];

beforeEach(() => setDefinitions({ slab: SLAB, jet: JET }));
const store = () => createSceneStore({ entityName: (id) => (id === "slab" || id === "jet" ? id : undefined) });
const find = <T extends SceneNode>(s: ReturnType<typeof store>, id: string) => s.getScene().nodes.find((n) => n.id === id) as T;

describe("walking surfaces", () => {
  it("finds the top of a volume, a room's floor, an instance's top and a ramp's middle", () => {
    const s = store();
    s.drawShapes(
      [
        { kind: "volume", x: 0, z: 0, width: 4, depth: 4, y: 2, height: 1 },
        { kind: "room", x: 20, z: 0, width: 10, depth: 10, y: 1 },
        { type: "instance", entity: "slab", x: 40, z: 0, y: 3 },
        { type: "ramp", points: [{ x: 0, y: 0, z: 20 }, { x: 10, y: 4, z: 20 }] },
        { type: "note", x: 5, y: 1, z: 5, text: "rest here" },
      ],
      "agent",
    );
    const nodes = s.getScene().nodes;
    expect(topOf(nodes, "box_1")).toEqual({ x: 0, y: 3, z: 0 });
    expect(topOf(nodes, "box_2")).toEqual({ x: 20, y: 1, z: 0 });
    expect(topOf(nodes, "instance_1")).toEqual({ x: 40, y: 3.5, z: 0 });
    expect(topOf(nodes, "ramp_1")).toMatchObject({ x: 5, y: 2, z: 20 });
    expect(topOf(nodes, "note_1")).toEqual({ x: 5, y: 1, z: 5 });
    expect(surfaceAt(nodes.filter((n) => n.id === "box_1") as never, 10, 10)).toBeNull();
  });

  it("expands item stops, ranges and every item, and names what isn't a stop", () => {
    const s = store();
    s.drawShapes([{ type: "array", entity: "slab", layout: { type: "circle", x: 0, z: 0, radius: 10, count: 5 }, skip: [2] }], "agent");
    const nodes = s.getScene().nodes;
    expect(expandStops(nodes, ["array_1/*"]).ids).toEqual(["array_1/0", "array_1/1", "array_1/3", "array_1/4"]);
    expect(expandStops(nodes, ["array_1/1..3"]).ids).toEqual(["array_1/1", "array_1/3"]);
    expect(expandStops(nodes, ["array_1", "nope", "array_9/*"]).problems).toEqual([
      "array_1: an array isn't a stop; its items are (array_1/* for all of them)",
      "nope: no such node or item",
      "array_9/*: no array \"array_9\"",
    ]);
  });

  it("arcs each hop, peaking apex above the higher stop", () => {
    const s = store();
    s.drawShapes(
      [
        { kind: "volume", x: 0, z: 0, width: 2, depth: 2, height: 1 },
        { kind: "volume", x: 6, z: 0, width: 2, depth: 2, height: 3 },
      ],
      "agent",
    );
    const { points } = throughPoints(s.getScene().nodes, { stops: ["box_1", "box_2"], style: "jumps", apex: 1 });
    expect(points.map((p) => [p.x, p.y, p.z])).toEqual([
      [0, 1, 0],
      [6, 3, 0],
    ]);
    // The cubic's middle: (y0 + 3 h + 3 h + y1) / 8 with both handles at height h is the peak, 1 over the higher top.
    const h = points[0].y + points[0].out!.y;
    expect(h).toBeCloseTo(points[1].y + points[1].in!.y);
    expect((1 + 6 * h + 3) / 8).toBeCloseTo(4);
  });
});

describe("lines through nodes (plan 13 §7)", () => {
  const route = () => {
    const s = store();
    s.drawShapes(
      [
        { kind: "volume", x: 0, z: 0, width: 2, depth: 2, height: 1, ref: "start" },
        { type: "array", entity: "slab", ref: "hops", layout: { type: "path", points: [{ x: 4, y: 1, z: 0 }, { x: 12, y: 3, z: 0 }], place: "count", count: 3 } },
        { kind: "volume", x: 16, z: 0, width: 2, depth: 2, height: 4, ref: "end" },
        { type: "line", through: { stops: ["$start", "$hops/*", "$end"] } },
      ],
      "agent",
    );
    return s;
  };

  it("goes through its stops' tops, in one call with the stops", () => {
    const line = find<Line>(route(), "line_1");
    expect(line.through).toEqual({ stops: ["box_1", "array_1/*", "box_2"], style: "jumps" });
    expect(line.points.map((p) => [p.x, p.y])).toEqual([
      [0, 1],
      [4, 1.5],
      [8, 2.5],
      [12, 3.5],
      [16, 4],
    ]);
  });

  it("follows its stops when they change, in the same step", () => {
    const s = route();
    s.updateNodes([{ id: "box_2", height: 6, x: 18 }], "agent");
    expect(find<Line>(s, "line_1").points.at(-1)).toMatchObject({ x: 18, y: 6 });
    s.updateNodes([{ id: "array_1", layout: { count: 2 } }], "agent");
    expect(find<Line>(s, "line_1").points).toHaveLength(4);
    // Undoing the change undoes the line's with it.
    s.undo();
    expect(find<Line>(s, "line_1").points).toHaveLength(5);
  });

  it("unlinks when its points are edited or it's moved without its stops, keeping its points", () => {
    const s = route();
    s.updateNodes([{ id: "line_1", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] }], "agent");
    expect(find<Line>(s, "line_1").through).toBeUndefined();
    const t = route();
    t.moveNodes({ ids: ["line_1"], dx: 5 }, "agent");
    const moved = find<Line>(t, "line_1");
    expect(moved.through).toBeUndefined();
    expect(moved.points[0]).toMatchObject({ x: 5, y: 1 });
    // Moved with all its stops, it stays linked.
    const u = route();
    u.moveNodes({ ids: ["box_1", "array_1", "box_2", "line_1"], dz: 3 }, "agent");
    expect(find<Line>(u, "line_1")).toMatchObject({ through: { stops: ["box_1", "array_1/*", "box_2"] } });
    expect(find<Line>(u, "line_1").points[0].z).toBe(3);
  });

  it("drops a removed stop, and with fewer than 2 left keeps its points unlinked", () => {
    const s = route();
    s.removeNodes(["array_1"], "agent");
    expect(find<Line>(s, "line_1").through?.stops).toEqual(["box_1", "box_2"]);
    s.removeNodes(["box_2"], "agent");
    const line = find<Line>(s, "line_1");
    expect(line.through).toBeUndefined();
    expect(line.points.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses stops that are nothing", () => {
    expect(() => store().drawShapes([{ type: "line", through: { stops: ["box_9", "box_10"] } }], "agent")).toThrow(/box_9: no such node or item/);
  });
});

describe("standing on (plan 13 §7)", () => {
  it("stands an instance on a platform's top, and keeps it there when the platform changes", () => {
    const s = store();
    s.drawShapes(
      [
        { kind: "volume", x: 0, z: 0, width: 4, depth: 4, height: 2, ref: "p" },
        { type: "instance", entity: "jet", x: 1, z: 1, on: { id: "$p" } },
      ],
      "agent",
    );
    expect(find<Instance>(s, "instance_1")).toMatchObject({ y: 2, on: { id: "box_1" } });
    s.updateNodes([{ id: "box_1", height: 5 }], "agent");
    expect(find<Instance>(s, "instance_1").y).toBe(5);
    // Moving it sideways keeps it on; up or down unlinks it (it keeps its new height).
    s.moveNodes({ ids: ["instance_1"], dx: 0.5 }, "agent");
    expect(find<Instance>(s, "instance_1")).toMatchObject({ x: 1.5, y: 5, on: { id: "box_1" } });
    s.moveNodes({ ids: ["instance_1"], dy: 1 }, "agent");
    expect(find<Instance>(s, "instance_1")).toMatchObject({ y: 6 });
    expect(find<Instance>(s, "instance_1").on).toBeUndefined();
  });

  it("stands an array on another array item by item, taking its layout, and follows the ring", () => {
    const s = store();
    s.drawShapes(
      [
        { type: "array", entity: "slab", ref: "ring", layout: { type: "circle", x: 0, z: 0, y: 12, radius: 9, count: 8 } },
        { type: "array", entity: "jet", on: { id: "$ring" }, skip: [1, 3, 5, 7] },
      ],
      "agent",
    );
    const jets = () => arrayItems(find<ArrayNode>(s, "array_2"));
    const slabs = () => arrayItems(find<ArrayNode>(s, "array_1"));
    expect(jets().map((j) => j.index)).toEqual([0, 2, 4, 6]);
    for (const j of jets()) {
      const slab = slabs().find((sl) => sl.index === j.index)!;
      expect([j.x, j.y, j.z, j.rotation]).toEqual([slab.x, 12.5, slab.z, slab.rotation]);
    }
    // The ring grows and rises: the jets stay on their slabs.
    s.updateNodes([{ id: "array_1", layout: { radius: 12, y: 14 } }], "agent");
    const j0 = jets()[0];
    expect([j0.x, j0.y, j0.z]).toEqual([12, 14.5, 0]);
  });

  it("drops each item onto what's under it, and stops standing when that's removed", () => {
    const s = store();
    s.drawShapes(
      [
        { kind: "volume", x: 0, z: 0, width: 4, depth: 20, height: 3, ref: "wall" },
        { type: "array", entity: "jet", on: { id: "$wall" }, layout: { type: "path", points: [{ x: 0, y: 0, z: -12 }, { x: 0, y: 0, z: 12 }], place: "count", count: 5 } },
      ],
      "agent",
    );
    // The ends are past the wall: they keep the layout's height.
    expect(arrayItems(find<ArrayNode>(s, "array_1")).map((i) => i.y)).toEqual([0, 3, 3, 3, 0]);
    s.removeNodes(["box_1"], "agent");
    const a = find<ArrayNode>(s, "array_1");
    expect(a.on).toBeUndefined();
    expect(a.stand).toBeUndefined();
  });

  it("refuses to stand on itself, a line or nothing", () => {
    const s = store();
    s.drawShapes([{ type: "line", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] }], "agent");
    expect(() => s.drawShapes([{ type: "instance", entity: "jet", x: 0, z: 0, on: { id: "line_1" } }], "agent")).toThrow(/is a line: nothing stands on it/);
    expect(() => s.drawShapes([{ type: "instance", entity: "jet", x: 0, z: 0, on: { id: "box_9" } }], "agent")).toThrow(/no node "box_9"/);
    expect(() => s.drawShapes([{ type: "array", entity: "jet" }], "agent")).toThrow(/give an array a layout/);
  });
});

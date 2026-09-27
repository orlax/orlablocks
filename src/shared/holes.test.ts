import { describe, expect, it } from "vitest";
import type { Box, Group, SceneNode } from "./scene.types";
import { cutsFloor, cutters, holeScope, holeWarnings } from "./holes";

const base = { type: "box", y: 0, rotation: 0, color: "almost-white", createdBy: "human" } as const;
const box = (id: string, patch: Partial<Box>): Box => ({ ...base, id, kind: "room", x: 0, z: 0, width: 10, depth: 8, height: 3, ...patch });
const group = (id: string, parent?: string): Group => ({ id, type: "group", createdBy: "human", ...(parent ? { parent } : {}) });

// castle › lobby (room + door), castle › hall (room, sharing the lobby's east wall), castle › yard › well (deeper),
// a loose box in castle, a room outside the castle, and a house › hall › door group (walls beside the door group, a
// sibling room, a room in a sibling of the house).
const nodes: SceneNode[] = [
  group("castle"),
  group("lobby", "castle"),
  group("hall", "castle"),
  group("yard", "castle"),
  group("well", "yard"),
  box("lobby_room", { parent: "lobby" }),
  box("door", { parent: "lobby", kind: "hole", x: 5, width: 0.6, depth: 1, height: 2.2 }),
  box("hall_room", { parent: "hall", x: 10 }),
  box("well_room", { parent: "well", x: 5 }),
  box("loose", { parent: "castle", kind: "volume", x: 5 }),
  box("outside", { x: 5 }),
  group("house"),
  group("room_a", "house"),
  group("room_b", "house"),
  group("entry", "room_a"),
  group("trim", "room_a"),
  box("walls_a", { parent: "room_a", z: 50 }),
  box("frame", { parent: "trim", kind: "volume", z: 50 }),
  box("walls_b", { parent: "room_b", x: 10, z: 50 }),
  box("leaf", { parent: "entry", kind: "hole", x: 5, z: 50, width: 0.6, depth: 1, height: 2.2 }),
  box("leaf_2", { parent: "entry", kind: "hole", x: 5, z: 51, width: 0.6, depth: 1, height: 2.2 }),
];
const find = (id: string) => nodes.find((n) => n.id === id) as Box;
const scope = (id: string) => holeScope(nodes, find(id)).map((n) => n.id);

describe("holes", () => {
  it("cut their group's shapes, the shapes beside their group, its sibling groups' and its parent's sibling groups'", () => {
    // entry › room_a › house: its own group has only holes; walls_a is beside it, trim is a sibling group, room_b
    // is room_a's sibling. The house's other top-level neighbors (castle) are out of reach.
    expect(scope("leaf")).toEqual(["walls_a", "frame", "walls_b"]);
    // A hole directly in a room's group: its room, the loose shapes and sibling rooms in the castle, and the other
    // top-level groups' shapes (the castle's siblings), but never deeper (well_room) or the loose top-level box.
    expect(scope("door")).toEqual(["lobby_room", "hall_room", "loose"]);
  });

  it("in a top-level group, cut the loose top-level shapes beside it", () => {
    const top: SceneNode[] = [group("gate"), box("wall", {}), box("arch", { parent: "gate", kind: "hole", width: 1, depth: 1, height: 2 })];
    expect(holeScope(top, top[2] as Box).map((n) => n.id)).toEqual(["wall"]);
  });

  it("cut only what they overlap, and never holes", () => {
    const withWindow = [...nodes, box("window", { parent: "hall", kind: "hole", x: 20, z: 20, width: 1, depth: 1, height: 1 })];
    const cuts = cutters(withWindow);
    expect(cuts.get("lobby_room")?.map((h) => h.id)).toEqual(["door"]);
    expect(cuts.get("hall_room")?.map((h) => h.id)).toEqual(["door"]);
    expect(cuts.has("window")).toBe(false);
    expect(cuts.has("well_room")).toBe(false);
  });

  it("cut nothing outside any group, with a warning", () => {
    const loose = [...nodes, box("stray", { kind: "hole", x: 5 })];
    expect(holeScope(loose, find("door")).length).toBe(3);
    expect(cutters(loose).get("outside")?.map((h) => h.id)).toBeUndefined();
    expect(holeWarnings(loose)).toEqual([expect.stringContaining("stray is a hole outside any group")]);
    expect(holeWarnings(nodes)).toEqual([]);
  });

  it("warn when their group and its siblings have nothing to cut", () => {
    const lonely: SceneNode[] = [group("g"), box("h", { parent: "g", kind: "hole" })];
    expect(holeWarnings(lonely)).toEqual([expect.stringContaining("nothing to cut")]);
  });

  it("cut a room's floor only when they reach below it", () => {
    const room = find("lobby_room");
    expect(cutsFloor(find("door"), room)).toBe(false);
    expect(cutsFloor({ ...find("door"), y: -0.5 }, room)).toBe(true);
  });
});

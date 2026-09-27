import { describe, expect, it } from "vitest";
import type { Box, Group, SceneNode } from "./scene.types";
import { cutsFloor, cutters, holeScope, holeWarnings } from "./holes";

const base = { type: "box", y: 0, rotation: 0, color: "almost-white", createdBy: "human" } as const;
const box = (id: string, patch: Partial<Box>): Box => ({ ...base, id, kind: "room", x: 0, z: 0, width: 10, depth: 8, height: 3, ...patch });
const group = (id: string, parent?: string): Group => ({ id, type: "group", createdBy: "human", ...(parent ? { parent } : {}) });

// castle › lobby (room + door), castle › hall (room, sharing the lobby's east wall), castle › yard › well (deeper),
// a loose box in castle, and a room outside the castle.
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
];
const find = (id: string) => nodes.find((n) => n.id === id) as Box;

describe("holes", () => {
  it("cut their own group's shapes and their sibling groups', no deeper and not the parent's own", () => {
    expect(holeScope(nodes, find("door")).map((n) => n.id)).toEqual(["lobby_room", "hall_room"]);
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
    expect(holeScope(loose, find("door")).length).toBe(2);
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

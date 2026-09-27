import { describe, expect, it } from "vitest";
import type { Box, Group, SceneNode } from "./scene.types";
import { ancestry, shapesUnder, childrenOf, commonParent, copyNodes, lockedIds, selectableAt, subtreeIds, topmost } from "./tree";

const group = (id: string, parent?: string): Group => ({ id, type: "group", createdBy: "human", ...(parent ? { parent } : {}) });
const box = (id: string, parent?: string): Box => ({
  id,
  type: "box",
  kind: "volume",
  x: 0,
  z: 0,
  y: 0,
  width: 1,
  depth: 1,
  height: 1,
  rotation: 0,
  color: "almost-white",
  createdBy: "human",
  ...(parent ? { parent } : {}),
});

// lobby (group_1) holds box_1 and hall (group_2), which holds box_2 and box_3. box_4 is at the top level.
// The list isn't in tree order on purpose.
const nodes: SceneNode[] = [box("box_2", "group_2"), group("group_1"), box("box_1", "group_1"), group("group_2", "group_1"), box("box_3", "group_2"), box("box_4")];

describe("tree", () => {
  it("locks a node and everything in it", () => {
    expect(lockedIds(nodes).size).toBe(0);
    const locked = nodes.map((n) => (n.id === "group_2" || n.id === "box_4" ? { ...n, locked: true as const } : n));
    expect([...lockedIds(locked)].sort()).toEqual(["box_2", "box_3", "box_4", "group_2"]);
  });

  it("lists children in list order", () => {
    expect(childrenOf(nodes, undefined).map((n) => n.id)).toEqual(["group_1", "box_4"]);
    expect(childrenOf(nodes, "group_2").map((n) => n.id)).toEqual(["box_2", "box_3"]);
  });

  it("finds a subtree and the boxes under nodes, each once, in list order", () => {
    expect([...subtreeIds(nodes, "group_1")].sort()).toEqual(["box_1", "box_2", "box_3", "group_1", "group_2"]);
    expect(shapesUnder(nodes, ["group_2", "box_3", "box_4"]).map((b) => b.id)).toEqual(["box_2", "box_3", "box_4"]);
  });

  it("walks up to the top level", () => {
    expect(ancestry(nodes, "box_3")).toEqual(["box_3", "group_2", "group_1"]);
  });

  it("resolves a click to the node at the current level", () => {
    expect(selectableAt(nodes, "box_3", null)).toBe("group_1");
    expect(selectableAt(nodes, "box_4", null)).toBe("box_4");
    expect(selectableAt(nodes, "box_3", "group_1")).toBe("group_2");
    expect(selectableAt(nodes, "box_3", "group_2")).toBe("box_3");
    expect(selectableAt(nodes, "box_4", "group_1")).toBeNull();
  });

  it("finds the deepest group holding every node", () => {
    expect(commonParent(nodes, ["box_2", "box_3"])).toBe("group_2");
    expect(commonParent(nodes, ["box_2", "box_1"])).toBe("group_1");
    expect(commonParent(nodes, ["box_2", "box_4"])).toBeUndefined();
  });

  it("keeps only the listed nodes that aren't inside another listed node, in the given order", () => {
    expect(topmost(nodes, ["box_4", "box_3", "group_1", "group_2"])).toEqual(["box_4", "group_1"]);
  });

  it("copies a subtree with fresh IDs, remapping parents inside it and keeping the others", () => {
    let n = 10;
    const source = nodes.filter((x) => subtreeIds(nodes, "group_2").has(x.id)).map((x) => (x.id === "box_2" ? { ...x, name: "pillar", x: 0.1 } : x));
    const copies = copyNodes(source, (type) => `${type}_${n++}`, { dx: 0.2, dz: -1 });
    // box_2, group_2, box_3 → box_10, group_11, box_12; group_2's own parent (group_1) is outside the set.
    expect(copies.map((c) => [c.id, c.parent])).toEqual([
      ["box_10", "group_11"],
      ["group_11", "group_1"],
      ["box_12", "group_11"],
    ]);
    expect(copies[0]).toMatchObject({ name: "pillar", x: 0.3, y: 0, z: -1 });
    expect(source[0].id).toBe("box_2");
  });
});

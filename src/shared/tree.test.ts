import { describe, expect, it } from "vitest";
import type { Box, Group, SceneNode } from "./scene.types";
import { ancestry, boxesUnder, childrenOf, commonParent, selectableAt, subtreeIds } from "./tree";

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
  it("lists children in list order", () => {
    expect(childrenOf(nodes, undefined).map((n) => n.id)).toEqual(["group_1", "box_4"]);
    expect(childrenOf(nodes, "group_2").map((n) => n.id)).toEqual(["box_2", "box_3"]);
  });

  it("finds a subtree and the boxes under nodes, each once, in list order", () => {
    expect([...subtreeIds(nodes, "group_1")].sort()).toEqual(["box_1", "box_2", "box_3", "group_1", "group_2"]);
    expect(boxesUnder(nodes, ["group_2", "box_3", "box_4"]).map((b) => b.id)).toEqual(["box_2", "box_3", "box_4"]);
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
});

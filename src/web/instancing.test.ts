import { beforeEach, describe, expect, it } from "vitest";
import { expandNodes, expandShapes, setDefinitions } from "../shared/entities";
import { cutters } from "../shared/holes";
import type { ArrayNode, Box, SceneNode } from "../shared/scene.types";
import { isShape } from "../shared/tree";
import { splitInstanced } from "./instancing";

/** A merlon (one volume), and a window (a wall-less hole) with a frame volume. */
const MERLON: SceneNode[] = [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 0.6, depth: 0.4, height: 0.8, rotation: 0, color: "gray", createdBy: "human" }];
const FRAMED: SceneNode[] = [
  { id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 0.2, height: 1, rotation: 0, color: "gray", createdBy: "human" },
  { id: "box_2", type: "box", kind: "hole", x: 0, z: 0, y: 0.2, width: 0.5, depth: 1, height: 0.5, rotation: 0, color: "white", createdBy: "human" },
];
const row = (entity: string, fields: Partial<ArrayNode> = {}): ArrayNode => ({
  id: "array_1",
  type: "array",
  entities: [{ entity }],
  layout: { type: "path", points: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }], place: "spacing", spacing: 2 },
  createdBy: "human",
  ...fields,
});
const drawnOf = (nodes: SceneNode[]) => expandShapes(nodes.filter(isShape));

beforeEach(() => setDefinitions({ merlon: MERLON, framed: FRAMED }));

describe("drawing arrays instanced", () => {
  it("instances every item of an array, leaving their shapes out of the one-by-one list", () => {
    const nodes = [row("merlon")];
    const { boxes, groups } = splitInstanced(drawnOf(nodes), [row("merlon")], cutters(expandNodes(nodes)));
    expect(boxes).toEqual([]);
    expect(groups).toEqual([expect.objectContaining({ array: "array_1", entity: "merlon" })]);
    expect(groups[0].items.map((i) => i.x)).toEqual([0, 2, 4]);
  });

  it("instances items cut by their own holes, but keeps the holes (ghosts) one by one", () => {
    const nodes = [row("framed")];
    const { boxes, groups } = splitInstanced(drawnOf(nodes), [row("framed")], cutters(expandNodes(nodes)));
    expect(groups[0].items).toHaveLength(3);
    expect(boxes.map((b) => b.id)).toEqual(["array_1/0/box_2", "array_1/1/box_2", "array_1/2/box_2"]);
  });

  it("draws an item cut by a hole from outside one by one, and a missing entity's items too", () => {
    // A door in its own group beside the array (a hole reaches the groups beside its own), through the middle item.
    const door: Box = { id: "box_9", type: "box", kind: "hole", parent: "group_2", x: 2, z: 0, y: 0, width: 1, depth: 1, height: 2, rotation: 0, color: "white", createdBy: "human" };
    const nodes: SceneNode[] = [
      { id: "group_1", type: "group", createdBy: "human" },
      { id: "group_2", type: "group", parent: "group_1", createdBy: "human" },
      row("merlon", { parent: "group_1" }),
      door,
    ];
    const { boxes, groups } = splitInstanced(drawnOf(nodes), [row("merlon", { parent: "group_1" })], cutters(expandNodes(nodes)));
    expect(groups[0].items.map((i) => i.index)).toEqual([0, 2]);
    expect(boxes.map((b) => b.id)).toEqual(["array_1/1/box_1", "box_9"]);
    const missing = [row("gone")];
    expect(splitInstanced(drawnOf(missing), missing, new Map()).groups).toEqual([]);
  });
});

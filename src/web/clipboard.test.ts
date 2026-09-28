import { describe, expect, it } from "vitest";
import type { SceneNode } from "../shared/scene.types";
import { clipboardText, readClipboard } from "./clipboard";

const box = (id: string, parent?: string): SceneNode => ({
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
const nodes: SceneNode[] = [box("box_1", "group_1"), { id: "group_1", type: "group", name: "lobby", createdBy: "human" }, box("box_2"), box("box_3", "group_1")];

describe("clipboard", () => {
  it("copies the selection with whole subtrees, in list order, and reads it back", () => {
    const text = clipboardText(nodes, ["group_1"]);
    expect(JSON.parse(text).orlablocks).toBe("nodes");
    expect(readClipboard(text)?.map((n) => n.id)).toEqual(["box_1", "group_1", "box_3"]);
    expect(readClipboard(clipboardText(nodes, ["box_3", "group_1"]))?.map((n) => n.id)).toEqual(["box_1", "group_1", "box_3"]);
  });

  it("ignores anything that isn't ours", () => {
    expect(readClipboard(undefined)).toBeNull();
    expect(readClipboard("")).toBeNull();
    expect(readClipboard("just some text")).toBeNull();
    expect(readClipboard('{"nodes": []}')).toBeNull();
    expect(readClipboard('{"orlablocks": "nodes", "nodes": []}')).toBeNull();
    expect(readClipboard(JSON.stringify({ orlablocks: "nodes", nodes: [{ ...nodes[2], width: -1 }] }))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { cutters } from "./holes";
import { IncrementalCuts } from "./incrementalCuts";
import type { Box, ClosedShape, SceneNode } from "./scene.types";

const box = (id: string, x: number, props: Partial<Box> = {}): Box => ({
  id, type: "box", kind: "volume", x, y: 0, z: 0, width: 4, depth: 4, height: 3, rotation: 0,
  color: "white", createdBy: "human", cutTags: ["a", "b"], ...props,
});

describe("incremental cut relationships", () => {
  it("matches the full scan through movement, retagging, reordering, visibility, deletion and undo", () => {
    const a = box("a", 0), b = box("b", 25), c = box("c", 50);
    const moving = box("moving", 0, { kind: "hole", pitch: 25 });
    const near = box("near", 25, { kind: "hole", cutTags: ["b"] });
    const far = box("far", 50, { kind: "hole", cutTags: ["a"] });
    const initial = [a, b, c, moving, near, far];
    const graph = new IncrementalCuts();
    const sorted = (cuts: Map<string, ClosedShape[]>) => [...cuts].sort(([id], [other]) => id.localeCompare(other));
    const check = (nodes: Box[]) => {
      const actual = graph.update(nodes);
      expect(sorted(actual)).toEqual(sorted(cutters(nodes)));
      return actual;
    };
    const first = check(initial);
    const moved = { ...moving, x: 25 };
    const second = check([a, b, c, moved, near, far]);
    expect(first.get(a.id)).toEqual([moving]);
    expect(second.has(a.id)).toBe(false);
    expect(second.get(c.id)).toBe(first.get(c.id));
    check([a, b, c, near, moved, far]);
    check([a, { ...b, cutTags: ["a"] }, c, near, moved, far]);
    check([a, c, near, { ...moved, cutTags: [] }, far]);
    check([a, b, c, moved, far]); // hidden cutter was filtered from the viewport input
    check(initial);
    check([]);
    check(initial);
  });

  it("invalidates terrain-source ownership on reparent and definition-local namespaces on replacement", () => {
    const target = box("placement/a", 0, { cutTags: ["a", "placement:local"] });
    const own = box("placement/own", 0, { kind: "hole", cutTags: ["a", "placement:local"] });
    const external = box("h", 0, { kind: "hole", parent: "child" });
    const child = { id: "child", type: "group", createdBy: "human", parent: "source" } as const;
    const base: SceneNode[] = [
      target, own, external,
      { id: "source", type: "group", createdBy: "human" },
      { id: "terrain", type: "terrain", x: 0, y: 0, z: 0, width: 20, depth: 20, color: "white", resolution: 129, source: "source", createdBy: "human" },
    ];
    const graph = new IncrementalCuts();
    const check = (nodes: SceneNode[], holes?: Box[]) => {
      expect(graph.update(nodes)).toEqual(cutters(nodes));
      expect(graph.update(nodes).get(target.id)).toEqual(holes);
    };
    check([...base, child], [own]);
    check([...base, { ...child, parent: undefined }], [own, external]);
    check([target, { ...own, cutTags: ["a"] }, ...base.slice(2), child]);
  });
});

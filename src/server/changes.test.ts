import { describe, expect, it } from "vitest";
import type { Box, SceneNode } from "../shared/scene.types";
import { createChangeLog, diffNodes } from "./changes";

const box = (id: string, patch: Partial<Box> = {}): Box => ({
  id,
  type: "box",
  kind: "volume",
  x: 0,
  z: 0,
  y: 0,
  width: 2,
  depth: 2,
  height: 1,
  rotation: 0,
  color: "gray",
  createdBy: "human",
  ...patch,
});

describe("the change log (14.6)", () => {
  it("gives the net diff from a step to now: added then removed is nothing, several updates merge", () => {
    const log = createChangeLog();
    const a = box("box_1");
    log.reset(3, [a]);
    const b = box("box_2");
    log.record({ seq: 4, actor: "agent", label: "Agent: draw box_2", at: 1, kind: "commit" }, [a, b]);
    const c = box("box_3");
    log.record({ seq: 5, actor: "human", label: "Draw box_3", at: 2, kind: "commit" }, [a, b, c]);
    log.record({ seq: 6, actor: "human", label: "Remove box_3", at: 3, kind: "commit" }, [a, b]);
    const taller = { ...a, height: 5 };
    log.record({ seq: 7, actor: "human", label: "Height", at: 4, kind: "commit" }, [taller, b]);
    const moved = { ...taller, x: 3 };
    log.record({ seq: 8, actor: "human", label: "Move", at: 5, kind: "commit" }, [moved, b]);
    expect(log.lastBy("agent")).toBe(4);
    const { steps, before } = log.since(4);
    expect(steps.map((s) => s.seq)).toEqual([5, 6, 7, 8]);
    const diff = diffNodes(before!, [moved, b]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([{ id: "box_1", type: "box", fields: { height: "1 → 5", x: "0 → 3" } }]);
  });

  it("says when a step is older than it keeps", () => {
    const log = createChangeLog(2);
    log.reset(0, []);
    for (let i = 1; i <= 4; i++) log.record({ seq: i, actor: "human", label: `s${i}`, at: i, kind: "commit" }, [box(`box_${i}`)]);
    expect(log.oldest()).toBe(2);
    expect(log.since(1).before).toBeNull();
    expect(log.since(3).before).toEqual([box("box_3")]);
  });

  it("names point lists by their count and objects by the keys that changed", () => {
    const f = (points: number, layout: object) => ({ id: "x", type: "array", layout, points: Array.from({ length: points }, () => 0) }) as unknown as SceneNode;
    const diff = diffNodes([f(12, { type: "circle", radius: 5, count: 4 })], [f(14, { type: "circle", radius: 6, count: 4 })]);
    expect(diff.changed[0].fields).toEqual({ layout: "changed (radius)", points: "12 → 14 (changed)" });
  });
});

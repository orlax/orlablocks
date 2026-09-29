import { describe, expect, it } from "vitest";
import { setDefinitions } from "../shared/entities";
import type { SceneNode } from "../shared/scene.types";
import { lintScene } from "./lint";

const base = { rotation: 0, color: "gray", createdBy: "agent" } as const;
const block = [{ ...base, id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 1, height: 1 }] as SceneNode[];

describe("lintScene (14.8)", () => {
  it("flags an instance floating over nothing, but not one on a platform or one allowed to", () => {
    setDefinitions({ block });
    const nodes: SceneNode[] = [
      { ...base, id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 10, depth: 10, height: 4 },
      { ...base, id: "instance_1", type: "instance", entity: "block", x: 0, y: 4, z: 0 },
      { ...base, id: "instance_2", type: "instance", entity: "block", x: 30, y: 122, z: 0 },
      { ...base, id: "instance_3", type: "instance", entity: "block", x: 40, y: 50, z: 0 },
    ];
    const { findings } = lintScene(nodes, { floats: ["instance_3"] });
    expect(findings.filter((f) => f.check === "floating").map((f) => f.id)).toEqual(["instance_2"]);
    expect(findings[0].message).toMatch(/floats 122 m/);
  });

  it("flags notes that name what's gone, entities off their pivot, and duplicates", () => {
    setDefinitions({ block, aside: [{ ...block[0], x: 5 } as SceneNode] });
    const nodes: SceneNode[] = [
      { ...base, id: "box_2", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 2, depth: 2, height: 1 },
      { ...base, id: "box_3", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 2, depth: 2, height: 1 },
      { ...base, id: "note_1", type: "note", x: 0, y: 0, z: 0, text: "between box_2 and box_9", color: "yellow", status: "open" },
      { ...base, id: "instance_1", type: "instance", entity: "aside", x: 20, y: 0, z: 0 },
    ];
    const { findings } = lintScene(nodes, { checks: ["stale_notes", "off_center", "duplicates"] });
    expect(findings.map((f) => [f.check, f.id])).toEqual([
      ["stale_notes", "note_1"],
      ["off_center", "aside"],
      ["duplicates", "box_3"],
    ]);
  });
});

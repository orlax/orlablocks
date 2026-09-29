import { beforeEach, describe, expect, it } from "vitest";
import { setDefinitions } from "../shared/entities";
import { checkSight } from "../shared/sight";
import type { SceneNode } from "../shared/scene.types";
import { createSceneStore } from "./scene";

/** A column 1 × 1 × 4 around its pivot. */
const COLUMN: SceneNode[] = [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 1, height: 4, rotation: 0, color: "gray", createdBy: "human" }];
beforeEach(() => setDefinitions({ column: COLUMN }));
const store = () => createSceneStore({ entityName: (id) => (id === "column" ? id : undefined) });

/** A 10 × 10 room (walls 0.2) in a group, a relic inside it, and an eye outside its south wall. */
function hall(door: boolean) {
  const s = store();
  s.drawShapes(
    [
      { type: "group", ref: "hall" },
      { kind: "room", x: 0, z: 0, width: 10, depth: 10, height: 4, parent: "$hall" },
      ...(door ? [{ kind: "hole" as const, x: 0, z: 5, width: 3, depth: 1, height: 3.5, parent: "$hall" }] : []),
      { kind: "volume", x: 0, z: -2, width: 1, depth: 1, height: 1.5, name: "relic", ref: "relic" },
    ],
    "agent",
  );
  return s;
}
const eye = { label: "outside", eye: { x: 0, y: 1.65, z: 9 } };

describe("check_sight (plan 13 §8)", () => {
  it("is blocked by a wall", () => {
    const s = hall(false);
    const [pair] = checkSight(s.getScene().nodes, [eye], ["box_2"]);
    expect(pair.visible).toBe(0);
    expect(pair.blockers).toEqual(["box_1"]);
  });

  it("sees through a door hole in the wall", () => {
    const s = hall(true);
    const [pair] = checkSight(s.getScene().nodes, [eye], ["box_3"]);
    expect(pair.visible).toBeGreaterThan(0.9);
    expect(pair.blockers).toEqual([]);
  });

  it("names blockers nearest first, items as array_N/i, and leaves out what's ignored or hidden", () => {
    const s = hall(true);
    s.drawShapes(
      [
        { type: "array", entity: "column", layout: { type: "path", points: [{ x: -1, y: 0, z: 2 }, { x: 1, y: 0, z: 2 }], place: "count", count: 3 } },
        { kind: "volume", x: 0, z: 0, width: 4, depth: 0.5, height: 3, name: "screen" },
      ],
      "agent",
    );
    const nodes = s.getScene().nodes;
    const [pair] = checkSight(nodes, [eye], ["box_3"]);
    expect(pair.blockers[0]).toMatch(/^array_1\/\d$/);
    expect(pair.blockers.at(-1)).toBe("box_4");
    // Ignoring both: back in sight.
    expect(checkSight(nodes, [eye], ["box_3"], ["array_1", "box_4"])[0].visible).toBeGreaterThan(0.9);
    // A hidden node doesn't block either.
    s.updateNodes([{ id: "box_4", hidden: true }], "human");
    expect(checkSight(s.getScene().nodes, [eye], ["box_3"], ["array_1"])[0].blockers).toEqual([]);
  });

  it("refuses a target with nothing to see", () => {
    expect(() => checkSight(hall(false).getScene().nodes, [eye], ["nope"])).toThrow(/nothing to see/);
  });
});

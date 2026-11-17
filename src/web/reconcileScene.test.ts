import { expect, it } from "vitest";
import { DEFAULT_VIEW, type Scene } from "../shared/scene.types";
import { reconcileScene } from "./reconcileScene";

const snapshot = (input: Scene): Scene => JSON.parse(JSON.stringify(input));

it("preserves equal nodes across snapshots, moves and undo, while respecting order and deletion", () => {
  const first: Scene = {
    view: DEFAULT_VIEW,
    selection: ["a"],
    nodes: [
      { id: "a", type: "group", createdBy: "human", name: "First" },
      { id: "b", type: "instance", entity: "door", x: 3, y: 0, z: 2, rotation: 45, createdBy: "human", cutTagParts: { panel: ["entry"] } },
    ],
  };
  const camera = snapshot({ ...first, view: { ...DEFAULT_VIEW, yaw: 90 } });
  const same = reconcileScene(first, camera);
  expect(same.nodes).toBe(first.nodes);
  expect(same.selection).toBe(first.selection);
  expect(same.view.yaw).toBe(90);

  const next = snapshot(first);
  const [a, b] = next.nodes;
  next.nodes = [b, { ...a, name: "Renamed" }];
  const edited = reconcileScene(same, next);
  expect(edited.nodes[0]).toBe(first.nodes[1]);
  expect(edited.nodes[1]).toBe(next.nodes[1]);
  const undone = reconcileScene(edited, snapshot(first));
  expect(undone.nodes).toEqual(first.nodes);
  expect(undone.nodes[1]).toBe(first.nodes[1]);
  expect(reconcileScene(undone, { ...next, nodes: [next.nodes[0]] }).nodes).toEqual([first.nodes[1]]);
  expect(reconcileScene(null, next)).toBe(next);
});

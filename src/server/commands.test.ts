import { describe, expect, it } from "vitest";
import type { Box } from "../shared/scene.types";
import { applyOp, createHistory, runOps, type HistoryEntry, type Op } from "./commands";

const box = (id: string): Box => ({
  id,
  kind: id.startsWith("room") ? "room" : "volume",
  x: 0,
  z: 0,
  width: 1,
  depth: 1,
  height: 1,
  createdBy: "human",
});

const entry = (boxes: Box[], ops: Op[], label = "test"): { boxes: Box[]; entry: HistoryEntry } => {
  const result = runOps(boxes, ops);
  return { boxes: result.boxes, entry: { label, actor: "human", at: 0, ops, inverse: result.inverse } };
};

describe("ops", () => {
  it("add then its inverse is a no-op", () => {
    const start = [box("room_1")];
    const { boxes, inverse } = runOps(start, [{ op: "add", boxes: [box("room_2"), box("volume_1")] }]);
    expect(boxes.map((b) => b.id)).toEqual(["room_1", "room_2", "volume_1"]);
    expect(inverse.reduce(applyOp, boxes)).toEqual(start);
  });

  it("remove's inverse restores boxes at their original positions", () => {
    const start = ["room_1", "room_2", "volume_1", "room_3"].map(box);
    const { boxes, inverse } = runOps(start, [{ op: "remove", ids: ["room_2", "room_3"] }]);
    expect(boxes.map((b) => b.id)).toEqual(["room_1", "volume_1"]);
    expect(inverse.reduce(applyOp, boxes)).toEqual(start);
  });

  it("multi-op commands undo in reverse order", () => {
    const start = [box("room_1")];
    const { boxes, inverse } = runOps(start, [
      { op: "add", boxes: [box("room_2")] },
      { op: "remove", ids: ["room_1"] },
    ]);
    expect(boxes.map((b) => b.id)).toEqual(["room_2"]);
    expect(inverse.reduce(applyOp, boxes)).toEqual(start);
  });

  it("update's inverse restores the previous heights", () => {
    const start = [box("room_1"), box("volume_1")];
    const { boxes, inverse } = runOps(start, [{ op: "update", changes: [{ id: "volume_1", height: 2.5 }] }]);
    expect(boxes.map((b) => b.height)).toEqual([1, 2.5]);
    expect(inverse.reduce(applyOp, boxes)).toEqual(start);
    expect(() => runOps(start, [{ op: "update", changes: [{ id: "room_9", height: 1 }] }])).toThrow(/room_9/);
  });

  it("rejects removing an unknown box", () => {
    expect(() => runOps([box("room_1")], [{ op: "remove", ids: ["room_9"] }])).toThrow(/room_9/);
  });

  it("never mutates the input list", () => {
    const start = [box("room_1")];
    const frozen = Object.freeze([...start]);
    runOps(frozen as Box[], [{ op: "add", boxes: [box("room_2")] }, { op: "remove", ids: ["room_1"] }]);
    expect(frozen).toEqual(start);
  });
});

describe("history", () => {
  it("undoes and redoes the latest entry", () => {
    const history = createHistory();
    const a = entry([], [{ op: "add", boxes: [box("room_1")] }], "Draw room_1");
    history.push(a.entry);
    const b = entry(a.boxes, [{ op: "add", boxes: [box("room_2")] }], "Draw room_2");
    history.push(b.entry);

    expect(history.summary()).toEqual({ canUndo: true, canRedo: false, undoLabel: "Draw room_2", redoLabel: undefined });
    const undone = history.undo(b.boxes)!;
    expect(undone.boxes.map((x) => x.id)).toEqual(["room_1"]);
    expect(history.summary()).toMatchObject({ undoLabel: "Draw room_1", redoLabel: "Draw room_2" });
    const redone = history.redo(undone.boxes)!;
    expect(redone.boxes).toEqual(b.boxes);
  });

  it("a new edit clears the redo stack", () => {
    const history = createHistory();
    const a = entry([], [{ op: "add", boxes: [box("room_1")] }]);
    history.push(a.entry);
    history.undo(a.boxes);
    expect(history.summary().canRedo).toBe(true);
    history.push(entry([], [{ op: "add", boxes: [box("room_2")] }]).entry);
    expect(history.summary().canRedo).toBe(false);
  });

  it("returns null with nothing to undo or redo", () => {
    const history = createHistory();
    expect(history.undo([])).toBeNull();
    expect(history.redo([])).toBeNull();
  });

  it("drops the oldest entries past the limit", () => {
    const history = createHistory(2);
    let boxes: Box[] = [];
    for (const id of ["room_1", "room_2", "room_3"]) {
      const e = entry(boxes, [{ op: "add", boxes: [box(id)] }]);
      boxes = e.boxes;
      history.push(e.entry);
    }
    boxes = history.undo(boxes)!.boxes;
    boxes = history.undo(boxes)!.boxes;
    expect(history.undo(boxes)).toBeNull();
    expect(boxes.map((b) => b.id)).toEqual(["room_1"]);
  });
});

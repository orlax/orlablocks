import { describe, expect, it } from "vitest";
import { mirrorShape, volumeRings } from "../shared/geometry";
import { surfaceUnder } from "../shared/ray";
import { NodeSchema, type Cylinder } from "../shared/scene.types";
import { createSceneStore } from "./scene";

// Authored for the verification handoff; not run in the implementation session.
describe("19.4 room contracts", () => {
  const input = { type: "cylinder", kind: "room", x: 0, z: 0, width: 20, depth: 20, height: 3,
    floor: false, arc: { from: 252, sweep: 296 } } as const;

  it("retains floor/arc through stored schema, updates and undo", () => {
    const store = createSceneStore();
    const [room] = store.drawShapes([input], "agent");
    expect(NodeSchema.parse(room)).toMatchObject(input);
    store.updateNodes([{ id: room.id, floor: true, arc: { from: 350, sweep: 101 } }], "agent");
    store.undo();
    expect(store.getScene().nodes[0]).toMatchObject(input);
    store.redo();
    expect(store.getScene().nodes[0]).toMatchObject({ floor: true, arc: { from: 350, sweep: 101 } });
    store.updateNodes([{ id: room.id, arc: null, kind: "volume", taper: -1 }], "agent");
    const changed = store.getScene().nodes[0] as Cylinder;
    expect(changed.arc).toBeUndefined();
    expect(changed.floor).toBeUndefined();
    expect(volumeRings(changed)[0].ring.every((p) => p.x === 0 && p.z === 0)).toBe(true);
  });

  it("rejects unsupported arc edits atomically and preserves mirrored local angles", () => {
    const store = createSceneStore();
    const [room] = store.drawShapes([input], "agent");
    for (const patch of [{ depth: 21 }, { sides: 12 }, { kind: "volume" as const }]) {
      expect(() => store.updateNodes([{ id: room.id, name: "must not change", ...patch }], "agent")).toThrow(/arc/);
      expect(store.getScene().nodes[0]).toEqual(room);
    }
    for (const axis of ["x", "z"] as const) {
      const source = room as Cylinder;
      const mirrored = { ...source, ...mirrorShape(source, axis, 0) } as Cylinder;
      const restored = { ...mirrored, ...mirrorShape(mirrored, axis, 0) };
      expect(restored.arc).toEqual(source.arc);
      expect(restored.rotation).toEqual(source.rotation);
    }
  });

  it("does not expose an invisible floor as a drawing surface", () => {
    const store = createSceneStore();
    const [room] = store.drawShapes([{ ...input, arc: { from: 0, sweep: 360 } }], "agent");
    const ray = { origin: { x: 0, y: 10, z: 0 }, dir: { x: 0, y: -1, z: 0 } };
    expect(surfaceUnder(ray, [room as Cylinder])).toBeNull();
    const [floored] = store.updateNodes([{ id: room.id, floor: true }], "agent");
    expect(surfaceUnder(ray, [floored as Cylinder])).toMatchObject({ what: "floor", y: 0 });
  });
});

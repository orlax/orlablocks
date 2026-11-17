import { Matrix3, Vector3 } from "three";
import { expect, it } from "vitest";
import type { Box, Shape } from "../shared/scene.types";
import { prepareGeometry, shapeGeometryKey, shapeMatrix } from "./geometryWork";
import { STATIC_CAPACITY, splitStaticBatches } from "./staticBatches";

const room = (id: string, extra: Partial<Box> = {}): Box => ({
  id, type: "box", kind: "room", x: 2.4, y: 1.2, z: 2.7, width: 4, depth: 3, height: 2, rotation: 23,
  pitch: 12, roll: 8, color: "gray", createdBy: "human", ...extra,
});

it("preserves world placement, map UVs and floor/edge geometry in spatial batches", () => {
  const first = room("room");
  const second = room("next", { x: 16.32, floor: false, rotation: 0 });
  const batch = prepareGeometry({ kind: "batch", shapes: [first, second] });
  const originals = [first, second].map((shape) => prepareGeometry({ kind: "shape", shape }));
  let offset = 0;
  for (const [index, part] of originals.entries()) {
    const matrix = shapeMatrix([first, second][index]);
    const normalMatrix = new Matrix3().getNormalMatrix(matrix);
    const mesh = part.body!;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const vertex = new Vector3().fromArray(mesh.positions, i).applyMatrix4(matrix);
      const normal = new Vector3().fromArray(mesh.normals, i).applyNormalMatrix(normalMatrix);
      expect(new Vector3().fromArray(batch.body!.positions, offset + i).distanceTo(vertex)).toBeLessThan(0.00001);
      expect(new Vector3().fromArray(batch.body!.normals, offset + i).distanceTo(normal)).toBeLessThan(0.00001);
    }
    expect(batch.body!.uvs.slice(offset / 3 * 2, (offset + mesh.positions.length) / 3 * 2)).toEqual(mesh.uvs);
    offset += mesh.positions.length;
  }
  expect(batch.floor!.positions.length).toBe(originals[0].floor!.positions.length);
  expect(batch.edges!.length).toBe(originals[0].edges!.length + originals[1].edges!.length);
});

it("keeps dynamic, cut, terrain source, large and translucent shapes on individual paths", () => {
  const stable = Array.from({ length: STATIC_CAPACITY + 3 }, (_, i) => room(`r${i}`));
  const hole = room("hole", { kind: "hole" });
  const individual: Shape[] = [
    hole, room("cut"), room("modifier"),
    room("dynamic"), room("wide", { width: 100 }), room("distant", { x: 150 }),
  ];
  const cuts = new Map([["cut", [hole]]]);
  const split = (shapes: Shape[]) => splitStaticBatches(shapes, cuts, new Set(["modifier"]), new Set(["dynamic"]));
  const all = [...stable, ...individual];
  const initial = split(all);
  expect(initial.individual).toEqual(individual);
  expect(initial.batches.map((batch) => batch.shapes.length)).toEqual([STATIC_CAPACITY, 3]);
  const renamed = split([{ ...stable[0], name: "First room" }, ...all.slice(1)]);
  const edited = split([{ ...stable[0], x: 4 }, ...all.slice(1)]);
  expect(renamed.batches[0].signature).toBe(initial.batches[0].signature);
  expect(edited.batches[0].signature).not.toBe(initial.batches[0].signature);
  expect(edited.batches[1].signature).toBe(initial.batches[1].signature);
  expect(shapeGeometryKey(stable[0], [hole])).not.toBe(shapeGeometryKey(stable[0], [{ ...hole, y: -1 }]));
});

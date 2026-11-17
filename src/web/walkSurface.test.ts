import { InstancedMesh, Matrix4, MeshBasicMaterial, Raycaster, Scene, Vector3 } from "three";
import { expect, it } from "vitest";
import { loadManifold } from "../server/manifold";
import { bakeShape, toBufferGeometry } from "../shared/bake";
import type { Box } from "../shared/scene.types";
import { floorAt } from "./walkSurface";

it("Walk rays respect a scaled and tilted instance's cut floor and reject a steep copy", async () => {
  await loadManifold();
  const room: Box = {
    id: "room", type: "box", kind: "room", x: 0, y: 0, z: 0, width: 8, depth: 8, height: 3,
    rotation: 0, createdBy: "human", color: "white",
  };
  const hole: Box = { ...room, id: "hole", kind: "hole", width: 2, depth: 2, y: -1 };
  const geometry = toBufferGeometry(bakeShape(room, [hole]).floor!);
  const material = new MeshBasicMaterial();
  const mesh = new InstancedMesh(geometry, material, 2);
  mesh.setMatrixAt(0, new Matrix4().makeRotationX(Math.PI / 12).scale(new Vector3(2, 2, 2)).setPosition(20, 2, 0));
  mesh.setMatrixAt(1, new Matrix4().makeRotationX(Math.PI * 0.45).setPosition(40, 2, 0));
  mesh.userData.walkable = true;
  const scene = new Scene();
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  const raycaster = new Raycaster();
  expect(floorAt(scene, raycaster, { x: 20, y: 2, z: 0 })).toBe(0);
  expect(floorAt(scene, raycaster, { x: 24, y: 2, z: 0 })).toBeCloseTo(2.083, 2);
  expect(floorAt(scene, raycaster, { x: 42, y: 2.3, z: 0 })).toBe(0);
  material.dispose();
  mesh.dispose();
  geometry.dispose();
});

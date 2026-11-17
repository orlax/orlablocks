import { InstancedMesh, Matrix4, Vector3, type Mesh, type Object3D, type Raycaster, type Scene } from "three";
import { floorUnder, STEP_HEIGHT, type Vec3 } from "./walk";

const down = new Vector3(0, -1, 0);

/** The standable floor under the feet, using the rendered (possibly cut and instanced) geometry. */
export function floorAt(scene: Scene, raycaster: Raycaster, feet: Vec3): number | null {
  const walkables: Object3D[] = [];
  scene.traverse((object) => {
    if (object.userData.walkable && (object as Mesh).isMesh) walkables.push(object);
  });
  raycaster.set(new Vector3(feet.x, feet.y + STEP_HEIGHT, feet.z), down);
  const instance = new Matrix4();
  const hits = raycaster.intersectObjects(walkables, false).map((hit) => {
    let matrix = hit.object.matrixWorld;
    if (hit.instanceId !== undefined && hit.object instanceof InstancedMesh) {
      hit.object.getMatrixAt(hit.instanceId, instance);
      matrix = instance.premultiply(matrix);
    }
    return { y: hit.point.y, up: hit.face ? hit.face.normal.clone().transformDirection(matrix).y : 0 };
  });
  return floorUnder(hits, feet.y);
}

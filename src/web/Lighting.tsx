import { useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { visibleGround, type CameraState } from "./camera";

/** Where the sun comes from, relative to the focus point. Fixed in the world, so rotating the view shows other sides lit. */
const SUN_OFFSET = new THREE.Vector3(-30, 60, 20);
const SHADOW_MAP = 2048;
const MIN_SHADOW_RADIUS = 20;
const MAX_SHADOW_RADIUS = 120; // beyond this, shadows get too blurry to be worth it: they just fade out at the edges

/**
 * Graybox lighting: a sky/ground hemisphere light for soft fill, and a sun that casts shadows.
 * The sun and its shadow camera follow the focus point and cover the visible ground, so shadows
 * stay sharp at any pan and reasonable at any zoom. A transparent ground plane catches the shadows.
 */
export function Lighting({ cam }: { cam: RefObject<CameraState> }) {
  const sun = useRef<THREE.DirectionalLight>(null);
  const catcher = useRef<THREE.Mesh>(null);
  const size = useThree((s) => s.size);

  useFrame(() => {
    const light = sun.current;
    if (!light) return;
    const { focus } = cam.current;
    light.position.set(focus.x + SUN_OFFSET.x, SUN_OFFSET.y, focus.z + SUN_OFFSET.z);
    light.target.position.set(focus.x, 0, focus.z);
    light.target.updateMatrixWorld();
    catcher.current?.position.set(focus.x, 0.001, focus.z);

    const farthest = Math.max(...visibleGround(cam.current, size).map((g) => Math.hypot(g.x - focus.x, g.z - focus.z)));
    const r = THREE.MathUtils.clamp(farthest, MIN_SHADOW_RADIUS, MAX_SHADOW_RADIUS);
    const shadowCam = light.shadow.camera;
    if (shadowCam.right !== r) {
      shadowCam.left = -r;
      shadowCam.right = r;
      shadowCam.top = r;
      shadowCam.bottom = -r;
      shadowCam.updateProjectionMatrix();
    }
  });

  return (
    <>
      <hemisphereLight args={["#ffffff", "#d6d0c4", 1.15]} />
      <directionalLight
        ref={sun}
        color="#fff6e8"
        intensity={1.9}
        castShadow
        shadow-mapSize={[SHADOW_MAP, SHADOW_MAP]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-radius={3}
        shadow-camera-near={1}
        shadow-camera-far={200}
      />
      <mesh ref={catcher} rotation-x={-Math.PI / 2} receiveShadow renderOrder={0}>
        <planeGeometry args={[MAX_SHADOW_RADIUS * 3, MAX_SHADOW_RADIUS * 3]} />
        <shadowMaterial transparent opacity={0.22} depthWrite={false} />
      </mesh>
    </>
  );
}

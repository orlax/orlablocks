import { useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Box } from "../shared/scene.types";
import type { CameraState, Vec3 } from "./camera";

/** The gizmo keeps a roughly constant size on screen: its world size grows with the camera distance. */
const SCALE_PER_METER_OF_DISTANCE = 0.018;
/** Height of the grab point above the box top, in gizmo units (the middle of the cone). */
const HANDLE_OFFSET = 0.78;
/** How close (px) the pointer must be to the grab point to grab it. */
export const HANDLE_HIT_PX = 18;

const COLOR = "#3d7be0";
const COLOR_HOT = "#6fa3f5";

export const gizmoScale = (cam: CameraState) => cam.distance * SCALE_PER_METER_OF_DISTANCE;

/** The world point you grab: above the top center of the box. */
export function handlePoint(box: Box, cam: CameraState): Vec3 {
  return { x: box.x + box.width / 2, y: box.height + HANDLE_OFFSET * gizmoScale(cam), z: box.z + box.depth / 2 };
}

const stemGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8).translate(0, 0.25, 0);
const coneGeometry = new THREE.ConeGeometry(0.22, 0.55, 20).translate(0, 0.5 + 0.275, 0);

/**
 * One handle on top of the selected box: a stem and an up-pointing cone. Drawn on top of everything
 * (no depth test), so it's never hidden behind a wall. The dragging itself is handled by the Viewport.
 */
export function HeightGizmo({ box, cam, hot }: { box: Box; cam: RefObject<CameraState>; hot: boolean }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.position.set(box.x + box.width / 2, box.height, box.z + box.depth / 2);
    g.scale.setScalar(gizmoScale(cam.current));
  });

  const color = hot ? COLOR_HOT : COLOR;
  return (
    <group ref={group}>
      <mesh geometry={stemGeometry} renderOrder={10}>
        <meshBasicMaterial color={color} depthTest={false} transparent />
      </mesh>
      <mesh geometry={coneGeometry} renderOrder={10}>
        <meshBasicMaterial color={color} depthTest={false} transparent />
      </mesh>
    </group>
  );
}

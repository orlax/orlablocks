import { useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CameraState, Vec3 } from "./camera";
import { ARROW, gizmoScale, HEIGHT_HANDLE, type GizmoPart } from "./gizmo";

const COLORS: Record<GizmoPart, { base: string; hot: string }> = {
  x: { base: "#d0473d", hot: "#f07a70" },
  y: { base: "#3f9e4d", hot: "#6fcf7c" },
  z: { base: "#3d6fd0", hot: "#6f9df5" },
  height: { base: "#e8b923", hot: "#f7d768" },
};

// An arrow along +y in gizmo units: a thin shaft and a cone tip, starting ARROW.start away from the anchor.
const shaftLength = ARROW.length - ARROW.tip;
const shaftGeometry = new THREE.CylinderGeometry(0.045, 0.045, shaftLength, 8).translate(0, ARROW.start + shaftLength / 2, 0);
const tipGeometry = new THREE.ConeGeometry(0.16, ARROW.tip, 20).translate(0, ARROW.start + shaftLength + ARROW.tip / 2, 0);
const cubeGeometry = new THREE.BoxGeometry(HEIGHT_HANDLE, HEIGHT_HANDLE, HEIGHT_HANDLE).translate(0, HEIGHT_HANDLE / 2, 0);

/** Turns the +y arrow to point along each axis. */
const ARROW_ROTATION: Record<"x" | "y" | "z", [number, number, number]> = {
  x: [0, 0, -Math.PI / 2],
  y: [0, 0, 0],
  z: [Math.PI / 2, 0, 0],
};

/**
 * The transform gizmo on the selection: world-axis move arrows (x red, y green, z blue) from the top center and,
 * for a single box, the height handle there. A constant size on screen and drawn over everything (no depth
 * test). The dragging itself is handled by the Viewport.
 */
export function TransformGizmo({
  anchor,
  parts,
  hot,
  cam,
}: {
  anchor: Vec3;
  parts: GizmoPart[];
  hot: GizmoPart | null;
  cam: RefObject<CameraState>;
}) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.position.set(anchor.x, anchor.y, anchor.z);
    g.scale.setScalar(gizmoScale(cam.current));
  });

  const color = (part: GizmoPart) => (hot === part ? COLORS[part].hot : COLORS[part].base);
  return (
    <group ref={group}>
      {(["x", "y", "z"] as const)
        .filter((axis) => parts.includes(axis))
        .map((axis) => (
          <group key={axis} rotation={ARROW_ROTATION[axis]}>
            <mesh geometry={shaftGeometry} renderOrder={10}>
              <meshBasicMaterial color={color(axis)} depthTest={false} transparent />
            </mesh>
            <mesh geometry={tipGeometry} renderOrder={10}>
              <meshBasicMaterial color={color(axis)} depthTest={false} transparent />
            </mesh>
          </group>
        ))}
      {parts.includes("height") && (
        <mesh geometry={cubeGeometry} renderOrder={11}>
          <meshBasicMaterial color={color("height")} depthTest={false} transparent />
        </mesh>
      )}
    </group>
  );
}

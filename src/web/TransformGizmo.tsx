import { useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Box } from "../shared/scene.types";
import type { CameraState, Vec3 } from "./camera";
import {
  ARROW,
  gizmoScale,
  HEIGHT_HANDLE,
  isScalePart,
  rotateHandlePlacement,
  ROTATE_RADIUS,
  SCALE_HANDLE,
  scaleHandlePoint,
  type GizmoPart,
  type ScalePart,
} from "./gizmo";

const COLORS: Record<"x" | "y" | "z" | "height", { base: string; hot: string }> = {
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
// A scale handle: a white square tile with a dark rim (a slightly bigger dark tile drawn first, underneath).
const RIM = 0.05;
const scaleGeometry = new THREE.BoxGeometry(SCALE_HANDLE, SCALE_HANDLE / 3, SCALE_HANDLE);
const scaleRimGeometry = new THREE.BoxGeometry(SCALE_HANDLE + 2 * RIM, SCALE_HANDLE / 3 + RIM, SCALE_HANDLE + 2 * RIM);
const SCALE_COLORS = { fill: "#ffffff", hot: "#8fb4f2", rim: "#2b2d33" };

// The rotate handle: a flat ring, open for a quarter turn (the gap faces the corner), with an arrowhead at its end.
// Angles are counterclockwise seen from above, from +x; the gap is centered on -45°.
const RING_ARC = 1.5 * Math.PI;
const ringGeometry = new THREE.TorusGeometry(ROTATE_RADIUS, 0.05, 8, 32, RING_ARC).rotateX(-Math.PI / 2);
// At the arc's end (270°, i.e. +z) the ring runs toward +x: the cone points that way.
const ringTipGeometry = new THREE.ConeGeometry(0.11, 0.24, 16)
  .rotateZ(-Math.PI / 2)
  .translate(0.06, 0, ROTATE_RADIUS);
const ROTATE_COLOR = { base: "#9b59d0", hot: "#c08ef0" };

/** Turns the +y arrow to point along each axis. */
const ARROW_ROTATION: Record<"x" | "y" | "z", [number, number, number]> = {
  x: [0, 0, -Math.PI / 2],
  y: [0, 0, 0],
  z: [Math.PI / 2, 0, 0],
};

/**
 * The transform gizmo on the selection: world-axis move arrows (x red, y green, z blue) from the top center and,
 * for a single box, the height handle there and the 8 scale handles on the top face's corners and edges. A constant size on screen and drawn over everything (no depth
 * test). The dragging itself is handled by the Viewport.
 */
export function TransformGizmo({
  anchor,
  parts,
  boxes,
  hot,
  cam,
}: {
  anchor: Vec3;
  parts: GizmoPart[];
  /** The selected boxes: scale handles need a single one, the rotate handle any. */
  boxes: Box[];
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

  const color = (part: keyof typeof COLORS) => (hot === part ? COLORS[part].hot : COLORS[part].base);
  const box = boxes.length === 1 ? boxes[0] : undefined;
  return (
    <>
      {parts.includes("rotate") && <RotateHandle boxes={boxes} hot={hot === "rotate"} cam={cam} />}
      {box &&
        parts
          .filter(isScalePart)
          .map((part) => <ScaleHandle key={part} box={box} part={part} hot={hot === part} cam={cam} />)}
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
    </>
  );
}

/** The rotate handle, just outside a top corner, turned so its gap faces the corner. */
function RotateHandle({ boxes, hot, cam }: { boxes: Box[]; hot: boolean; cam: RefObject<CameraState> }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const scale = gizmoScale(cam.current);
    const { point, inward } = rotateHandlePlacement(boxes, scale);
    g.position.set(point.x, point.y, point.z);
    g.scale.setScalar(scale);
    // Turn the gap (at -45°) to face `inward`, counterclockwise seen from above.
    g.rotation.y = Math.atan2(-inward.z, inward.x) + Math.PI / 4;
  });

  const color = hot ? ROTATE_COLOR.hot : ROTATE_COLOR.base;
  return (
    <group ref={group}>
      <mesh geometry={ringGeometry} renderOrder={12}>
        <meshBasicMaterial color={color} depthTest={false} transparent />
      </mesh>
      <mesh geometry={ringTipGeometry} renderOrder={12}>
        <meshBasicMaterial color={color} depthTest={false} transparent />
      </mesh>
    </group>
  );
}

/** One scale handle, turned with the box so it reads as part of its top face, at a constant size on screen. */
function ScaleHandle({ box, part, hot, cam }: { box: Box; part: ScalePart; hot: boolean; cam: RefObject<CameraState> }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const p = scaleHandlePoint(box, part);
    g.position.set(p.x, p.y, p.z);
    g.scale.setScalar(gizmoScale(cam.current));
  });

  return (
    <group ref={group} rotation={[0, (box.rotation * Math.PI) / 180, 0]}>
      <mesh geometry={scaleRimGeometry} renderOrder={12}>
        <meshBasicMaterial color={SCALE_COLORS.rim} depthTest={false} transparent />
      </mesh>
      <mesh geometry={scaleGeometry} renderOrder={13}>
        <meshBasicMaterial color={hot ? SCALE_COLORS.hot : SCALE_COLORS.fill} depthTest={false} transparent />
      </mesh>
    </group>
  );
}

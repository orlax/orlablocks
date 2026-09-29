import { useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Frame } from "../shared/geometry";
import { isClosed, isFootprinted, isTilted } from "../shared/geometry";
import type { Shape } from "../shared/scene.types";
import type { CameraState, Vec3 } from "./camera";
import {
  ARROW,
  gizmoScale,
  HEIGHT_HANDLE,
  heightHandlePoint,
  isProfilePart,
  isScalePart,
  PROFILE_HANDLE,
  profileKnobPoint,
  rotateHandlePlacement,
  ROTATE_RADIUS,
  SCALE_HANDLE,
  scaleHandlePoint,
  TILT_RADIUS,
  tiltRing,
  UNIFORM_HANDLE,
  uniformHandlePoint,
  type GizmoPart,
  type ProfilePart,
  type ScalePart,
  type TiltPart,
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

// The tilt rings: full circles around the shape's center, in the colors of the axis they turn around (pitch: its
// own x, red; roll: its own z, blue). The torus lies in its x/y plane, square to its +z.
const tiltGeometry = new THREE.TorusGeometry(TILT_RADIUS, 0.035, 8, 64);
const TILT_COLORS: Record<TiltPart, { base: string; hot: string }> = { pitch: COLORS.x, roll: COLORS.z };

// The profile knobs: small spheres, one color each (wall: brick, taper: teal, bevel: pink), with a dark rim.
const knobGeometry = new THREE.SphereGeometry(PROFILE_HANDLE, 16, 12);
const knobRimGeometry = new THREE.SphereGeometry(PROFILE_HANDLE + 0.04, 16, 12);
const KNOB_COLORS: Record<ProfilePart, { base: string; hot: string }> = {
  wall: { base: "#c8744a", hot: "#eea27c" },
  taper: { base: "#2fb3a3", hot: "#6fe0d2" },
  bevel: { base: "#d0609a", hot: "#f09ac4" },
};

/** A shape's full turn (rotation, then its tilt inside it), as in ShapeMesh: what a tilted shape's handles turn by. */
function shapeEuler(shape: Shape): THREE.Euler {
  const deg = Math.PI / 180;
  const tilt = isFootprinted(shape) ? [shape.pitch ?? 0, shape.roll ?? 0] : [0, 0];
  const rotation = isFootprinted(shape) ? shape.rotation : 0;
  return new THREE.Euler(tilt[0] * deg, rotation * deg, tilt[1] * deg, "YXZ");
}

/** Turns the +y arrow to point along each axis. */
const ARROW_ROTATION: Record<"x" | "y" | "z", [number, number, number]> = {
  x: [0, 0, -Math.PI / 2],
  y: [0, 0, 0],
  z: [Math.PI / 2, 0, 0],
};

/**
 * The transform gizmo on the selection: world-axis move arrows (x red, y green, z blue) from the top center and,
 * for a single shape, the height handle there and the 8 scale handles on the top face's corners and edges (on a
 * tilted shape's own tilted top), the profile knobs (a room's wall, a volume's taper and bevel), and for a single box
 * or cylinder volume the two tilt rings (pitch red, roll blue) around its center. A constant size on screen and drawn
 * over everything (no depth test). The dragging itself is handled by the Viewport.
 */
export function TransformGizmo({
  anchor,
  parts,
  boxes,
  frame,
  hot,
  cam,
}: {
  anchor: Vec3;
  parts: GizmoPart[];
  /** The selected boxes: scale handles need a single one, the rotate handle any. */
  boxes: Shape[];
  /** Their selection frame, which the scale and rotate handles sit on. */
  frame: Frame;
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
      {parts.includes("rotate") && <RotateHandle boxes={boxes} frame={frame} hot={hot === "rotate"} cam={cam} />}
      {parts.includes("uniform") && <UniformHandle boxes={boxes} frame={frame} hot={hot === "uniform"} cam={cam} />}
      {box &&
        (["pitch", "roll"] as const)
          .filter((part) => parts.includes(part))
          .map((part) => <TiltRing key={part} shape={box} part={part} hot={hot === part} cam={cam} />)}
      {box &&
        parts
          .filter(isScalePart)
          .map((part) => <ScaleHandle key={part} box={box} frame={frame} part={part} hot={hot === part} cam={cam} />)}
      {box &&
        isClosed(box) &&
        parts.filter(isProfilePart).map((part) => <ProfileKnob key={part} shape={box} part={part} hot={hot === part} cam={cam} />)}
      {box && parts.includes("height") && isTilted(box) && <TiltedHeightHandle box={box} anchor={anchor} hot={hot === "height"} cam={cam} />}
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
        {parts.includes("height") && !(box && isTilted(box)) && (
          <mesh geometry={cubeGeometry} renderOrder={11}>
            <meshBasicMaterial color={color("height")} depthTest={false} transparent />
          </mesh>
        )}
      </group>
    </>
  );
}

// The uniform scale handle (14.3): a gold cube with a dark rim, standing on its corner so it reads as "scale all".
const uniformGeometry = new THREE.BoxGeometry(UNIFORM_HANDLE, UNIFORM_HANDLE, UNIFORM_HANDLE);
const uniformRimGeometry = new THREE.BoxGeometry(UNIFORM_HANDLE + 2 * RIM, UNIFORM_HANDLE + 2 * RIM, UNIFORM_HANDLE + 2 * RIM);
const UNIFORM_COLOR = { base: "#e8b923", hot: "#f7d768" };

/** The uniform scale handle, just outside the top corner opposite the rotate handle. */
function UniformHandle({ boxes, frame, hot, cam }: { boxes: Shape[]; frame: Frame; hot: boolean; cam: RefObject<CameraState> }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const scale = gizmoScale(cam.current);
    const p = uniformHandlePoint(boxes, scale, frame);
    g.position.set(p.x, p.y, p.z);
    g.scale.setScalar(scale);
  });
  return (
    <group ref={group} rotation={[Math.PI / 4, (frame.rotation * Math.PI) / 180 + Math.PI / 4, 0]}>
      <mesh geometry={uniformRimGeometry} renderOrder={12}>
        <meshBasicMaterial color={SCALE_COLORS.rim} depthTest={false} transparent />
      </mesh>
      <mesh geometry={uniformGeometry} renderOrder={13}>
        <meshBasicMaterial color={hot ? UNIFORM_COLOR.hot : UNIFORM_COLOR.base} depthTest={false} transparent />
      </mesh>
    </group>
  );
}

/** The rotate handle, just outside a top corner, turned so its gap faces the corner. */
function RotateHandle({ boxes, frame, hot, cam }: { boxes: Shape[]; frame: Frame; hot: boolean; cam: RefObject<CameraState> }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const scale = gizmoScale(cam.current);
    const { point, inward } = rotateHandlePlacement(boxes, scale, frame);
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

/** A tilt ring around the shape's center, square to the axis it turns the shape around, at a constant size on screen. */
function TiltRing({ shape, part, hot, cam }: { shape: Shape; part: TiltPart; hot: boolean; cam: RefObject<CameraState> }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const { center, axis, u, v } = tiltRing(shape, part);
    g.position.set(center.x, center.y, center.z);
    // The torus's x, y and z go to the ring's u, v and axis.
    g.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(new THREE.Vector3(u.x, u.y, u.z), new THREE.Vector3(v.x, v.y, v.z), new THREE.Vector3(axis.x, axis.y, axis.z)),
    );
    g.scale.setScalar(gizmoScale(cam.current));
  });

  return (
    <group ref={group}>
      <mesh geometry={tiltGeometry} renderOrder={12}>
        <meshBasicMaterial color={hot ? TILT_COLORS[part].hot : TILT_COLORS[part].base} depthTest={false} transparent opacity={0.9} />
      </mesh>
    </group>
  );
}

/** One scale handle, turned with the selection frame so it reads as part of the top face, at a constant size on screen. */
function ScaleHandle({
  box,
  frame,
  part,
  hot,
  cam,
}: {
  box: Shape;
  frame: Frame;
  part: ScalePart;
  hot: boolean;
  cam: RefObject<CameraState>;
}) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const p = scaleHandlePoint(box, part, frame);
    g.position.set(p.x, p.y, p.z);
    g.scale.setScalar(gizmoScale(cam.current));
  });

  return (
    <group ref={group} rotation={isTilted(box) ? shapeEuler(box) : [0, (frame.rotation * Math.PI) / 180, 0]}>
      <mesh geometry={scaleRimGeometry} renderOrder={12}>
        <meshBasicMaterial color={SCALE_COLORS.rim} depthTest={false} transparent />
      </mesh>
      <mesh geometry={scaleGeometry} renderOrder={13}>
        <meshBasicMaterial color={hot ? SCALE_COLORS.hot : SCALE_COLORS.fill} depthTest={false} transparent />
      </mesh>
    </group>
  );
}

/** A profile knob (wall, taper or bevel) where it sits on the shape, at a constant size on screen. */
function ProfileKnob({ shape, part, hot, cam }: { shape: Shape; part: ProfilePart; hot: boolean; cam: RefObject<CameraState> }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g || !isClosed(shape)) return;
    const p = profileKnobPoint(shape, part);
    g.position.set(p.x, p.y, p.z);
    g.scale.setScalar(gizmoScale(cam.current));
  });

  return (
    <group ref={group}>
      <mesh geometry={knobRimGeometry} renderOrder={12}>
        <meshBasicMaterial color={SCALE_COLORS.rim} depthTest={false} transparent />
      </mesh>
      <mesh geometry={knobGeometry} renderOrder={13}>
        <meshBasicMaterial color={hot ? KNOB_COLORS[part].hot : KNOB_COLORS[part].base} depthTest={false} transparent />
      </mesh>
    </group>
  );
}

/** A tilted shape's height handle, on its own top face's center and tilted with it. */
function TiltedHeightHandle({ box, anchor, hot, cam }: { box: Shape; anchor: Vec3; hot: boolean; cam: RefObject<CameraState> }) {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const p = heightHandlePoint(box, anchor);
    g.position.set(p.x, p.y, p.z);
    g.scale.setScalar(gizmoScale(cam.current));
  });

  return (
    <group ref={group} rotation={shapeEuler(box)}>
      <mesh geometry={cubeGeometry} renderOrder={11}>
        <meshBasicMaterial color={hot ? COLORS.height.hot : COLORS.height.base} depthTest={false} transparent />
      </mesh>
    </group>
  );
}


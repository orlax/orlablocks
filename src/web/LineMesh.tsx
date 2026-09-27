import { useEffect, useMemo, useRef } from "react";
import { invalidate, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { polyline, type Point3 } from "../shared/geometry";
import { PALETTE, type Line } from "../shared/scene.types";
import { HOVER_COLOR, SELECT_COLOR } from "./ShapeMesh";

/** Just above what it's drawn on, so a line on the ground or a platform's top isn't hidden in it. */
const LIFT = 0.02;
/** Behind a shape, a line still shows, this faint. */
const BEHIND_OPACITY = 0.3;
/** An arrowhead's size on screen, from the line's thickness (px). */
const arrowLength = (thickness: number) => 10 + 3 * thickness;
const arrowWidth = (thickness: number) => 7 + 2 * thickness;

/** The selection or hover halo: this many px wider than the line, and this opaque. */
const HALO_EXTRA_PX = 6;
const HALO_OPACITY = 0.45;
/** A selected line's points: rings this big on screen (px). */
const RING_PX = 13;

/** A ring (white, to tint), for the selected line's points. Made on first use. */
let ringTexture: THREE.Texture | null = null;
function getRingTexture() {
  if (ringTexture) return ringTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, 2 * Math.PI);
  ctx.stroke();
  ringTexture = new THREE.CanvasTexture(canvas);
  return ringTexture;
}

// A cone along +y with its tip at the origin, so it can sit on a line's end point.
const coneGeometry = new THREE.ConeGeometry(0.5, 1, 16).translate(0, -0.5, 0);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A line: a fat polyline of constant width on screen (three's Line2), solid or dashed (dashes in world units,
 * scaled with the thickness), with cone arrowheads at its ends that also keep their size on screen. It's drawn
 * twice: normally, and fainter over everything, so a line behind a wall stays visible. No shadows.
 * It always keeps its own color: selected, it gets a blue halo and blue rings on its points; hovered, a yellow halo.
 */
export function LineMesh({ line, highlight }: { line: Line; highlight?: "hover" | "selected" }) {
  const size = useThree((s) => s.size);
  const color = PALETTE[line.color];
  const haloColor = highlight === "selected" ? SELECT_COLOR : HOVER_COLOR;
  const key = JSON.stringify(line.points);
  const path = useMemo(() => polyline(line).map((p) => ({ ...p, y: p.y + LIFT })), [key]);

  const geometry = useMemo(() => new LineGeometry().setPositions(path.flatMap((p) => [p.x, p.y, p.z])), [path]);
  // Dashing is a shader define, so a change of `dashed` needs new materials.
  const materials = useMemo(() => {
    const make = (behind: boolean) =>
      new LineMaterial({
        linewidth: line.thickness,
        dashed: line.dashed,
        dashSize: 0.3 + 0.1 * line.thickness,
        gapSize: 0.2 + 0.07 * line.thickness,
        transparent: behind,
        opacity: behind ? BEHIND_OPACITY : 1,
        depthTest: !behind,
        depthWrite: false,
      });
    return { front: make(false), behind: make(true) };
  }, [line.dashed]);
  const halo = useMemo(
    () => new LineMaterial({ linewidth: line.thickness + HALO_EXTRA_PX, transparent: true, opacity: HALO_OPACITY, depthTest: false, depthWrite: false }),
    [],
  );
  const objects = useMemo(() => {
    const front = new Line2(geometry, materials.front);
    const behind = new Line2(geometry, materials.behind);
    const glow = new Line2(geometry, halo);
    front.computeLineDistances();
    behind.computeLineDistances();
    front.renderOrder = 16;
    behind.renderOrder = 15;
    glow.renderOrder = 14;
    return { front, behind, glow };
  }, [geometry, materials, halo]);
  halo.color.set(haloColor);
  halo.linewidth = line.thickness + HALO_EXTRA_PX;
  halo.resolution.set(size.width, size.height);
  // The selected line's points (not the curve's samples), lifted like the line.
  const rings = useMemo(
    () => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(line.points.flatMap((p) => [p.x, p.y + LIFT, p.z]), 3)),
    [key],
  );
  useEffect(() => () => rings.dispose(), [rings]);
  useEffect(() => () => halo.dispose(), [halo]);

  // Color, width, dash length and the screen size change in place.
  for (const m of [materials.front, materials.behind]) {
    m.color.set(color);
    m.linewidth = line.thickness;
    m.dashSize = 0.3 + 0.1 * line.thickness;
    m.gapSize = 0.2 + 0.07 * line.thickness;
    m.resolution.set(size.width, size.height);
  }
  useEffect(() => invalidate(), [color, highlight, line.thickness, size.width, size.height]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(
    () => () => {
      materials.front.dispose();
      materials.behind.dispose();
    },
    [materials],
  );

  // The arrowheads: at the end, and at the start too for "both", each pointing out along its last segment.
  const ends = useMemo(() => {
    const at = (tip: Point3, from: Point3) => ({ tip, dir: new THREE.Vector3(tip.x - from.x, tip.y - from.y, tip.z - from.z).normalize() });
    if (line.arrow === "none" || path.length < 2) return [];
    const end = at(path.at(-1)!, path.at(-2)!);
    return line.arrow === "both" ? [end, at(path[0], path[1])] : [end];
  }, [path, line.arrow]);

  return (
    <>
      {highlight && <primitive object={objects.glow} />}
      {highlight === "selected" && (
        <points geometry={rings} renderOrder={17}>
          <pointsMaterial
            color={SELECT_COLOR}
            map={getRingTexture()}
            size={RING_PX}
            sizeAttenuation={false}
            transparent
            alphaTest={0.3}
            depthTest={false}
            depthWrite={false}
          />
        </points>
      )}
      <primitive object={objects.behind} />
      <primitive object={objects.front} />
      {ends.map((e, i) => (
        <Arrowhead key={i} tip={e.tip} dir={e.dir} color={color} thickness={line.thickness} />
      ))}
    </>
  );
}

/** One arrowhead: a cone with its tip on the line's end, sized in screen pixels (so readable at any zoom). */
function Arrowhead({ tip, dir, color, thickness }: { tip: Point3; dir: THREE.Vector3; color: string; thickness: number }) {
  const group = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, dir), [dir]);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    // Meters per pixel at the tip's distance from the camera.
    const d = camera.position.distanceTo(g.position);
    const perPx = (2 * d * Math.tan(((camera.fov / 2) * Math.PI) / 180)) / size.height;
    g.scale.set(arrowWidth(thickness) * perPx, arrowLength(thickness) * perPx, arrowWidth(thickness) * perPx);
  });

  return (
    <group ref={group} position={[tip.x, tip.y, tip.z]} quaternion={quaternion}>
      <mesh geometry={coneGeometry} renderOrder={16}>
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh geometry={coneGeometry} renderOrder={15}>
        <meshBasicMaterial color={color} transparent opacity={BEHIND_OPACITY} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  );
}

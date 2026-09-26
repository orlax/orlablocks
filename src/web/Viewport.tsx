import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Actor, Rect, View } from "../shared/scene.types";
import {
  cameraPosition,
  DEFAULT_CAMERA,
  FOV_DEG,
  MAX_DISTANCE,
  panTo,
  rotateBy,
  screenToGround,
  viewOf,
  YAW_SPEED_DEG,
  zoomBy,
  type CameraState,
  type GroundPoint,
} from "./camera";
import { Grid } from "./Grid";

/** Same colors as `--human` / `--agent` in styles.css. */
const ACTOR_COLOR: Record<Actor, string> = { human: "#3d7be0", agent: "#e0763d" };
const BACKGROUND = "#f7f6f2";
const VIEW_REPORT_MS = 100;

type YawKey = "left" | "right";
const YAW_KEYS: Record<string, YawKey> = { a: "left", arrowleft: "left", d: "right", arrowright: "right" };

type Props = {
  rects: Rect[];
  onCursor: (point: GroundPoint | null) => void;
  onViewChange: (view: View) => void;
};

/**
 * The 3D view. The camera state lives in a ref, not React state: it changes every frame while panning or
 * rotating, and the three.js side reads it in `useFrame`. Only the reported `view` goes back to React, throttled.
 */
export function Viewport({ rects, onCursor, onViewChange }: Props) {
  const cam = useRef<CameraState>({ ...DEFAULT_CAMERA });
  const wrap = useRef<HTMLDivElement>(null);
  const yawKeys = useRef(new Set<YawKey>());
  const drag = useRef<{ pointerId: number; grabbed: GroundPoint } | null>(null);
  const [panning, setPanning] = useState(false);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top, size: { width: r.width, height: r.height } };
  };

  // Hand tool: drag anywhere to pan. The grabbed ground point stays under the cursor.
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { sx, sy, size } = local(e);
    drag.current = { pointerId: e.pointerId, grabbed: screenToGround(cam.current, size, sx, sy) };
    setPanning(true);
  };

  const onPointerMove = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    if (drag.current?.pointerId === e.pointerId) {
      cam.current = panTo(cam.current, size, drag.current.grabbed, sx, sy);
      invalidate();
    }
    onCursor(screenToGround(cam.current, size, sx, sy));
  };

  const onPointerUp = (e: PointerEvent) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setPanning(false);
  };

  // Wheel zoom around the focus point. A native listener, because React's wheel listener is passive
  // and can't stop the browser from zooming the page on a trackpad pinch.
  useEffect(() => {
    const el = wrap.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const deltaY = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      cam.current = zoomBy(cam.current, deltaY, e.ctrlKey);
      invalidate();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Yaw while A/D or ←/→ is held. The rig integrates it per frame.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = YAW_KEYS[e.key.toLowerCase()];
      if (!key || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      yawKeys.current.add(key);
      invalidate();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = YAW_KEYS[e.key.toLowerCase()];
      if (key) yawKeys.current.delete(key);
    };
    const onBlur = () => yawKeys.current.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const start = cameraPosition(cam.current);

  return (
    <div
      ref={wrap}
      className={panning ? "viewport panning" : "viewport"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => onCursor(null)}
    >
      <Canvas
        flat
        frameloop="demand"
        camera={{ position: [start.x, start.y, start.z], fov: FOV_DEG, near: 0.5, far: MAX_DISTANCE * 4 }}
      >
        <color attach="background" args={[BACKGROUND]} />
        <CameraRig cam={cam} yawKeys={yawKeys} onViewChange={onViewChange} />
        <Grid cam={cam} />
        <OriginAxes />
        {rects.map((r) => (
          <RectTile key={r.id} rect={r} />
        ))}
      </Canvas>
    </div>
  );
}

/** Applies the camera state to the three.js camera every frame, integrates yaw and reports the view. */
function CameraRig({
  cam,
  yawKeys,
  onViewChange,
}: {
  cam: RefObject<CameraState>;
  yawKeys: RefObject<Set<YawKey>>;
  onViewChange: (view: View) => void;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const lastReport = useRef({ key: "", at: 0 });

  useFrame((_, delta) => {
    const keys = yawKeys.current;
    const dir = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
    if (dir !== 0) {
      // Clamp: the first frame after an idle period (frameloop="demand") reports a huge delta.
      cam.current = rotateBy(cam.current, dir * YAW_SPEED_DEG * Math.min(delta, 0.05));
      invalidate();
    }

    const c = cam.current;
    const p = cameraPosition(c);
    camera.position.set(p.x, p.y, p.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(c.focus.x, 0, c.focus.z);

    // Report the view at most every VIEW_REPORT_MS. A final change still goes out on a later frame.
    const view = viewOf(c, size);
    const key = JSON.stringify(view);
    const now = performance.now();
    if (key !== lastReport.current.key) {
      if (now - lastReport.current.at >= VIEW_REPORT_MS) {
        lastReport.current = { key, at: now };
        onViewChange(view);
      } else {
        invalidate();
      }
    }
  });

  return null;
}

/** A marker at the world origin: +x in red, +z in blue, so you can tell which way you're facing. */
function OriginAxes() {
  const LENGTH = 2;
  const THICK = 0.15;
  return (
    <group renderOrder={2}>
      <mesh position={[LENGTH / 2, THICK / 2, 0]}>
        <boxGeometry args={[LENGTH, THICK, THICK]} />
        <meshBasicMaterial color="#d0473d" />
      </mesh>
      <mesh position={[0, THICK / 2, LENGTH / 2]}>
        <boxGeometry args={[THICK, THICK, LENGTH]} />
        <meshBasicMaterial color="#3d6fd0" />
      </mesh>
    </group>
  );
}

/** Transitional (02.1): a rect lies flat on the ground, with rect x → ground x and rect y → ground z. */
function RectTile({ rect }: { rect: Rect }) {
  const { x, y: z, width, height: depth } = rect;
  const color = ACTOR_COLOR[rect.createdBy];
  const outline = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, 0.01, z),
        new THREE.Vector3(x + width, 0.01, z),
        new THREE.Vector3(x + width, 0.01, z + depth),
        new THREE.Vector3(x, 0.01, z + depth),
      ]),
    [x, z, width, depth],
  );
  useEffect(() => () => outline.dispose(), [outline]);

  return (
    <group>
      <mesh position={[x + width / 2, 0.005, z + depth / 2]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[width, depth]} />
        <meshBasicMaterial color={color} transparent opacity={0.35} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <lineLoop geometry={outline} renderOrder={1}>
        <lineBasicMaterial color={color} />
      </lineLoop>
    </group>
  );
}

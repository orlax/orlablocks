import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  DEFAULT_HEIGHT,
  HEIGHT_SNAP,
  MIN_HEIGHT,
  SNAP,
  DEFAULT_COLOR,
  type Box,
  type BoxInput,
  type BoxKind,
  type View,
} from "../shared/scene.types";
import { BoxMesh } from "./BoxMesh";
import {
  cameraPosition,
  DEFAULT_CAMERA,
  FOV_DEG,
  heightOnVertical,
  MAX_DISTANCE,
  panTo,
  rotateBy,
  screenRay,
  screenToGround,
  viewOf,
  worldToScreen,
  YAW_SPEED_DEG,
  zoomBy,
  type CameraState,
  type GroundPoint,
  type Size,
} from "./camera";
import { Grid } from "./Grid";
import { HANDLE_HIT_PX, handlePoint, HeightGizmo } from "./HeightGizmo";
import { Lighting } from "./Lighting";
import { pickBox } from "./pick";

const BACKGROUND = "#f7f6f2";
const VIEW_REPORT_MS = 100;
/** A pointer-up within this many px of its pointer-down is a click, not a drag. */
const CLICK_PX = 4;

type YawKey = "left" | "right";
const YAW_KEYS: Record<string, YawKey> = { a: "left", arrowleft: "left", d: "right", arrowright: "right" };

export type Tool = "hand" | BoxKind;

/** A drawn footprint on the ground, by its center (like a box). */
type Footprint = { x: number; z: number; width: number; depth: number };
type HeightDrag = { pointerId: number; id: string; grabOffset: number; height: number; sx: number; sy: number };

const snap = (n: number) => Math.round(n / SNAP) * SNAP;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Footprint spanning `start` to `end` in any drag direction; `square` constrains it to the larger side. */
function footprintFrom(start: GroundPoint, end: GroundPoint, square: boolean): Footprint {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const side = Math.max(Math.abs(dx), Math.abs(dz));
  const width = square ? side : Math.abs(dx);
  const depth = square ? side : Math.abs(dz);
  return { x: start.x + (dx < 0 ? -width : width) / 2, z: start.z + (dz < 0 ? -depth : depth) / 2, width, depth };
}

type Props = {
  tool: Tool;
  boxes: Box[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDrawBox: (box: BoxInput) => void;
  onChangeHeight: (id: string, height: number) => void;
  onCursor: (point: GroundPoint | null) => void;
  onViewChange: (view: View) => void;
};

/**
 * The 3D view. The camera state lives in a ref, not React state: it changes every frame while panning or
 * rotating, and the three.js side reads it in `useFrame`. Only the reported `view` goes back to React, throttled.
 */
export function Viewport({ tool, boxes, selectedId, onSelect, onDrawBox, onChangeHeight, onCursor, onViewChange }: Props) {
  const cam = useRef<CameraState>({ ...DEFAULT_CAMERA });
  const wrap = useRef<HTMLDivElement>(null);
  const yawKeys = useRef(new Set<YawKey>());
  const pan = useRef<{ pointerId: number; grabbed: GroundPoint; clickable: boolean; sx: number; sy: number } | null>(null);
  const drawing = useRef<{ pointerId: number; kind: BoxKind; start: GroundPoint } | null>(null);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<(Footprint & { kind: BoxKind; sx: number; sy: number }) | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [handleHot, setHandleHot] = useState(false);
  const [heightDrag, setHeightDrag] = useState<HeightDrag | null>(null);
  // After releasing the gizmo, keep showing the new height until the server's scene arrives (no flicker back).
  const [pendingHeight, setPendingHeight] = useState<{ id: string; height: number } | null>(null);

  // What's on screen: the server's boxes, with the height being dragged (or just released) applied locally.
  const override = heightDrag ?? pendingHeight;
  const shown = override ? boxes.map((b) => (b.id === override.id ? { ...b, height: override.height } : b)) : boxes;
  const selected = shown.find((b) => b.id === selectedId) ?? null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top, size: { width: r.width, height: r.height } };
  };

  /** Ground point under the pointer, snapped to 0.5 m unless Alt is held. */
  const groundAt = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    const g = screenToGround(cam.current, size, sx, sy);
    return { sx, sy, point: e.altKey ? g : { x: snap(g.x), z: snap(g.z) } };
  };

  const pickAt = (sx: number, sy: number, size: Size) => pickBox(screenRay(cam.current, size, sx, sy), shown);

  const onHandle = (sx: number, sy: number, size: Size) => {
    if (!selected) return false;
    const p = worldToScreen(cam.current, size, handlePoint(selected, cam.current));
    return !!p && Math.hypot(p.sx - sx, p.sy - sy) <= HANDLE_HIT_PX;
  };

  const cancelDrawing = () => {
    drawing.current = null;
    setDraft(null);
  };

  // Switching tools mid-drag drops the unfinished footprint.
  useEffect(cancelDrawing, [tool]);

  // A new scene from the server: the released height is now real, and a box that vanished (undo, Clear,
  // another tab) can't be dragged anymore.
  useEffect(() => {
    setPendingHeight(null);
    setHeightDrag((d) => (d && boxes.some((b) => b.id === d.id) ? d : null));
  }, [boxes]);

  // Gizmo (any tool, left button): drag the selected box's height.
  // Hand tool (or middle button in any tool): drag to pan, the grabbed ground point stays under the cursor;
  // a click without a drag selects the box under the cursor.
  // Room / volume tool: drag a footprint on the ground.
  const onPointerDown = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    if (e.button === 0 && selected && onHandle(sx, sy, size)) {
      e.currentTarget.setPointerCapture(e.pointerId);
      const top = selected.y + selected.height;
      const grabOffset = heightOnVertical(cam.current, size, sx, sy, selected.x, selected.z) - top;
      setHeightDrag({ pointerId: e.pointerId, id: selected.id, grabOffset, height: selected.height, sx, sy });
      return;
    }
    const panButton = e.button === 1 || (e.button === 0 && tool === "hand");
    const drawButton = e.button === 0 && tool !== "hand";
    if (!panButton && !drawButton) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (panButton) {
      const grabbed = screenToGround(cam.current, size, sx, sy);
      pan.current = { pointerId: e.pointerId, grabbed, clickable: e.button === 0, sx, sy };
      setPanning(true);
    } else if (tool !== "hand") {
      const { point } = groundAt(e);
      drawing.current = { pointerId: e.pointerId, kind: tool, start: point };
      setDraft({ kind: tool, ...point, width: 0, depth: 0, sx, sy });
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    onCursor(screenToGround(cam.current, size, sx, sy));

    if (heightDrag?.pointerId === e.pointerId) {
      const box = boxes.find((b) => b.id === heightDrag.id)!;
      const raw = heightOnVertical(cam.current, size, sx, sy, box.x, box.z) - heightDrag.grabOffset - box.y;
      const snapped = e.altKey ? raw : Math.round(raw / HEIGHT_SNAP) * HEIGHT_SNAP;
      setHeightDrag({ ...heightDrag, height: round2(Math.max(MIN_HEIGHT, snapped)), sx, sy });
      return;
    }
    if (pan.current?.pointerId === e.pointerId) {
      cam.current = panTo(cam.current, size, pan.current.grabbed, sx, sy);
      invalidate();
      return;
    }
    const d = drawing.current;
    if (d?.pointerId === e.pointerId) {
      const { point } = groundAt(e);
      setDraft({ kind: d.kind, ...footprintFrom(d.start, point, e.shiftKey), sx, sy });
      return;
    }
    // Just hovering: highlight the gizmo, or in the hand tool the box that a click would select.
    const hot = onHandle(sx, sy, size);
    setHandleHot(hot);
    setHoveredId(tool === "hand" && !hot ? pickAt(sx, sy, size) : null);
  };

  const onPointerUp = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    if (heightDrag?.pointerId === e.pointerId) {
      const box = boxes.find((b) => b.id === heightDrag.id);
      if (box && box.height !== heightDrag.height) {
        onChangeHeight(box.id, heightDrag.height);
        setPendingHeight({ id: box.id, height: heightDrag.height });
      }
      setHeightDrag(null);
      return;
    }
    const p = pan.current;
    if (p?.pointerId === e.pointerId) {
      pan.current = null;
      setPanning(false);
      if (p.clickable && Math.hypot(sx - p.sx, sy - p.sy) < CLICK_PX) onSelect(pickAt(sx, sy, size));
    }
    const d = drawing.current;
    if (d?.pointerId === e.pointerId) {
      const f = footprintFrom(d.start, groundAt(e).point, e.shiftKey);
      if (round2(f.width) > 0 && round2(f.depth) > 0) {
        onDrawBox({ kind: d.kind, x: round2(f.x), z: round2(f.z), width: round2(f.width), depth: round2(f.depth) });
      }
      cancelDrawing();
    }
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

  // Yaw while A/D or ←/→ is held. The rig integrates it per frame. Esc drops an unfinished draw or height drag.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelDrawing();
        setHeightDrag(null);
      }
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
  const cursorClass = heightDrag || handleHot ? "resizing" : panning ? "panning" : tool === "hand" ? "" : "drawing";

  return (
    <div
      ref={wrap}
      className={`viewport ${cursorClass}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        onCursor(null);
        setHoveredId(null);
        setHandleHot(false);
      }}
    >
      <Canvas
        shadows="percentage"
        // Neutral tone mapping lets sunlit near-white surfaces roll off instead of clipping. The background
        // and the grid shader aren't tone mapped, so they keep their exact colors.
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.NeutralToneMapping;
        }}
        frameloop="demand"
        camera={{ position: [start.x, start.y, start.z], fov: FOV_DEG, near: 0.5, far: MAX_DISTANCE * 4 }}
      >
        <color attach="background" args={[BACKGROUND]} />
        <CameraRig cam={cam} yawKeys={yawKeys} onViewChange={onViewChange} />
        <Lighting cam={cam} />
        <Grid cam={cam} />
        <OriginAxes />
        <Boxes boxes={shown} draft={draft} selectedId={selectedId} hoveredId={hoveredId} />
        {selected && <HeightGizmo box={selected} cam={cam} hot={handleHot || !!heightDrag} />}
      </Canvas>
      {draft && (draft.width > 0 || draft.depth > 0) && (
        <div className="draft-label" style={{ left: draft.sx + 14, top: draft.sy + 14 }}>
          {round2(draft.width)} × {round2(draft.depth)} m
        </div>
      )}
      {heightDrag && (
        <div className="draft-label" style={{ left: heightDrag.sx + 14, top: heightDrag.sy + 14 }}>
          h {heightDrag.height.toFixed(2)} m
        </div>
      )}
    </div>
  );
}

/**
 * The scene's boxes plus the draft. With frameloop="demand", r3f redraws when objects are added or changed
 * but not when they're removed (Clear, a cancelled draft), so request a frame after every change.
 */
function Boxes({
  boxes,
  draft,
  selectedId,
  hoveredId,
}: {
  boxes: Box[];
  draft: (Footprint & { kind: BoxKind }) | null;
  selectedId: string | null;
  hoveredId: string | null;
}) {
  useEffect(() => invalidate(), [boxes, draft, selectedId, hoveredId]);
  return (
    <>
      {boxes.map((b) => (
        <BoxMesh
          key={b.id}
          {...b}
          highlight={b.id === selectedId ? "selected" : b.id === hoveredId ? "hover" : undefined}
        />
      ))}
      {draft && draft.width > 0 && draft.depth > 0 && (
        <BoxMesh {...draft} y={0} rotation={0} color={DEFAULT_COLOR} height={DEFAULT_HEIGHT[draft.kind]} draft />
      )}
    </>
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

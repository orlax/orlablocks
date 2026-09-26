import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  SNAP,
  type Box,
  type BoxInput,
  type BoxKind,
  type BoxPatch,
  type NodeUpdate,
  type View,
} from "../shared/scene.types";
import { BoxMesh } from "./BoxMesh";
import {
  cameraPosition,
  DEFAULT_CAMERA,
  FOV_DEG,
  MAX_DISTANCE,
  panTo,
  rotateBy,
  screenRay,
  screenToGround,
  viewOf,
  YAW_SPEED_DEG,
  zoomBy,
  type CameraState,
  type GroundPoint,
  type Size,
} from "./camera";
import {
  dragUpdate,
  effectiveChanges,
  gizmoAnchor,
  hitGizmo,
  isScalePart,
  SCALE_PARTS,
  scaleCursor,
  selectionBounds,
  startBodyDrag,
  startHandleDrag,
  type GizmoDrag,
  type GizmoPart,
} from "./gizmo";
import { Grid } from "./Grid";
import { Lighting } from "./Lighting";
import { pickBox, pickHit } from "./pick";
import { TransformGizmo } from "./TransformGizmo";

const BACKGROUND = "#f7f6f2";
const VIEW_REPORT_MS = 100;
/** A pointer-up within this many px of its pointer-down is a click, not a drag. */
const CLICK_PX = 4;

type YawKey = "left" | "right";
const YAW_KEYS: Record<string, YawKey> = { a: "left", arrowleft: "left", d: "right", arrowright: "right" };

export type Tool = "select" | "hand" | "box";

/** A drawn footprint on the ground, by its center (like a box). */
type Footprint = { x: number; z: number; width: number; depth: number };

/**
 * A gizmo drag in progress. A body drag only becomes `active` once the pointer moves past CLICK_PX: until then
 * it's a click, which selects `clickId` alone. Handle drags are active right away.
 */
type Drag = GizmoDrag & {
  pointerId: number;
  ids: string[];
  clickId?: string;
  sx0: number;
  sy0: number;
  active: boolean;
  patches: Record<string, BoxPatch>;
  label: string;
  sx: number;
  sy: number;
};

const snap = (n: number) => Math.round(n / SNAP) * SNAP;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Footprint spanning `start` to `end` in any drag direction. `square` constrains it to the larger side, and
 * `fromCenter` makes `start` the center instead of a corner.
 */
function footprintFrom(start: GroundPoint, end: GroundPoint, square: boolean, fromCenter: boolean): Footprint {
  const scale = fromCenter ? 2 : 1;
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const side = Math.max(Math.abs(dx), Math.abs(dz)) * scale;
  const width = square ? side : Math.abs(dx) * scale;
  const depth = square ? side : Math.abs(dz) * scale;
  if (fromCenter) return { x: start.x, z: start.z, width, depth };
  return { x: start.x + (dx < 0 ? -width : width) / 2, z: start.z + (dz < 0 ? -depth : depth) / 2, width, depth };
}

/** Cmd on a Mac, Ctrl elsewhere (either is accepted): turns snapping off. */
const noSnap = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

type Props = {
  tool: Tool;
  boxes: Box[];
  selection: string[];
  /** The kind the Box tool draws (its draft is previewed at that kind's default height). */
  nextKind: BoxKind;
  onSelect: (ids: string[]) => void;
  onDrawBox: (box: BoxInput) => void;
  /** One gizmo drag: one `update_nodes`, so one undo step. */
  onUpdate: (changes: NodeUpdate[]) => void;
  onCursor: (point: GroundPoint | null) => void;
  onViewChange: (view: View) => void;
};

/**
 * The 3D view. The camera state lives in a ref, not React state: it changes every frame while panning or
 * rotating, and the three.js side reads it in `useFrame`. Only the reported `view` goes back to React, throttled.
 */
export function Viewport({ tool, boxes, selection, nextKind, onSelect, onDrawBox, onUpdate, onCursor, onViewChange }: Props) {
  const cam = useRef<CameraState>({ ...DEFAULT_CAMERA });
  const wrap = useRef<HTMLDivElement>(null);
  const yawKeys = useRef(new Set<YawKey>());
  const pan = useRef<{ pointerId: number; grabbed: GroundPoint; clickable: boolean; sx: number; sy: number } | null>(null);
  const drawing = useRef<{ pointerId: number; kind: BoxKind; start: GroundPoint } | null>(null);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<(Footprint & { kind: BoxKind; sx: number; sy: number }) | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hotPart, setHotPart] = useState<GizmoPart | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // After releasing a drag, keep showing its result until the server's scene arrives (no flicker back).
  const [pending, setPending] = useState<Record<string, BoxPatch> | null>(null);
  // The Esc listener is installed once; it reads the current drag from here.
  const dragRef = useRef(drag);
  dragRef.current = drag;

  // What's on screen: the server's boxes, with the drag in progress (or just released) applied locally.
  const override = drag?.active ? drag.patches : pending;
  const shown = override ? boxes.map((b) => (override[b.id] ? { ...b, ...override[b.id] } : b)) : boxes;

  // The transform gizmo: on the selection, in the Select tool only. Height and scale are for a single box.
  const selectedBoxes = tool === "select" ? shown.filter((b) => selection.includes(b.id)) : [];
  const single = selectedBoxes.length === 1 ? selectedBoxes[0] : undefined;
  const gizmo =
    selectedBoxes.length > 0
      ? {
          anchor: gizmoAnchor(selectionBounds(selectedBoxes)),
          parts: (single ? ["x", "y", "z", "height", ...SCALE_PARTS] : ["x", "y", "z"]) as GizmoPart[],
          box: single,
        }
      : null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top, size: { width: r.width, height: r.height } };
  };

  /** Ground point under the pointer, snapped to 0.5 m unless Cmd/Ctrl is held. */
  const groundAt = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    const g = screenToGround(cam.current, size, sx, sy);
    return { sx, sy, point: noSnap(e) ? g : { x: snap(g.x), z: snap(g.z) } };
  };

  const pickAt = (sx: number, sy: number, size: Size) => pickBox(screenRay(cam.current, size, sx, sy), shown);
  const gizmoAt = (sx: number, sy: number, size: Size) =>
    gizmo ? hitGizmo(cam.current, size, sx, sy, gizmo.anchor, gizmo.parts, gizmo.box) : null;

  const cancelDrawing = () => {
    drawing.current = null;
    setDraft(null);
  };

  // Switching tools (or holding Space) mid-drag drops the unfinished footprint or gizmo drag.
  useEffect(() => {
    cancelDrawing();
    setDrag(null);
  }, [tool]);

  // A new scene from the server: the released drag is now real, and a drag whose boxes vanished (undo, Clear,
  // another tab) is cancelled.
  useEffect(() => {
    setPending(null);
    setDrag((d) => (d && d.ids.every((id) => boxes.some((b) => b.id === id)) ? d : null));
  }, [boxes]);

  const startDrag = (e: PointerEvent, gizmoDrag: GizmoDrag, extra: { active: boolean; clickId?: string }) => {
    const { sx, sy } = local(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const ids = gizmoDrag.origin.map((b) => b.id);
    setDrag({ ...gizmoDrag, ...extra, pointerId: e.pointerId, ids, sx0: sx, sy0: sy, patches: {}, label: "", sx, sy });
  };

  // Select tool: a gizmo handle drags it; pressing a box selects it (unless it's already selected) and dragging
  // moves the selection; a click on empty ground deselects, and dragging there pans (until 03.6's marquee).
  // Hand tool (or middle button in any tool): drag to pan, the grabbed ground point stays under the cursor.
  // Box tool: drag a footprint on the ground.
  const onPointerDown = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    if (e.button === 0 && tool === "select") {
      const part = gizmoAt(sx, sy, size);
      if (part) {
        startDrag(e, startHandleDrag(cam.current, size, sx, sy, part, selectedBoxes), { active: true });
        return;
      }
      const hit = pickHit(screenRay(cam.current, size, sx, sy), shown);
      if (hit) {
        const ids = selection.includes(hit.id) ? selection : [hit.id];
        if (!selection.includes(hit.id)) onSelect(ids);
        const origin = shown.filter((b) => ids.includes(b.id));
        startDrag(e, startBodyDrag(origin, hit.point), { active: false, clickId: hit.id });
        return;
      }
    }
    const panButton = e.button === 1 || (e.button === 0 && tool !== "box");
    const drawButton = e.button === 0 && tool === "box";
    if (!panButton && !drawButton) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (panButton) {
      const grabbed = screenToGround(cam.current, size, sx, sy);
      pan.current = { pointerId: e.pointerId, grabbed, clickable: e.button === 0 && tool === "select", sx, sy };
      setPanning(true);
    } else {
      const { point } = groundAt(e);
      drawing.current = { pointerId: e.pointerId, kind: nextKind, start: point };
      setDraft({ kind: nextKind, ...point, width: 0, depth: 0, sx, sy });
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    onCursor(screenToGround(cam.current, size, sx, sy));

    if (drag?.pointerId === e.pointerId) {
      if (!drag.active && Math.hypot(sx - drag.sx0, sy - drag.sy0) < CLICK_PX) return;
      const others = boxes.filter((b) => !drag.ids.includes(b.id));
      const { patches, label } = dragUpdate(drag, cam.current, size, sx, sy, { shift: e.shiftKey, alt: e.altKey, snap: !noSnap(e) }, others);
      setDrag({ ...drag, active: true, patches, label, sx, sy });
      setHoveredId(null);
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
      setDraft({ kind: d.kind, ...footprintFrom(d.start, point, e.shiftKey, e.altKey), sx, sy });
      return;
    }
    // Just hovering: highlight the gizmo handle, or in the Select tool the box that a press would grab.
    const hot = gizmoAt(sx, sy, size);
    setHotPart(hot);
    setHoveredId(tool === "select" && !hot ? pickAt(sx, sy, size) : null);
  };

  const onPointerUp = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    if (drag?.pointerId === e.pointerId) {
      if (drag.active) {
        const changes = effectiveChanges(drag.origin, drag.patches);
        if (changes.length > 0) {
          onUpdate(changes);
          setPending(drag.patches);
        }
      } else if (drag.clickId) {
        // A click on a box (no drag) selects just that box.
        onSelect([drag.clickId]);
      }
      setDrag(null);
      return;
    }
    const p = pan.current;
    if (p?.pointerId === e.pointerId) {
      pan.current = null;
      setPanning(false);
      if (p.clickable && Math.hypot(sx - p.sx, sy - p.sy) < CLICK_PX) {
        const id = pickAt(sx, sy, size);
        onSelect(id ? [id] : []);
      }
    }
    const d = drawing.current;
    if (d?.pointerId === e.pointerId) {
      const f = footprintFrom(d.start, groundAt(e).point, e.shiftKey, e.altKey);
      if (round2(f.width) > 0 && round2(f.depth) > 0) {
        onDrawBox({ kind: d.kind, x: round2(f.x), z: round2(f.z), width: round2(f.width), depth: round2(f.depth) });
      }
      cancelDrawing();
    }
  };

  // Esc mid-drag cancels the drag or the draft and nothing else: this runs in the capture phase, before the
  // app's Esc (deselect), and stops it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (!dragRef.current?.active && !drawing.current)) return;
      e.stopImmediatePropagation();
      cancelDrawing();
      setDrag(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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
  const activePart = drag?.active ? drag.part : hotPart;
  // A scale handle's cursor follows its direction on screen; the box is the one being dragged, else the selected one.
  const scaleBox = drag?.active ? drag.origin[0] : gizmo?.box;
  const size = wrap.current ? { width: wrap.current.clientWidth, height: wrap.current.clientHeight } : null;
  const cursorClass =
    activePart && isScalePart(activePart) && scaleBox && size
      ? `resize-${scaleCursor(cam.current, size, scaleBox, activePart)}`
      : activePart === "y" || activePart === "height"
        ? "resizing"
        : activePart
        ? "moving"
        : panning
          ? "panning"
          : tool === "box"
            ? "drawing"
            : tool === "select"
              ? "selecting"
              : "";

  return (
    <div
      ref={wrap}
      className={`viewport ${cursorClass}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Ctrl+click on a Mac opens the context menu; Ctrl is the no-snap modifier here.
      onContextMenu={(e) => e.preventDefault()}
      onPointerLeave={() => {
        onCursor(null);
        setHoveredId(null);
        setHotPart(null);
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
        <Boxes boxes={shown} draft={draft} selection={selection} hoveredId={hoveredId} />
        {gizmo && (
          <TransformGizmo
            anchor={gizmo.anchor}
            parts={gizmo.parts}
            box={gizmo.box}
            hot={activePart === "body" ? null : activePart}
            cam={cam}
          />
        )}
      </Canvas>
      {draft && (draft.width > 0 || draft.depth > 0) && (
        <div className="draft-label" style={{ left: draft.sx + 14, top: draft.sy + 14 }}>
          {round2(draft.width)} × {round2(draft.depth)} m
        </div>
      )}
      {drag?.active && (
        <div className="draft-label" style={{ left: drag.sx + 14, top: drag.sy + 14 }}>
          {drag.label}
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
  selection,
  hoveredId,
}: {
  boxes: Box[];
  draft: (Footprint & { kind: BoxKind }) | null;
  selection: string[];
  hoveredId: string | null;
}) {
  useEffect(() => invalidate(), [boxes, draft, selection, hoveredId]);
  return (
    <>
      {boxes.map((b) => (
        <BoxMesh
          key={b.id}
          {...b}
          highlight={selection.includes(b.id) ? "selected" : b.id === hoveredId ? "hover" : undefined}
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

/** A marker at the world origin: +x in red, +y in green, +z in blue (the gizmo's colors), for orientation. */
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
      <mesh position={[0, LENGTH / 2, 0]}>
        <boxGeometry args={[THICK, LENGTH, THICK]} />
        <meshBasicMaterial color="#3f9e4d" />
      </mesh>
    </group>
  );
}

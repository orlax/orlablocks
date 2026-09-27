import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  SNAP,
  type Box,
  type BoxKind,
  type BoxPatch,
  type NodeUpdate,
  type SceneNode,
  type ShapeInput,
  type View,
} from "../shared/scene.types";
import { boundsOf } from "../shared/geometry";
import { boxesUnder, isBox, selectableAt } from "../shared/tree";
import { ShapeMesh } from "./ShapeMesh";
import {
  cameraPosition,
  DEFAULT_CAMERA,
  restoredCamera,
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
  canCopy,
  dragOffset,
  dragUpdate,
  effectiveChanges,
  gizmoAnchor,
  hitGizmo,
  isScalePart,
  SCALE_PARTS,
  scaleCursor,
  startBodyDrag,
  startHandleDrag,
  type GizmoDrag,
  type GizmoPart,
} from "./gizmo";
import { Grid } from "./Grid";
import { typingInField } from "./keys";
import { Lighting } from "./Lighting";
import { marqueeHits, rectFrom, type ScreenPoint } from "./marquee";
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
 * it's a click, which sets the selection to `clickSelection` on release. Handle drags are active right away.
 * `ids` are the dragged boxes, `nodeIds` the selected nodes they came from (what a copy copies). `copy`: `Alt` is
 * held on a move drag, so the originals stay and copies follow the cursor.
 */
type Drag = GizmoDrag & {
  pointerId: number;
  ids: string[];
  nodeIds: string[];
  copy: boolean;
  clickSelection?: string[];
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
  nodes: SceneNode[];
  /** Node IDs (boxes and groups). A group stands for every box in it. */
  selection: string[];
  /** The group the user has entered with a double-click (null = the top level): clicks select its children. */
  context: string | null;
  onContext: (id: string | null) => void;
  /** A node hovered outside the view (an outliner row): its boxes get the hover highlight too. */
  outsideHover: string | null;
  /** The kind the Box tool draws (its draft is previewed at that kind's default height). */
  nextKind: BoxKind;
  onSelect: (ids: string[]) => void;
  onDrawShape: (shape: ShapeInput) => void;
  /** One gizmo drag: one `update_nodes`, so one undo step. */
  onUpdate: (changes: NodeUpdate[]) => void;
  /** One Alt-drag: copies the nodes by the drag's offset, one undo step. */
  onDuplicate: (copy: { ids: string[]; dx: number; dy: number; dz: number }) => void;
  onCursor: (point: GroundPoint | null) => void;
  /** Reports the view (for the agent) and the camera (saved for the scene), throttled. */
  onViewChange: (view: View, camera: CameraState) => void;
  /** A saved camera to jump to. A new object each time a scene opens; null keeps the current camera. */
  cameraRestore: { camera: CameraState | null } | null;
};

/**
 * The 3D view. The camera state lives in a ref, not React state: it changes every frame while panning or
 * rotating, and the three.js side reads it in `useFrame`. Only the reported `view` goes back to React, throttled.
 */
export function Viewport({
  tool,
  nodes,
  selection,
  context,
  onContext,
  outsideHover,
  nextKind,
  onSelect,
  onDrawShape,
  onUpdate,
  onDuplicate,
  onCursor,
  onViewChange,
  cameraRestore,
}: Props) {
  const cam = useRef<CameraState>({ ...DEFAULT_CAMERA });

  // A scene opened with a saved camera: jump to it. The rig renders it and reports the new view.
  useEffect(() => {
    if (!cameraRestore?.camera) return;
    cam.current = restoredCamera(cameraRestore.camera);
    invalidate();
  }, [cameraRestore]);
  const wrap = useRef<HTMLDivElement>(null);
  const yawKeys = useRef(new Set<YawKey>());
  const pan = useRef<{ pointerId: number; grabbed: GroundPoint; sx: number; sy: number } | null>(null);
  const drawing = useRef<{ pointerId: number; kind: BoxKind; start: GroundPoint } | null>(null);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<(Footprint & { kind: BoxKind; sx: number; sy: number }) | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hotPart, setHotPart] = useState<GizmoPart | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // After releasing a drag, keep showing its result until the server's scene arrives (no flicker back).
  const [pending, setPending] = useState<{ origin: Box[]; patches: Record<string, BoxPatch>; copy: boolean } | null>(null);
  // The marquee: dragging empty ground in the Select tool. It becomes `active` past CLICK_PX (before that it's a
  // click, which deselects). `base` is the selection it started from, restored by Esc and added to with Shift.
  const [marquee, setMarquee] = useState<{
    pointerId: number;
    start: ScreenPoint;
    end: ScreenPoint;
    additive: boolean;
    base: string[];
    active: boolean;
  } | null>(null);
  // The Esc listener is installed once; it reads the current drag and marquee from here.
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const marqueeRef = useRef(marquee);
  marqueeRef.current = marquee;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const boxes = nodes.filter(isBox);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  // What's on screen: the server's boxes, with the drag in progress (or just released) applied locally. A copy
  // leaves the originals where they are and shows the copies (`ghosts`) where the drag puts them.
  const override = drag?.active ? drag : pending;
  const moved = (b: Box) => (override?.patches[b.id] ? { ...b, ...override.patches[b.id] } : b);
  const shown = override && !override.copy ? boxes.map(moved) : boxes;
  const ghosts = override?.copy ? override.origin.map((b) => ({ ...moved(b), id: `${b.id}:copy` })) : [];
  /** The boxes (as shown) in or under the given nodes. */
  const shownUnder = (ids: string[]) => {
    const under = new Set(boxesUnder(nodes, ids).map((b) => b.id));
    return shown.filter((b) => under.has(b.id));
  };

  // The transform gizmo: on the selection, in the Select tool only. Height and scale are for a single box (not a
  // group); move and rotate work on any selection.
  // While copying, the copies carry the selection (they become it on release).
  const selectedBoxes = tool !== "select" ? [] : ghosts.length > 0 ? ghosts : shownUnder(selection);
  const single =
    selection.length === 1 && selectedBoxes.length === 1 && selectedBoxes[0].id === selection[0] ? selectedBoxes[0] : undefined;
  const gizmo =
    selectedBoxes.length > 0
      ? {
          anchor: gizmoAnchor(boundsOf(selectedBoxes)),
          parts: (single ? ["x", "y", "z", "rotate", "height", ...SCALE_PARTS] : ["x", "y", "z", "rotate"]) as GizmoPart[],
          boxes: selectedBoxes,
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

  /**
   * What a click on box `id` selects: the node at the current level (the outermost group, or inside the entered
   * group its child). `leaves` says the box is outside the entered group, so the click leaves it.
   */
  const resolve = (id: string) => {
    const inside = context === null ? null : selectableAt(nodes, id, context);
    return inside !== null ? { id: inside, leaves: false } : { id: selectableAt(nodes, id, null) ?? id, leaves: context !== null };
  };
  const pickAt = (sx: number, sy: number, size: Size) => {
    const id = pickBox(screenRay(cam.current, size, sx, sy), shown);
    return id === null ? null : resolve(id).id;
  };
  const gizmoAt = (sx: number, sy: number, size: Size) =>
    gizmo ? hitGizmo(cam.current, size, sx, sy, gizmo.anchor, gizmo.parts, gizmo.boxes) : null;

  const cancelDrawing = () => {
    drawing.current = null;
    setDraft(null);
  };

  // Switching tools (or holding Space) mid-drag drops the unfinished footprint, gizmo drag or marquee (keeping
  // whatever the marquee has selected so far).
  useEffect(() => {
    cancelDrawing();
    setDrag(null);
    setMarquee(null);
  }, [tool]);

  // A new scene from the server: the released drag is now real, and a drag whose boxes vanished (undo, Clear,
  // another tab) is cancelled. Keyed on `nodes`, which only changes when a scene arrives.
  useEffect(() => {
    setPending(null);
    setDrag((d) => (d && d.ids.every((id) => boxesRef.current.some((b) => b.id === id)) ? d : null));
  }, [nodes]);

  const startDrag = (
    e: PointerEvent,
    gizmoDrag: GizmoDrag,
    extra: { active: boolean; nodeIds: string[]; clickSelection?: string[] },
  ) => {
    const { sx, sy } = local(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const ids = gizmoDrag.origin.map((b) => b.id);
    setDrag({ ...gizmoDrag, ...extra, pointerId: e.pointerId, ids, copy: false, sx0: sx, sy0: sy, patches: {}, label: "", sx, sy });
  };

  /**
   * The drag with the cursor at (sx, sy). `Alt` on a move drag makes it a copy, and a copy's bottom can snap onto
   * the originals' tops (copy a room upward for a second floor).
   */
  const dragTo = (d: Drag, sx: number, sy: number, keys: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): Drag => {
    const copy = keys.altKey && canCopy(d.part);
    const others = copy ? boxesRef.current : boxesRef.current.filter((b) => !d.ids.includes(b.id));
    const mods = { shift: keys.shiftKey, alt: keys.altKey, snap: !noSnap(keys) };
    const size = { width: wrap.current!.clientWidth, height: wrap.current!.clientHeight };
    const { patches, label } = dragUpdate(d, cam.current, size, sx, sy, mods, others);
    return { ...d, active: true, copy, patches, label, sx, sy };
  };

  // Select tool: a gizmo handle drags it. Pressing a box selects it (unless it's already selected) and dragging
  // moves the selection; a click selects just that box. With Shift, pressing an unselected box adds it (and a drag
  // moves them all), and clicking a selected one removes it. Empty ground: a drag draws a marquee, a click
  // deselects (Shift keeps the selection).
  // Hand tool (or middle button in any tool): drag to pan, the grabbed ground point stays under the cursor.
  // Box tool: drag a footprint on the ground.
  const onPointerDown = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    if (e.button === 0 && tool === "select") {
      const part = gizmoAt(sx, sy, size);
      if (part) {
        startDrag(e, startHandleDrag(cam.current, size, sx, sy, part, selectedBoxes), { active: true, nodeIds: selection });
        return;
      }
      const hit = pickHit(screenRay(cam.current, size, sx, sy), shown);
      if (hit) {
        const { id: target, leaves } = resolve(hit.id);
        if (leaves) onContext(null);
        const current = leaves ? [] : selection;
        const wasSelected = current.includes(target);
        let ids: string[];
        let clickSelection: string[];
        if (e.shiftKey) {
          ids = wasSelected ? current : [...current, target];
          clickSelection = wasSelected ? current.filter((id) => id !== target) : ids;
        } else {
          ids = wasSelected ? current : [target];
          clickSelection = [target];
        }
        if (!wasSelected) onSelect(ids);
        startDrag(e, startBodyDrag(shownUnder(ids), hit.point), { active: false, nodeIds: ids, clickSelection });
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      const start = { sx, sy };
      setMarquee({ pointerId: e.pointerId, start, end: start, additive: e.shiftKey, base: selection, active: false });
      return;
    }
    const panButton = e.button === 1 || (e.button === 0 && tool !== "box");
    const drawButton = e.button === 0 && tool === "box";
    if (!panButton && !drawButton) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (panButton) {
      const grabbed = screenToGround(cam.current, size, sx, sy);
      pan.current = { pointerId: e.pointerId, grabbed, sx, sy };
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
      setDrag(dragTo(drag, sx, sy, e));
      setHoveredId(null);
      return;
    }
    if (marquee?.pointerId === e.pointerId) {
      const end = { sx, sy };
      const active = marquee.active || Math.hypot(sx - marquee.start.sx, sy - marquee.start.sy) >= CLICK_PX;
      if (active) {
        // The selection follows the marquee live.
        // Boxes resolve to the nodes at the current level; inside a group, boxes outside it don't count.
        const hits: string[] = [];
        for (const id of marqueeHits(cam.current, size, shown, rectFrom(marquee.start, end))) {
          const r = resolve(id);
          if (!r.leaves && !hits.includes(r.id)) hits.push(r.id);
        }
        onSelect(marquee.additive ? [...marquee.base, ...hits.filter((id) => !marquee.base.includes(id))] : hits);
      }
      setMarquee({ ...marquee, end, active });
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
    if (drag?.pointerId === e.pointerId) {
      // `Alt` counts at release: pressing or releasing it mid-drag switches between move and copy.
      if (drag.active && e.altKey && canCopy(drag.part)) {
        const offset = dragOffset(drag.origin, drag.patches);
        if (offset.dx !== 0 || offset.dy !== 0 || offset.dz !== 0) {
          onDuplicate({ ids: drag.nodeIds, ...offset });
          setPending({ origin: drag.origin, patches: drag.patches, copy: true });
        }
      } else if (drag.active) {
        const changes = effectiveChanges(drag.origin, drag.patches);
        if (changes.length > 0) {
          onUpdate(changes);
          setPending({ origin: drag.origin, patches: drag.patches, copy: false });
        }
      } else if (drag.clickSelection) {
        onSelect(drag.clickSelection);
      }
      setDrag(null);
      return;
    }
    if (marquee?.pointerId === e.pointerId) {
      // A click on empty ground deselects and leaves the entered group, unless Shift is held.
      if (!marquee.active && !marquee.additive) {
        onSelect([]);
        onContext(null);
      }
      setMarquee(null);
      return;
    }
    if (pan.current?.pointerId === e.pointerId) {
      pan.current = null;
      setPanning(false);
    }
    const d = drawing.current;
    if (d?.pointerId === e.pointerId) {
      const f = footprintFrom(d.start, groundAt(e).point, e.shiftKey, e.altKey);
      if (round2(f.width) > 0 && round2(f.depth) > 0) {
        onDrawShape({ type: "box", kind: d.kind, x: round2(f.x), z: round2(f.z), width: round2(f.width), depth: round2(f.depth) });
      }
      cancelDrawing();
    }
  };

  // Double-click in the Select tool enters the group under the cursor one level and selects its child there
  // (the box itself, or a subgroup).
  const onDoubleClick = (e: MouseEvent) => {
    if (tool !== "select") return;
    const { sx, sy, size } = local(e);
    const id = pickBox(screenRay(cam.current, size, sx, sy), shown);
    if (id === null) return;
    const target = resolve(id).id;
    if (target === id) return; // already the box itself
    onContext(target);
    onSelect([selectableAt(nodes, id, target) ?? id]);
  };

  // Esc mid-drag cancels the drag, the draft or the marquee (restoring the selection it started from) and nothing
  // else: this runs in the capture phase, before the app's Esc (deselect), and stops it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const m = marqueeRef.current;
      if (typingInField(e)) return;
      if (e.key !== "Escape" || (!dragRef.current?.active && !drawing.current && !m?.active)) return;
      e.stopImmediatePropagation();
      cancelDrawing();
      setDrag(null);
      if (m?.active) onSelectRef.current(m.base);
      setMarquee(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Pressing or releasing Alt mid-drag switches between move and copy right away, without waiting for the pointer
  // to move.
  useEffect(() => {
    const onAlt = (e: KeyboardEvent) => {
      const d = dragRef.current;
      if (e.key !== "Alt" || !d?.active || !canCopy(d.part)) return;
      e.preventDefault();
      setDrag(dragTo(d, d.sx, d.sy, e));
    };
    window.addEventListener("keydown", onAlt);
    window.addEventListener("keyup", onAlt);
    return () => {
      window.removeEventListener("keydown", onAlt);
      window.removeEventListener("keyup", onAlt);
    };
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

  // Yaw while A/D or ←/→ is held. The rig integrates it per frame. Key-up always counts, so a key released while
  // typing still stops the turn.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = YAW_KEYS[e.key.toLowerCase()];
      if (!key || e.metaKey || e.ctrlKey || e.altKey || typingInField(e)) return;
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
  const cursorClass = (() => {
    if (activePart && isScalePart(activePart)) {
      return scaleBox && size ? `resize-${scaleCursor(cam.current, size, scaleBox, activePart)}` : "moving";
    }
    if (drag?.active && drag.copy) return "copying";
    if (activePart === "rotate") return "rotating";
    if (activePart === "y" || activePart === "height") return "resizing";
    if (activePart) return "moving";
    if (panning) return "panning";
    return tool === "box" ? "drawing" : tool === "select" ? "selecting" : "";
  })();

  return (
    <div
      ref={wrap}
      className={`viewport ${cursorClass}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
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
        <Boxes
          boxes={[...shown, ...ghosts]}
          draft={draft}
          selected={new Set(ghosts.length > 0 ? ghosts.map((b) => b.id) : boxesUnder(nodes, selection).map((b) => b.id))}
          hovered={new Set(boxesUnder(nodes, [hoveredId, outsideHover].filter((id) => id !== null)).map((b) => b.id))}
        />
        {gizmo && (
          <TransformGizmo
            anchor={gizmo.anchor}
            parts={gizmo.parts}
            boxes={gizmo.boxes}
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
      {marquee?.active && (
        <div
          className="marquee"
          style={{
            left: Math.min(marquee.start.sx, marquee.end.sx),
            top: Math.min(marquee.start.sy, marquee.end.sy),
            width: Math.abs(marquee.end.sx - marquee.start.sx),
            height: Math.abs(marquee.end.sy - marquee.start.sy),
          }}
        />
      )}
      {drag?.active && (
        <div className="draft-label" style={{ left: drag.sx + 14, top: drag.sy + 14 }}>
          {drag.copy ? `${drag.label} · copy` : drag.label}
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
  selected,
  hovered,
}: {
  boxes: Box[];
  draft: (Footprint & { kind: BoxKind }) | null;
  /** Box IDs to highlight: in the selection (or in a selected group), and under the cursor. */
  selected: Set<string>;
  hovered: Set<string>;
}) {
  const selectedKey = [...selected].join(",");
  const hoveredKey = [...hovered].join(",");
  useEffect(() => invalidate(), [boxes, draft, selectedKey, hoveredKey]);
  return (
    <>
      {boxes.map((b) => (
        <ShapeMesh key={b.id} shape={b} highlight={selected.has(b.id) ? "selected" : hovered.has(b.id) ? "hover" : undefined} />
      ))}
      {draft && draft.width > 0 && draft.depth > 0 && (
        <ShapeMesh
          shape={{
            id: "draft",
            type: "box",
            kind: draft.kind,
            x: draft.x,
            z: draft.z,
            width: draft.width,
            depth: draft.depth,
            y: 0,
            height: DEFAULT_HEIGHT[draft.kind],
            rotation: 0,
            color: DEFAULT_COLOR,
            createdBy: "human",
          }}
          draft
        />
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
  onViewChange: (view: View, camera: CameraState) => void;
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
    const key = JSON.stringify([view, c.distance]);
    const now = performance.now();
    if (key !== lastReport.current.key) {
      if (now - lastReport.current.at >= VIEW_REPORT_MS) {
        lastReport.current = { key, at: now };
        onViewChange(view, c);
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

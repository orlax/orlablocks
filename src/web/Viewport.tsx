import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  SNAP,
  type Shape,
  type ShapeKind,
  type ShapePatch,
  type NodeUpdate,
  type FootPoint,
  type SceneNode,
  type ShapeInput,
  type View,
} from "../shared/scene.types";
import {
  boundsOf,
  isFootprinted,
  outlineProblem,
  pathCrosses,
  roundPoints,
  sameValue,
  sampleEdge,
  selectionFrame,
  splitEdge,
  type Point,
} from "../shared/geometry";
import { shapesUnder, isShape, selectableAt } from "../shared/tree";
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
  screenToPlane,
  viewOf,
  worldToScreen,
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
import { ErrorBoundary } from "./ErrorPanel";
import { Grid } from "./Grid";
import { typingInField } from "./keys";
import { Lighting } from "./Lighting";
import { marqueeHits, rectFrom, type ScreenPoint } from "./marquee";
import { pickShape, pickHit } from "./pick";
import { handleEnd, hitPoints, movePoints, moveHandle, removePoints, togglePoint, type HandleSide, type PointPart } from "./points";
import { TransformGizmo } from "./TransformGizmo";

const BACKGROUND = "#f7f6f2";
const VIEW_REPORT_MS = 100;
/** A pointer-up within this many px of its pointer-down is a click, not a drag. */
const CLICK_PX = 4;
/** With the Pen, a click this close (px) to the first point closes the outline. */
const CLOSE_PX = 10;

/**
 * The Pen's outline in progress: the points placed so far (world x/z, unrounded), where the cursor is (the next
 * point, snapped like one), and the point whose handle a press-and-drag is pulling out.
 */
type Pen = { points: FootPoint[]; cursor: Point | null; closing: boolean; drag: { pointerId: number; index: number; sx: number; sy: number } | null };
const NO_PEN: Pen = { points: [], cursor: null, closing: false, drag: null };

type YawKey = "left" | "right";
const YAW_KEYS: Record<string, YawKey> = { a: "left", arrowleft: "left", d: "right", arrowright: "right" };

export type Tool = "select" | "hand" | "box" | "cylinder" | "pen";
/** The tools that drag a footprint on the ground, and the shape type each draws. */
const DRAWS: Partial<Record<Tool, "box" | "cylinder">> = { box: "box", cylinder: "cylinder" };

/** A drawn footprint on the ground, by its center (like a box). */
type Footprint = { x: number; z: number; width: number; depth: number };
/** What the draft being drawn is. */
type Draft = { type: "box" | "cylinder"; kind: ShapeKind; sides?: number };

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
  patches: Record<string, ShapePatch>;
  label: string;
  /** A rotate drag: the selection frame's angle now. */
  turn?: number;
  sx: number;
  sy: number;
};

/**
 * A drag in point editing, from a press on a point, a handle or an edge (which inserts a point there first). It
 * becomes `active` past CLICK_PX; until then it's a click, which sets the point selection to `clickSelection`.
 * `start` is the outline when it started (with the inserted point), `grab` the point under the cursor then, on the
 * top face's plane, and `points` the outline now. `problem`: why that outline can't be kept (it crosses itself).
 */
type PointDrag = {
  pointerId: number;
  mode: "points" | "handle";
  index: number;
  side?: HandleSide;
  indices: number[];
  start: FootPoint[];
  grab: Point;
  sx0: number;
  sy0: number;
  sx: number;
  sy: number;
  active: boolean;
  inserted: boolean;
  points: FootPoint[];
  problem: string | null;
  clickSelection?: number[];
};

/**
 * How far the editor has turned a selection (Figma-style: its frame turns with it while it stays selected), for
 * `key` (the selection). `expect` is the selected shapes as that turn left them: if they change any other way
 * (undo, the agent, another tab), the turn is forgotten and the frame is axis-aligned again.
 */
type Turn = { key: string; angle: number; expect: string };
/** The selected shapes' footprints, for telling whether something other than our own drags changed them. */
const footprintKey = (shapes: Shape[]) =>
  JSON.stringify(shapes.map((s) => (isFootprinted(s) ? [s.x, s.z, s.width, s.depth, s.rotation, s.type === "cylinder" ? s.sides : 0] : s.points)));

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
  /** The free-form in point editing (entered by double-clicking it), or null. */
  editing: string | null;
  onEditing: (id: string | null) => void;
  /** A node hovered outside the view (an outliner row): its boxes get the hover highlight too. */
  outsideHover: string | null;
  /** The kind the Box and Cylinder tools draw (the draft is previewed at that kind's default height). */
  nextKind: ShapeKind;
  /** The sides the Cylinder tool draws (undefined = smooth). */
  nextSides: number | undefined;
  onSelect: (ids: string[]) => void;
  onDrawShape: (shape: ShapeInput) => void;
  /** One gizmo drag: one `update_nodes`, so one undo step. */
  onUpdate: (changes: NodeUpdate[]) => void;
  /** A short message for the status bar (the Pen's "the outline crosses itself"). */
  onNotice: (message: string) => void;
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
  editing,
  onEditing,
  outsideHover,
  nextKind,
  nextSides,
  onSelect,
  onDrawShape,
  onUpdate,
  onDuplicate,
  onNotice,
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
  const drawing = useRef<{ pointerId: number; type: "box" | "cylinder"; kind: ShapeKind; sides?: number; start: GroundPoint } | null>(null);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<(Footprint & Draft & { sx: number; sy: number }) | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pen, setPen] = useState<Pen>(NO_PEN);
  // The key listener is installed once; it reads the Pen from here.
  const penRef = useRef(pen);
  penRef.current = pen;
  const [hotPart, setHotPart] = useState<GizmoPart | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // After releasing a drag, keep showing its result until the server's scene arrives (no flicker back).
  const [pending, setPending] = useState<{ origin: Shape[]; patches: Record<string, ShapePatch>; copy: boolean } | null>(null);
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
  const [turn, setTurn] = useState<Turn | null>(null);
  // Point editing: the selected points (indices into the edited free-form's outline), the drag in progress and
  // what's under the cursor.
  const [pointSel, setPointSel] = useState<number[]>([]);
  const [pointDrag, setPointDrag] = useState<PointDrag | null>(null);
  const [hotPoint, setHotPoint] = useState<PointPart | null>(null);

  const boxes = nodes.filter(isShape);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  // What's on screen: the server's boxes, with the drag in progress (or just released) applied locally. A copy
  // leaves the originals where they are and shows the copies (`ghosts`) where the drag puts them. A point edit in
  // progress shows too, while its outline is valid.
  const override = drag?.active ? drag : pending;
  const moved = (b: Shape) => (override?.patches[b.id] ? { ...b, ...override.patches[b.id] } : b);
  const pointPreview = pointDrag && (pointDrag.active || pointDrag.inserted) ? pointDrag : null;
  const shown = (override && !override.copy ? boxes.map(moved) : boxes).map((b) =>
    pointPreview && !pointPreview.problem && b.id === editing ? ({ ...b, points: roundPoints(pointPreview.points) } as Shape) : b,
  );
  const ghosts = override?.copy ? override.origin.map((b) => ({ ...moved(b), id: `${b.id}:copy` })) : [];
  // The free-form in point editing, as shown.
  const editShape = editing !== null ? shown.find((b) => b.id === editing && b.type === "freeform") : undefined;
  const editPoints = editShape?.type === "freeform" ? (pointPreview?.points ?? editShape.points) : null;
  const editTop = editShape ? editShape.y + editShape.height : 0;
  /** The boxes (as shown) in or under the given nodes. */
  const shownUnder = (ids: string[]) => {
    const under = new Set(shapesUnder(nodes, ids).map((b) => b.id));
    return shown.filter((b) => under.has(b.id));
  };

  // The transform gizmo: on the selection, in the Select tool only (and not in point editing). Height and scale
  // are for a single box (not a group); move and rotate work on any selection.
  // While copying, the copies carry the selection (they become it on release).
  const selectedBoxes = tool !== "select" || editShape ? [] : ghosts.length > 0 ? ghosts : shownUnder(selection);
  const single =
    selection.length === 1 && selectedBoxes.length === 1 && selectedBoxes[0].id === selection[0] ? selectedBoxes[0] : undefined;
  // The selection frame turns with the selection: live while rotating, then as far as it was turned.
  const selectionKey = selection.join(",");
  const frameTurn = drag?.active && drag.turn !== undefined ? drag.turn : turn?.key === selectionKey ? turn.angle : 0;
  const frame = selectedBoxes.length > 0 ? selectionFrame(selectedBoxes, frameTurn) : null;
  const gizmo =
    frame && selectedBoxes.length > 0
      ? {
          anchor: gizmoAnchor(boundsOf(selectedBoxes), frame),
          parts: (single ? ["x", "y", "z", "rotate", "height", ...SCALE_PARTS] : ["x", "y", "z", "rotate"]) as GizmoPart[],
          boxes: selectedBoxes,
          box: single,
          frame,
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
    const id = pickShape(screenRay(cam.current, size, sx, sy), shown);
    return id === null ? null : resolve(id).id;
  };
  const gizmoAt = (sx: number, sy: number, size: Size) =>
    gizmo ? hitGizmo(cam.current, size, sx, sy, gizmo.anchor, gizmo.parts, gizmo.boxes, gizmo.frame) : null;
  /** The point, handle or edge of the edited free-form under the cursor. */
  const pointAt = (sx: number, sy: number, size: Size) =>
    editPoints ? hitPoints(cam.current, size, sx, sy, editPoints, editTop, pointSel) : null;

  const cancelDrawing = () => {
    drawing.current = null;
    setDraft(null);
  };

  // Switching tools (or holding Space) mid-drag drops the unfinished footprint, gizmo drag or marquee (keeping
  // whatever the marquee has selected so far). The Pen's outline takes many clicks, so it survives the hand (Space
  // to pan while drawing) and is dropped by any other tool.
  useEffect(() => {
    cancelDrawing();
    setDrag(null);
    setPointDrag(null);
    setMarquee(null);
    if (tool === "hand" || tool === "pen") setPen((p) => ({ ...p, cursor: null, closing: false, drag: null }));
    else setPen(NO_PEN);
  }, [tool]);

  // A new scene from the server: the released drag is now real, and a drag whose boxes vanished (undo, Clear,
  // another tab) is cancelled. Keyed on `nodes`, which only changes when a scene arrives.
  useEffect(() => {
    setPending(null);
    setDrag((d) => (d && d.ids.every((id) => boxesRef.current.some((b) => b.id === id)) ? d : null));
  }, [nodes]);

  // The turn lasts while the same selection stays selected and only our own drags change it.
  useEffect(() => {
    setTurn((t) => (t && t.key === selectionKey && t.expect === footprintKey(shapesUnder(nodes, selection)) ? t : null));
  }, [nodes, selectionKey]);

  // Entering or leaving point editing starts with no points selected.
  useEffect(() => {
    setPointSel([]);
    setPointDrag(null);
    setHotPoint(null);
  }, [editing]);

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
    const { patches, label, turn } = dragUpdate(d, cam.current, size, sx, sy, mods, others);
    return { ...d, active: true, copy, patches, label, turn, sx, sy };
  };

  /** A ground point's position on screen. */
  const onScreen = (p: Point) =>
    worldToScreen(cam.current, { width: wrap.current!.clientWidth, height: wrap.current!.clientHeight }, { x: p.x, y: 0, z: p.z });

  /**
   * Draws the Pen's outline as a free-form (rounded to 2 decimals), unless it isn't valid: then the status bar says
   * why and the outline stays, to fix with Backspace.
   */
  const finishPen = (points: FootPoint[]) => {
    const rounded = roundPoints(points);
    const problem = outlineProblem(rounded);
    if (problem) {
      onNotice(`Can't close: ${problem}`);
      return;
    }
    onDrawShape({ type: "freeform", kind: nextKind, points: rounded });
    setPen(NO_PEN);
  };
  const finishPenRef = useRef(finishPen);
  finishPenRef.current = finishPen;

  // Pen: a press adds a corner at the (snapped) ground point, and dragging before release pulls out its handles
  // (a smooth point). Pressing the first point (with 3 or more) closes the outline.
  const penDown = (e: PointerEvent) => {
    const { sx, sy } = local(e);
    const { points } = pen;
    const first = points[0] && onScreen(points[0]);
    if (points.length >= 3 && first && Math.hypot(first.sx - sx, first.sy - sy) <= CLOSE_PX) {
      finishPen(points);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const { point } = groundAt(e);
    const last = points.at(-1);
    // A second press in the same place (a double-click) adds nothing, but can still pull out the handles.
    const same = last && last.x === point.x && last.z === point.z;
    const next = same ? points : [...points, { x: point.x, z: point.z }];
    setPen({ ...pen, points: next, drag: { pointerId: e.pointerId, index: next.length - 1, sx, sy } });
  };

  /** The Pen as the cursor moves: pulling out the pressed point's handles, or showing where the next point goes. */
  const penMove = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    const d = pen.drag;
    if (d?.pointerId === e.pointerId) {
      if (Math.hypot(sx - d.sx, sy - d.sy) < CLICK_PX) return;
      // Handles aren't snapped: the out handle follows the cursor and the in handle mirrors it.
      const g = screenToGround(cam.current, size, sx, sy);
      const p = pen.points[d.index];
      const out = { x: g.x - p.x, z: g.z - p.z };
      const points = pen.points.map((q, i) => (i === d.index ? { x: q.x, z: q.z, in: { x: -out.x, z: -out.z }, out } : q));
      setPen({ ...pen, points, cursor: null });
      return;
    }
    const first = pen.points[0] && onScreen(pen.points[0]);
    const closing = pen.points.length >= 3 && !!first && Math.hypot(first.sx - sx, first.sy - sy) <= CLOSE_PX;
    setPen({ ...pen, cursor: closing ? { ...pen.points[0] } : groundAt(e).point, closing });
  };

  /**
   * Sends an edited outline (rounded) as one step, and shows it until the server's scene arrives. Refused, with
   * the reason in the status bar, if it isn't a valid outline. Returns whether it was kept.
   */
  const commitPoints = (points: FootPoint[], verb: string): boolean => {
    const original = boxesRef.current.find((b) => b.id === editing);
    if (original?.type !== "freeform") return false;
    const rounded = roundPoints(points);
    const problem = outlineProblem(rounded);
    if (problem) {
      onNotice(`Can't ${verb}: ${problem}`);
      return false;
    }
    if (sameValue(rounded, original.points)) return true;
    onUpdate([{ id: original.id, points: rounded }]);
    setPending({ origin: [original], patches: { [original.id]: { points: rounded } }, copy: false });
    return true;
  };

  // Point editing: a press on a handle (of a selected point) drags it; on a point selects it (Shift adds or, on
  // a click, removes) and drags the selected points; on an edge inserts a point there and drags it.
  const pointDown = (e: PointerEvent, part: PointPart, sx: number, sy: number, size: Size) => {
    if (!editPoints) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const grab = screenToPlane(cam.current, size, sx, sy, editTop);
    const base = { pointerId: e.pointerId, grab, sx0: sx, sy0: sy, sx, sy, active: false, problem: null };
    if (part.type === "handle") {
      const { index, side } = part;
      setPointDrag({ ...base, mode: "handle", index, side, indices: [], start: editPoints, points: editPoints, inserted: false });
      return;
    }
    if (part.type === "edge") {
      const start = splitEdge(editPoints, part.index, part.t);
      const index = part.index + 1;
      setPointSel([index]);
      setPointDrag({ ...base, mode: "points", index, indices: [index], start, points: start, inserted: true });
      return;
    }
    const { index } = part;
    const was = pointSel.includes(index);
    const indices = was ? pointSel : e.shiftKey ? [...pointSel, index] : [index];
    const clickSelection = e.shiftKey ? (was ? pointSel.filter((i) => i !== index) : indices) : [index];
    if (!was) setPointSel(indices);
    setPointDrag({ ...base, mode: "points", index, indices, start: editPoints, points: editPoints, inserted: false, clickSelection });
  };

  /**
   * A point drag as the cursor moves: the grabbed point follows it (snapped to 0.5 m unless Cmd/Ctrl) and the
   * other selected points move with it; a handle follows it freely, turning its opposite with it unless Alt.
   */
  const pointMove = (d: PointDrag, e: PointerEvent, sx: number, sy: number, size: Size) => {
    if (!d.active && Math.hypot(sx - d.sx0, sy - d.sy0) < CLICK_PX) return;
    const p = screenToPlane(cam.current, size, sx, sy, editTop);
    const q = d.start[d.index];
    let points: FootPoint[];
    if (d.mode === "handle" && d.side) {
      const h = q[d.side]!;
      points = moveHandle(d.start, d.index, d.side, { x: h.x + p.x - d.grab.x, z: h.z + p.z - d.grab.z }, e.altKey);
    } else {
      let x = q.x + p.x - d.grab.x;
      let z = q.z + p.z - d.grab.z;
      if (!noSnap(e)) [x, z] = [snap(x), snap(z)];
      points = movePoints(d.start, d.indices, x - q.x, z - q.z);
    }
    setPointDrag({ ...d, active: true, points, problem: outlineProblem(roundPoints(points)), sx, sy });
  };

  // Select tool: a gizmo handle drags it. Pressing a box selects it (unless it's already selected) and dragging
  // moves the selection; a click selects just that box. With Shift, pressing an unselected box adds it (and a drag
  // moves them all), and clicking a selected one removes it. Empty ground: a drag draws a marquee, a click
  // deselects (Shift keeps the selection).
  // Hand tool (or middle button in any tool): drag to pan, the grabbed ground point stays under the cursor.
  // Box and Cylinder tools: drag a footprint on the ground.
  const onPointerDown = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    if (e.button === 0 && tool === "select") {
      // In point editing, a press grabs a point, a handle or an edge. Pressing the free-form elsewhere deselects
      // the points; pressing anything else leaves point editing (empty ground does only that).
      if (editShape) {
        const part = pointAt(sx, sy, size);
        if (part) {
          pointDown(e, part, sx, sy, size);
          return;
        }
        const hit = pickHit(screenRay(cam.current, size, sx, sy), shown);
        if (hit?.id === editShape.id) {
          setPointSel([]);
          return;
        }
        onEditing(null);
        if (!hit) return;
      }
      const part = gizmoAt(sx, sy, size);
      if (part) {
        startDrag(e, startHandleDrag(cam.current, size, sx, sy, part, selectedBoxes, gizmo?.frame), { active: true, nodeIds: selection });
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
    if (e.button === 0 && tool === "pen") {
      penDown(e);
      return;
    }
    const draws = DRAWS[tool];
    const panButton = e.button === 1 || (e.button === 0 && !draws && tool !== "pen");
    const drawButton = e.button === 0 && !!draws;
    if (!panButton && !drawButton) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (panButton) {
      const grabbed = screenToGround(cam.current, size, sx, sy);
      pan.current = { pointerId: e.pointerId, grabbed, sx, sy };
      setPanning(true);
    } else {
      const { point } = groundAt(e);
      const shape: Draft = { type: draws!, kind: nextKind, ...(draws === "cylinder" && nextSides !== undefined ? { sides: nextSides } : {}) };
      drawing.current = { pointerId: e.pointerId, ...shape, start: point };
      setDraft({ ...shape, ...point, width: 0, depth: 0, sx, sy });
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
    if (pointDrag?.pointerId === e.pointerId) {
      pointMove(pointDrag, e, sx, sy, size);
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
    if (tool === "pen") {
      penMove(e);
      return;
    }
    const d = drawing.current;
    if (d?.pointerId === e.pointerId) {
      const { point } = groundAt(e);
      setDraft({ type: d.type, kind: d.kind, sides: d.sides, ...footprintFrom(d.start, point, e.shiftKey, e.altKey), sx, sy });
      return;
    }
    // Just hovering: in point editing, what a press would grab (for the cursor); otherwise highlight the gizmo
    // handle, or in the Select tool the box that a press would grab.
    if (editShape && tool === "select") {
      setHotPoint(pointAt(sx, sy, size));
      setHotPart(null);
      setHoveredId(null);
      return;
    }
    const hot = gizmoAt(sx, sy, size);
    setHotPart(hot);
    setHoveredId(tool === "select" && !hot ? pickAt(sx, sy, size) : null);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (pointDrag?.pointerId === e.pointerId) {
      const d = pointDrag;
      setPointDrag(null);
      if (d.active || d.inserted) {
        if (!commitPoints(d.points, d.active ? "reshape" : "add a point there") && d.inserted) setPointSel([]);
      } else if (d.clickSelection) setPointSel(d.clickSelection);
      return;
    }
    if (pen.drag?.pointerId === e.pointerId) {
      setPen({ ...pen, drag: null });
      return;
    }
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
          // The selection frame keeps its turn (or takes the new one) as long as this is what the server sends back.
          const expect = footprintKey(drag.origin.map((b) => ({ ...b, ...drag.patches[b.id] }) as Shape));
          const angle = drag.turn ?? (turn?.key === selectionKey ? turn.angle : 0);
          setTurn(angle !== 0 ? { key: selectionKey, angle, expect } : null);
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
        onDrawShape({
          type: d.type,
          ...(d.sides !== undefined ? { sides: d.sides } : {}),
          kind: d.kind,
          x: round2(f.x),
          z: round2(f.z),
          width: round2(f.width),
          depth: round2(f.depth),
        });
      }
      cancelDrawing();
    }
  };

  // Double-click in the Select tool enters the group under the cursor one level and selects its child there
  // (the box itself, or a subgroup). On a free-form that's selected at its own level, it enters point editing, and
  // there a double-click on a point switches it between corner and smooth.
  const onDoubleClick = (e: MouseEvent) => {
    if (tool !== "select") return;
    const { sx, sy, size } = local(e);
    if (editShape && editPoints) {
      const part = pointAt(sx, sy, size);
      if (part?.type !== "point") return;
      const smooth = !!(editPoints[part.index].in || editPoints[part.index].out);
      if (commitPoints(togglePoint(editPoints, part.index), smooth ? "make it a corner" : "make it smooth")) setPointSel([part.index]);
      return;
    }
    const id = pickShape(screenRay(cam.current, size, sx, sy), shown);
    if (id === null) return;
    const target = resolve(id).id;
    if (target === id) {
      // Already the shape itself.
      if (shown.find((b) => b.id === id)?.type === "freeform") {
        onSelect([id]);
        onEditing(id);
      }
      return;
    }
    onContext(target);
    onSelect([selectableAt(nodes, id, target) ?? id]);
  };

  // In point editing: Esc cancels a point drag, or else leaves point editing; Delete / Backspace removes the
  // selected points (never fewer than 3). Neither reaches the app, which would deselect or delete the free-form.
  const editKeys = useRef({ editing, pointSel, pointDrag, editPoints, commitPoints, onEditing, onNotice });
  editKeys.current = { editing, pointSel, pointDrag, editPoints, commitPoints, onEditing, onNotice };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const k = editKeys.current;
      if (typingInField(e) || k.editing === null) return;
      if (e.key !== "Escape" && e.key !== "Delete" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        if (k.pointDrag) setPointDrag(null);
        else k.onEditing(null);
        return;
      }
      if (k.pointSel.length === 0 || !k.editPoints || k.pointDrag) return;
      const left = removePoints(k.editPoints, k.pointSel);
      if (!left) {
        k.onNotice("A free-form needs at least 3 points");
        return;
      }
      if (k.commitPoints(left, k.pointSel.length === 1 ? "delete that point" : "delete those points")) setPointSel([]);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Esc mid-drag cancels the drag, the draft or the marquee (restoring the selection it started from) and nothing
  // else: this runs in the capture phase, before the app's Esc (deselect), and stops it.
  // With the Pen's outline under way, Enter closes it, Backspace (or Delete) removes the last point, and Esc drops
  // it; none of them reach the app (which would deselect or delete the selection).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { points } = penRef.current;
      if (typingInField(e) || points.length === 0) return;
      if (e.key !== "Enter" && e.key !== "Backspace" && e.key !== "Delete" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") setPen(NO_PEN);
      else if (e.key === "Enter") finishPenRef.current(points);
      else setPen({ ...penRef.current, points: points.slice(0, -1), drag: null });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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
    if (pointDrag?.active) return "moving";
    if (editShape && tool === "select" && hotPoint) return hotPoint.type === "edge" ? "adding" : "moving";
    if (activePart && isScalePart(activePart)) {
      return scaleBox && size ? `resize-${scaleCursor(cam.current, size, scaleBox, activePart, drag?.active ? drag.frame : gizmo?.frame)}` : "moving";
    }
    if (drag?.active && drag.copy) return "copying";
    if (activePart === "rotate") return "rotating";
    if (activePart === "y" || activePart === "height") return "resizing";
    if (activePart) return "moving";
    if (panning) return "panning";
    return DRAWS[tool] || tool === "pen" ? "drawing" : tool === "select" ? "selecting" : "";
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
      <ErrorBoundary scope="view">
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
          selected={new Set(ghosts.length > 0 ? ghosts.map((b) => b.id) : shapesUnder(nodes, selection).map((b) => b.id))}
          hovered={new Set(shapesUnder(nodes, [hoveredId, outsideHover].filter((id) => id !== null)).map((b) => b.id))}
        />
        {pen.points.length > 0 && <PenPreview pen={pen} kind={nextKind} />}
        {editPoints && <PointOverlay points={editPoints} y={editTop} selected={pointSel} bad={!!pointPreview?.problem} />}
        {gizmo && (
          <TransformGizmo
            anchor={gizmo.anchor}
            parts={gizmo.parts}
            boxes={gizmo.boxes}
            frame={gizmo.frame}
            hot={activePart === "body" ? null : activePart}
            cam={cam}
          />
        )}
      </Canvas>
      </ErrorBoundary>
      {draft && (draft.width > 0 || draft.depth > 0) && (
        <div className="draft-label" style={{ left: draft.sx + 14, top: draft.sy + 14 }}>
          {round2(draft.width)} × {round2(draft.depth)} m
        </div>
      )}
      {pen.points.length > 0 && pen.cursor && (
        <PenLabel pen={pen} at={onScreen(pen.cursor)} />
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
      {pointDrag?.active && (
        <div className={pointDrag.problem ? "draft-label bad" : "draft-label"} style={{ left: pointDrag.sx + 14, top: pointDrag.sy + 14 }}>
          {pointDrag.problem ??
            (pointDrag.mode === "points"
              ? `x ${round2(pointDrag.points[pointDrag.index].x).toFixed(2)} · z ${round2(pointDrag.points[pointDrag.index].z).toFixed(2)}`
              : pointDrag.side === "in"
                ? "in handle"
                : "out handle")}
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
  boxes: Shape[];
  draft: (Footprint & Draft) | null;
  /** Shape IDs to highlight: in the selection (or in a selected group), and under the cursor. */
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
            ...(draft.type === "cylinder" ? { type: "cylinder", sides: draft.sides } : { type: "box" }),
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

/** The Pen's outline in progress: blue, or red once it crosses itself. */
const PEN_COLOR = "#3d7be0";
const PEN_BAD_COLOR = "#d0473d";
/** Just above the ground, so the preview isn't hidden in it. */
const PEN_Y = 0.02;

/** The path the Pen would draw now: the placed points, then the cursor as the next one (unless it's closing). */
const penPath = (pen: Pen) => (pen.cursor && !pen.closing ? [...pen.points, pen.cursor] : pen.points);

/** Next to the cursor: how many points, and what Enter or a click on the first point does. */
function PenLabel({ pen, at }: { pen: Pen; at: { sx: number; sy: number } | null }) {
  if (!at) return null;
  const n = pen.points.length;
  const text = pen.closing ? "click to close" : n >= 3 ? `${n} points · Enter to close` : `${n} point${n === 1 ? "" : "s"}`;
  return (
    <div className="draft-label" style={{ left: at.sx + 14, top: at.sy + 14 }}>
      {text}
    </div>
  );
}

/**
 * The Pen's preview: the path's edges (curves sampled), each point as a square (the first one bigger once a click
 * there would close the outline), the handles of smooth points, and, once the outline could close without
 * crossing itself, a draft of the shape at its kind's default height.
 */
function PenPreview({ pen, kind }: { pen: Pen; kind: ShapeKind }) {
  const path = penPath(pen);
  const bad = pathCrosses(path, pen.closing);
  const key = JSON.stringify([path, pen.closing]);

  const { lines, dots, handleDots } = useMemo(() => {
    const segments: number[] = [];
    const add = (a: Point, b: Point) => segments.push(a.x, PEN_Y, a.z, b.x, PEN_Y, b.z);
    const edges = pen.closing ? path.length : path.length - 1;
    for (let i = 0; i < edges; i++) {
      const b = path[(i + 1) % path.length];
      const samples = [...sampleEdge(path[i], b), b];
      for (let k = 0; k + 1 < samples.length; k++) add(samples[k], samples[k + 1]);
    }
    const handleEnds: number[] = [];
    for (const p of pen.points) {
      for (const h of [p.in, p.out]) {
        if (!h) continue;
        add(p, { x: p.x + h.x, z: p.z + h.z });
        handleEnds.push(p.x + h.x, PEN_Y, p.z + h.z);
      }
    }
    const geometry = (values: number[]) => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    return {
      lines: geometry(segments),
      dots: geometry(pen.points.flatMap((p) => [p.x, PEN_Y, p.z])),
      handleDots: geometry(handleEnds),
    };
  }, [key]);
  useEffect(
    () => () => {
      lines.dispose();
      dots.dispose();
      handleDots.dispose();
      invalidate();
    },
    [lines, dots, handleDots],
  );

  const color = bad ? PEN_BAD_COLOR : PEN_COLOR;
  // Only a valid outline gets a draft (not while the cursor still sits on the point just placed, say).
  const closable = path.length >= 3 && outlineProblem(roundPoints(path)) === null;
  const first = pen.points[0];
  return (
    <>
      {closable && (
        <ShapeMesh
          shape={{
            id: "pen",
            type: "freeform",
            kind,
            y: 0,
            height: DEFAULT_HEIGHT[kind],
            color: DEFAULT_COLOR,
            points: roundPoints(path),
            createdBy: "human",
          }}
          draft
        />
      )}
      <lineSegments geometry={lines} renderOrder={20}>
        <lineBasicMaterial color={color} depthTest={false} transparent />
      </lineSegments>
      <points geometry={dots} renderOrder={21}>
        <pointsMaterial color={color} size={7} sizeAttenuation={false} depthTest={false} transparent />
      </points>
      <points geometry={handleDots} renderOrder={21}>
        <pointsMaterial color={color} size={5} sizeAttenuation={false} depthTest={false} transparent />
      </points>
      {pen.closing && first && (
        <points renderOrder={22}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[new Float32Array([first.x, PEN_Y, first.z]), 3]} />
          </bufferGeometry>
          <pointsMaterial color={color} size={12} sizeAttenuation={false} depthTest={false} transparent />
        </points>
      )}
    </>
  );
}

/** Point editing's overlay: blue, or red while the edit would cross itself. */
const POINT_COLOR = "#3d7be0";
const POINT_FILL = "#ffffff";

/**
 * Point editing's overlay on the free-form's top face (`y`): its outline, every point as a square (hollow, or
 * filled when selected), and each selected point's handles as dots on thin stems. Drawn over everything, at a
 * constant size on screen.
 */
function PointOverlay({ points, y, selected, bad }: { points: FootPoint[]; y: number; selected: number[]; bad: boolean }) {
  const key = JSON.stringify([points, y, selected]);
  const { lines, all, hollow, ends } = useMemo(() => {
    const segments: number[] = [];
    const add = (a: Point, b: Point) => segments.push(a.x, y, a.z, b.x, y, b.z);
    points.forEach((p, i) => {
      const next = points[(i + 1) % points.length];
      const samples = [...sampleEdge(p, next), next];
      for (let k = 0; k + 1 < samples.length; k++) add(samples[k], samples[k + 1]);
    });
    const handleEnds: number[] = [];
    for (const i of selected) {
      const p = points[i];
      if (!p) continue;
      for (const side of ["in", "out"] as const) {
        const end = handleEnd(p, side);
        if (!end) continue;
        add(p, end);
        handleEnds.push(end.x, y, end.z);
      }
    }
    const geometry = (values: number[]) => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    return {
      lines: geometry(segments),
      all: geometry(points.flatMap((p) => [p.x, y, p.z])),
      hollow: geometry(points.flatMap((p, i) => (selected.includes(i) ? [] : [p.x, y, p.z]))),
      ends: geometry(handleEnds),
    };
  }, [key]);
  useEffect(
    () => () => {
      [lines, all, hollow, ends].forEach((g) => g.dispose());
      invalidate();
    },
    [lines, all, hollow, ends],
  );
  useEffect(() => invalidate(), [key, bad]);

  const color = bad ? PEN_BAD_COLOR : POINT_COLOR;
  return (
    <>
      <lineSegments geometry={lines} renderOrder={20}>
        <lineBasicMaterial color={color} depthTest={false} transparent />
      </lineSegments>
      <points geometry={all} renderOrder={21}>
        <pointsMaterial color={color} size={9} sizeAttenuation={false} depthTest={false} transparent />
      </points>
      <points geometry={hollow} renderOrder={22}>
        <pointsMaterial color={POINT_FILL} size={5} sizeAttenuation={false} depthTest={false} transparent />
      </points>
      <points geometry={ends} renderOrder={23}>
        <pointsMaterial color={color} size={6} sizeAttenuation={false} depthTest={false} transparent />
      </points>
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

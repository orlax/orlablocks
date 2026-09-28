import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  DEFAULT_COLOR,
  DEFAULT_HEIGHT,
  KIND_FIELDS,
  MIN_LINE_POINTS,
  MIN_POINTS,
  SNAP,
  type KindField,
  type ClosedShape,
  type Line,
  type LinePoint,
  type Ramp,
  type RampPoint,
  type Shape,
  type ShapeKind,
  type ShapePatch,
  type NodeUpdate,
  type FootPoint,
  type SceneNode,
  type ShapeInput,
  type PlayerCamera,
  type RenderJob,
  type RenderResult,
  type ShotCamera,
  type ShotView,
  type View,
  type WalkPreset,
} from "../shared/scene.types";
import { reportError } from "./errors";
import { renderJob } from "./renderView";
import {
  boundsOf,
  isClosed,
  isFootprinted,
  lineProblem,
  rampProblem,
  outlineProblem,
  pathCrosses,
  roundPoints,
  sameValue,
  sampleEdge,
  sampleEdge3,
  selectionFrame,
  splitEdge,
  type Point,
  type Point3,
} from "../shared/geometry";
import { shapesUnder, isGroup, isShape, hiddenIds, lockedIds, selectableAt } from "../shared/tree";
import { cutters, isHole } from "../shared/holes";
import { ShapeMesh } from "./ShapeMesh";
import {
  cameraPosition,
  DEFAULT_CAMERA,
  restoredCamera,
  FOV_DEG,
  MAX_DISTANCE,
  panTo,
  framedCamera,
  lerpCamera,
  paramOnLine,
  rotateBy,
  screenRay,
  screenToGround,
  screenToPlane,
  viewOf,
  worldToScreen,
  YAW_SPEED_DEG,
  zoomBy,
  type Box3,
  type CameraState,
  type GroundPoint,
  type Size,
} from "./camera";
import {
  AXES,
  canCopy,
  dragOffset,
  dragUpdate,
  effectiveChanges,
  elevationTargets,
  gizmoAnchor,
  hitGizmo,
  isScalePart,
  SCALE_PARTS,
  scaleCursor,
  isProfilePart,
  profileParts,
  snapElevation,
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
import { LineMesh } from "./LineMesh";
import { pickHit, pickLine, pickNote, surfaceUnder, type Surface } from "./pick";
import { NoteMesh } from "./NoteMesh";
import { expandNodes, expandShapes, ownerOf } from "../shared/entities";
import {
  handleEnd,
  hitPoints,
  movePoints,
  moveHandle,
  pointY,
  removePoints,
  togglePoint,
  type EditPoint,
  type HandleSide,
  type PointPart,
} from "./points";
import { TransformGizmo } from "./TransformGizmo";
import { captureScene, editorView, type CaptureView } from "./capture";
import { fitSize } from "./shots";
import {
  eyeOf,
  floorUnder,
  frameRect,
  look,
  lookDir,
  move,
  NO_KEYS,
  presetOf,
  settle,
  shotSize,
  STEP_HEIGHT,
  verticalFov,
  viewVerticalFov,
  walkCamera,
  wheelSpeed,
  type Vec3 as WalkVec3,
} from "./walk";
import { Avatar, avatarShapes, loadWalkOptions, newLive, walkKey, WalkHud, WalkMenu, type CameraPose, type WalkLive, type WalkSession } from "./WalkScreens";
import { manifoldReady } from "./csg";

const BACKGROUND = "#f7f6f2";
const VIEW_REPORT_MS = 100;
const NO_IDS = new Set<string>();
/** A capture that hasn't answered by now is given up (each waits for the ones before it). */
const CAPTURE_GIVE_UP_MS = 30_000;
/** How long the camera takes to fly to something framed (the outliner's icon double-click). */
const FLIGHT_MS = 450;
/** A pointer-up within this many px of its pointer-down is a click, not a drag. */
const CLICK_PX = 4;
/** With the Pen, a click this close (px) to the first point closes the outline. */
const CLOSE_PX = 10;

/**
 * The Pen's outline in progress: the points placed so far (world x/z, unrounded), where the cursor is (the next
 * point, snapped like one), and the point whose handle a press-and-drag is pulling out.
 */
type Pen = {
  /**
   * The tool the points belong to: the Pen (a closed free-form, on the ground), the Line tool or the Ramp tool
   * (open, points in 3D).
   */
  owner: "pen" | "line" | "ramp" | null;
  points: EditPoint[];
  /** The Pen's plane: the height of the surface its first point went on (none = the ground). */
  y?: number;
  cursor: EditPoint | null;
  closing: boolean;
  drag: { pointerId: number; index: number; sx: number; sy: number } | null;
};
const NO_PEN: Pen = { owner: null, points: [], cursor: null, closing: false, drag: null };
/** The Line tool's style for the next line, from the contextual bar. */
export type LineStyle = Pick<Line, "color" | "thickness" | "dashed" | "arrow">;
/** The Ramp tool's next ramp, from the contextual bar. */
export type RampStyle = Pick<Ramp, "kind" | "width" | "step" | "base" | "color">;
/** The tools that place points one click at a time. */
type PointTool = "pen" | "line" | "ramp";
const isPointTool = (tool: Tool): tool is PointTool => tool === "pen" || tool === "line" || tool === "ramp";
/** A ramp's points from placed ones: its handles are flat. */
const rampPoints = (points: EditPoint[]): RampPoint[] =>
  roundPoints(points as LinePoint[]).map(({ in: i, out: o, ...p }) => ({ ...p, ...(i ? { in: { x: i.x, z: i.z } } : {}), ...(o ? { out: { x: o.x, z: o.z } } : {}) }));

type YawKey = "left" | "right";
const YAW_KEYS: Record<string, YawKey> = { a: "left", arrowleft: "left", d: "right", arrowright: "right" };

/** An entity's definition as its instances hold it: the top level in a group, so its top-level holes cut there. */
const ENTITY_ROOT = "entity:root";
const inEntityRoot = (nodes: SceneNode[]): SceneNode[] => [
  { id: ENTITY_ROOT, type: "group", createdBy: "human" },
  ...nodes.map((n) => (n.parent === undefined ? ({ ...n, parent: ENTITY_ROOT } as SceneNode) : n)),
];

/** The drag-and-drop type of an entity dragged from the Library (its ID). */
export const ENTITY_DRAG = "application/x-dungeon-entity";

export type Tool = "select" | "hand" | "box" | "cylinder" | "pen" | "line" | "ramp" | "note" | "walk";
/** The tools that drag a footprint on the ground, and the shape type each draws. */
const DRAWS: Partial<Record<Tool, "box" | "cylinder">> = { box: "box", cylinder: "cylinder" };

/** A drawn footprint on the ground, by its center (like a box). */
type Footprint = { x: number; z: number; width: number; depth: number };
/** What the draft being drawn is. */
/** The next shape's kind-specific fields (a room's wall, a volume's taper and bevel); a missing one is the default. */
export type KindFields = Partial<Record<KindField, number>>;

/** The kind-specific fields a new shape of this kind gets: only the ones its kind has. */
const fieldsFor = (kind: ShapeKind, fields: KindFields): KindFields =>
  Object.fromEntries(
    Object.entries(fields).filter(
      ([f, v]) => f in KIND_FIELDS && v !== undefined && (KIND_FIELDS[f as KindField] as readonly ShapeKind[]).includes(kind),
    ),
  );

type Draft = { type: "box" | "cylinder"; kind: ShapeKind; sides?: number } & KindFields;

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
  /** points: move the selected points on the plane at `planeY`; handle: one handle; y: a line's selected points up or down. */
  mode: "points" | "handle" | "y";
  planeY: number;
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
  points: EditPoint[];
  problem: string | null;
  clickSelection?: number[];
  /** A y drag: where along the vertical the cursor started, and the grabbed point's y then. */
  grabY?: number;
  label?: string;
};

/**
 * How far the editor has turned a selection (Figma-style: its frame turns with it while it stays selected), for
 * `key` (the selection). `expect` is the selected shapes as that turn left them: if they change any other way
 * (undo, the agent, another tab), the turn is forgotten and the frame is axis-aligned again.
 */
type Turn = { key: string; angle: number; expect: string };
/** The selected shapes' footprints, for telling whether something other than our own drags changed them. */
const footprintKey = (shapes: Shape[]) =>
  JSON.stringify(
    shapes.map((s) =>
      isFootprinted(s)
        ? [s.x, s.z, s.width, s.depth, s.rotation, s.type === "cylinder" ? s.sides : 0]
        : s.type === "note"
          ? [s.x, s.z]
          : s.type === "instance"
            ? [s.x, s.z, s.rotation, s.entity]
            : s.points,
    ),
  );

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
  /** The kind-specific fields of the shapes the Box, Cylinder and Pen tools draw (a room's wall, a volume's taper and bevel). */
  nextFields: KindFields;
  /** How the Line tool draws the next line. */
  nextLine: LineStyle;
  /** How the Ramp tool draws the next ramp. */
  nextRamp: RampStyle;
  /** Whether holes show as ghosts (off: only the result shows, and hidden holes can't be clicked). */
  showHoles: boolean;
  /** Whether the grid shows (the view bar). */
  showGrid: boolean;
  /** Whether notes show (the view bar); off, they can't be clicked either, unless selected. */
  showNotes: boolean;
  /** A note was placed with the Note tool (at this point, on the surface under the click). */
  onPlaceNote: (at: { x: number; y: number; z: number }) => void;
  /** Edit entity mode (08.5): the nodes are an entity's definition, whose top level is a group in every instance. */
  entityMode: boolean;
  /** Double-clicking an instance opens its entity for editing. */
  onOpenEntity: (entity: string) => void;
  /** An entity being placed from the Library (its ID): the next click puts an instance there. */
  placing: string | null;
  /** An instance of `entity` goes here (a click while placing, or an entity dropped from the Library). */
  onPlaceInstance: (entity: string, at: { x: number; y: number; z: number }) => void;
  /**
   * The nodes that show (null = everything): not the hidden ones, and while a node is isolated only it (and what's
   * new since). The rest can't be seen, picked or snapped to.
   */
  visible: Set<string> | null;
  /** Values held in the inspector (a slider being dragged), shown on their shapes before they're sent. */
  preview: Record<string, ShapePatch> | null;
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
  /** Something to frame, or a camera to go to (a shot's): the camera flies there (a new object each time). */
  cameraFrame: { bounds: Box3 } | { camera: CameraState } | null;
  /** Filled with what the view can do on request (09.1: capture it; 09.2: walk into a shot). */
  api?: RefObject<ViewportApi | null>;
  /** The Walk tool (09.2): the preset a walk starts with, and the project's player camera and saving it. */
  walkPreset: WalkPreset;
  player: PlayerCamera;
  onPlayer: (player: PlayerCamera) => void;
  /** The project's `human` entity, the third-person avatar (a capsule without one). */
  avatarEntity: string | null;
  /** A shot taken while walking: the app saves it. */
  onWalkShot: (shot: { png: Blob; width: number; height: number; camera: ShotCamera }) => void;
  /** A walk started or ended (the app hides its panels meanwhile, and goes back to the Select tool after). */
  onWalkChange: (walking: boolean) => void;
  /** The open document's shots (the pause menu shows this walk's), and deleting one. */
  shots: ShotView[];
  onRemoveShot: (id: string) => void;
};

/** What an entity or the Walk button dragged onto the view carries. */
export const WALK_DRAG = "application/x-orlablocks-walk";

/** What to show in a capture of the view, besides the shapes. */
export type CaptureOptions = { notes: boolean; lines: boolean };
/** A capture of the view: the PNG, its size, and the camera it was taken with. */
export type ViewCapture = { png: Blob; width: number; height: number; camera: CameraState };
/** What the view does on request. */
export type ViewportApi = {
  /** A clean capture of the view as framed, at its size on screen (in device pixels, capped). */
  capture(options: CaptureOptions): Promise<ViewCapture>;
  /** Walks into a walk shot: its pose, preset, field of view and boom, paused (09.2). */
  walkTo(camera: Extract<ShotCamera, { kind: "walk" }>): void;
  /** Renders what the agent asked for (09.3), without touching the view. */
  render(job: RenderJob): Promise<RenderResult>;
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
  nextFields,
  nextLine,
  nextRamp,
  showHoles,
  showGrid,
  showNotes,
  onPlaceNote,
  entityMode,
  onOpenEntity,
  placing,
  onPlaceInstance,
  visible,
  preview,
  onSelect,
  onDrawShape,
  onUpdate,
  onDuplicate,
  onNotice,
  onCursor,
  onViewChange,
  cameraRestore,
  cameraFrame,
  api,
  walkPreset,
  player,
  onPlayer,
  avatarEntity,
  onWalkShot,
  onWalkChange,
  shots,
  onRemoveShot,
}: Props) {
  const cam = useRef<CameraState>({ ...DEFAULT_CAMERA });
  // The compass rose, turned every frame to where north is on screen.
  const rose = useRef<HTMLDivElement>(null);

  // A scene opened with a saved camera: jump to it. The rig renders it and reports the new view.
  useEffect(() => {
    if (!cameraRestore?.camera) return;
    cam.current = restoredCamera(cameraRestore.camera);
    invalidate();
  }, [cameraRestore]);
  // A flight to frame something: the rig plans it on its next frame (it knows the view's size) and flies it.
  const flight = useRef<Flight | null>(null);
  useEffect(() => {
    if (!cameraFrame) return;
    flight.current = "camera" in cameraFrame ? { to: restoredCamera(cameraFrame.camera) } : { bounds: cameraFrame.bounds };
    invalidate();
  }, [cameraFrame]);

  /**
   * A clean capture of the scene (capture.tsx): what it holds as saved, without hidden nodes (the isolation ignored)
   * or hole ghosts, notes and lines as asked, and `extra` shapes (a walk's avatar). Holes are cut once the boolean
   * library is ready: never uncut walls.
   */
  const runCapture = async (
    view: CaptureView,
    width: number,
    height: number,
    pixelRatio: number,
    options: CaptureOptions,
    extra: Shape[] = [],
    /** Other nodes than the document's: an entity's definition (a model sheet), cut as in an instance. */
    source?: SceneNode[],
  ) => {
    await manifoldReady();
    const from = source ?? nodesRef.current;
    const hiddenNow = hiddenIds(from);
    const shapes = [
      ...expandShapes(
        from.filter(isShape).filter((b) => !hiddenNow.has(b.id) && (options.notes || b.type !== "note") && (options.lines || b.type !== "line")),
      ).filter((b) => !isHole(b)),
      ...extra,
    ];
    const cutsNow = source ? cutters(inEntityRoot(expandNodes(source.filter((n) => !hiddenNow.has(n.id))))) : cutsRef.current;
    const entityNow = source ? true : entityModeRef.current;
    return captureScene({
      view,
      width,
      height,
      pixelRatio,
      background: BACKGROUND,
      content: (light) => (
        <>
          <Lighting cam={light} />
          <Boxes boxes={shapes} entityMode={entityNow} cuts={cutsNow} showHoles={false} draft={null} selected={NO_IDS} hovered={NO_IDS} />
        </>
      ),
    });
  };
  if (api) {
    api.current = {
      async capture(options) {
        const cssWidth = wrap.current?.clientWidth || 800;
        const cssHeight = wrap.current?.clientHeight || 600;
        const dpr = window.devicePixelRatio || 1;
        const { width, height } = fitSize(Math.round(cssWidth * dpr), Math.round(cssHeight * dpr));
        // Drawn at the view's own size in CSS pixels, so what's sized in screen pixels matches the screen.
        const camera = { ...cam.current, focus: { ...cam.current.focus } };
        const png = await runCapture(editorView(camera), width, height, width / cssWidth, options);
        return { png, width, height, camera };
      },
      render(job) {
        const nodesNow = nodesRef.current;
        const hiddenNow = hiddenIds(nodesNow);
        const standable = expandShapes(boxesRef.current.filter((b) => !hiddenNow.has(b.id)));
        return renderJob(job, {
          nodes: nodesNow,
          hidden: hiddenNow,
          editor: walkRef.current?.before ?? cam.current,
          player: playerRef.current,
          avatarEntity: avatarEntityRef.current,
          surfaceY: (x, z) => surfaceUnder({ origin: { x, y: 10_000, z }, dir: { x: 0, y: -1, z: 0 } }, standable)?.y ?? 0,
          capture: (view, width, height, options, extra) => runCapture(view, width, height, 1, options, extra),
          captureNodes: (view, width, height, nodes, extra) => runCapture(view, width, height, 1, { notes: false, lines: true }, extra, nodes),
        });
      },
      walkTo(c) {
        if (walkRef.current) return;
        // Floating, so the eye is exactly where the shot's was (floor-follow would move it; F lands).
        startWalk(
          { x: c.eye.x, y: c.eye.y - playerRef.current.eyeHeight, z: c.eye.z },
          { yaw: c.yaw, pitch: c.pitch, preset: c.preset, override: { fov: c.fov, ...(c.boom ? { boom: c.boom } : {}) }, floating: true, paused: true },
        );
      },
    };
  }
  const wrap = useRef<HTMLDivElement>(null);
  const yawKeys = useRef(new Set<YawKey>());

  // ---- Walk (09.2): a session in React state (what the screens show), and what the frame loop moves in `live` ----
  const [walk, setWalkState] = useState<WalkSession | null>(null);
  const walkRef = useRef<WalkSession | null>(null);
  const setWalk = (next: WalkSession | null) => {
    walkRef.current = next;
    setWalkState(next);
  };
  const updateWalk = (patch: Partial<WalkSession>) => walkRef.current && setWalk({ ...walkRef.current, ...patch });
  const live = useRef<WalkLive | null>(null);
  const playerRef = useRef(player);
  playerRef.current = player;
  const onPlayerRef = useRef(onPlayer);
  onPlayerRef.current = onPlayer;
  const avatarEntityRef = useRef(avatarEntity);
  avatarEntityRef.current = avatarEntity;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const [walkFlash, setWalkFlash] = useState<{ key: number; label: string } | null>(null);
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The avatar's shapes at the origin, made again for each walk (the human entity may have changed).
  const avatar = useMemo(() => avatarShapes(avatarEntity, player.eyeHeight), [avatarEntity, player.eyeHeight, walk?.startedAt]);
  const avatarGroup = useRef<THREE.Group>(null);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  /** The field of view and boom this walk uses: a shot's (going to one), else the player camera's for the preset. */
  const walkSettings = (sess: WalkSession) => {
    const base = presetOf(playerRef.current, sess.preset);
    return { fov: sess.override?.fov ?? base.fov, boom: sess.override?.boom ?? base.boom };
  };
  const lockPointer = () => {
    const el = wrap.current;
    if (!el) return;
    try {
      // A promise in current browsers; refused for a while after an Esc (the menu then says to click).
      const p = el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => updateWalk({ relock: true }));
    } catch {
      updateWalk({ relock: true });
    }
  };
  /** Drops into the level with the feet at `feet`: the camera flies to the eye, then (unless `paused`) the pointer locks. */
  const startWalk = (
    feet: WalkVec3,
    opts: { yaw?: number; pitch?: number; preset?: WalkPreset; override?: WalkSession["override"]; floating?: boolean; paused?: boolean } = {},
  ) => {
    if (walkRef.current) return;
    flight.current = null;
    yawKeys.current.clear();
    const before = { ...cam.current, focus: { ...cam.current.focus } };
    live.current = newLive({ feet, yaw: opts.yaw ?? cam.current.yaw, pitch: opts.pitch ?? 0 });
    live.current.flight = { from: editorPose(before), start: performance.now(), ms: reducedMotion() ? 0 : WALK_FLIGHT_MS, toEditor: false };
    setWalk({
      phase: "entering",
      preset: opts.preset ?? walkPreset,
      floating: opts.floating ?? false,
      override: opts.override ?? null,
      before,
      options: loadWalkOptions(),
      startedAt: new Date().toISOString(),
      relock: false,
      pausedAt: 0,
    });
    onWalkChange(true);
    if (!opts.paused) lockPointer();
  };
  /** Leaves the walk: the camera flies back to the editor camera from before it. */
  const exitWalk = () => {
    const sess = walkRef.current;
    const l = live.current;
    if (!sess || !l || sess.phase === "leaving") return;
    if (document.pointerLockElement) document.exitPointerLock();
    l.keys = { ...NO_KEYS };
    l.flight = { from: l.last ?? editorPose(sess.before), start: performance.now(), ms: reducedMotion() ? 0 : WALK_FLIGHT_MS, toEditor: true };
    setWalk({ ...sess, phase: "leaving" });
    invalidate();
  };
  /** The walk is over: the editor camera is back, and the agent no longer sees a walk. */
  const finishWalk = (size: Size) => {
    const sess = walkRef.current;
    if (!sess) return;
    cam.current = { ...sess.before, focus: { ...sess.before.focus } };
    live.current = null;
    setWalk(null);
    onWalkChange(false);
    onViewChangeRef.current(viewOf(cam.current, size), cam.current);
  };
  const continueWalk = () => {
    updateWalk({ relock: false });
    lockPointer();
  };
  /** A shot of what the walker sees, cropped to the frame guide, at its size. */
  const walkShot = async () => {
    const sess = walkRef.current;
    const l = live.current;
    const el = wrap.current;
    if (!sess || !l || !el || sess.phase !== "walking") return;
    const p = playerRef.current;
    const { fov, boom } = walkSettings(sess);
    const frame = frameRect(el.clientWidth, el.clientHeight, sess.options.frame);
    const wanted = shotSize(frame, sess.options.shotSize);
    const { width, height } = fitSize(wanted.width, wanted.height);
    const pose = l.pose;
    const wc = walkCamera(pose, p.eyeHeight, sess.preset, boom);
    const view: CaptureView = { ...wc, vfov: verticalFov(fov, width / height), light: { ...cam.current, focus: { ...cam.current.focus } } };
    const third = sess.preset === "third";
    const extra = third && p.third.avatar ? avatarShapes(avatarEntity, p.eyeHeight, { ...pose.feet, rotation: pose.yaw }) : [];
    setWalkFlash({ key: performance.now(), label: "shot" });
    try {
      const png = await runCapture(view, width, height, width / frame.width, { notes: sess.options.shotNotes, lines: sess.options.shotLines }, extra);
      const eye = eyeOf(pose, p.eyeHeight);
      onWalkShot({
        png,
        width,
        height,
        camera: { kind: "walk", preset: sess.preset, eye, yaw: pose.yaw, pitch: pose.pitch, fov, ...(third ? { boom } : {}) },
      });
    } catch (err) {
      onNotice("The shot wasn't taken");
      reportError("view", err);
    }
  };
  const walkShotRef = useRef(walkShot);
  walkShotRef.current = walkShot;
  const walkActions = useRef({ exitWalk, continueWalk });
  walkActions.current = { exitWalk, continueWalk };

  // The pointer lock: locked is walking, and losing it (Esc, another window) pauses. The mouse looks around.
  useEffect(() => {
    const onLockChange = () => {
      const sess = walkRef.current;
      if (!sess) return;
      const locked = document.pointerLockElement === wrap.current;
      if (locked && sess.phase === "paused") setWalk({ ...sess, phase: "walking", relock: false });
      else if (!locked && sess.phase === "walking") {
        if (live.current) live.current.keys = { ...NO_KEYS };
        setWalk({ ...sess, phase: "paused", pausedAt: performance.now() });
      }
    };
    const onLockError = () => updateWalk({ relock: true });
    const onMouseMove = (e: globalThis.MouseEvent) => {
      const sess = walkRef.current;
      const l = live.current;
      if (!sess || !l || sess.phase !== "walking" || document.pointerLockElement !== wrap.current) return;
      l.pose = look(l.pose, e.movementX, e.movementY);
      invalidate();
    };
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    document.addEventListener("mousemove", onMouseMove);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("pointerlockerror", onLockError);
      document.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  // Keys while walking: they're the walk's, and none reach the editor (capture phase, stopped here). Paused, Enter
  // continues and Esc exits (not the Esc that paused), and typing in the menu's fields works as usual.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const sess = walkRef.current;
      const l = live.current;
      if (!sess || !l) return;
      if (sess.phase === "paused") {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (typingInField(e)) (e.target as HTMLElement).blur();
          else if (performance.now() - sess.pausedAt > 250) walkActions.current.exitWalk();
        } else if (e.key === "Enter" && !(e.target instanceof HTMLInputElement && e.target.type !== "checkbox" && e.target.type !== "range")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          walkActions.current.continueWalk();
        } else if (!typingInField(e)) e.stopImmediatePropagation();
        return;
      }
      e.stopImmediatePropagation();
      if (sess.phase !== "walking" && sess.phase !== "entering") return;
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      const k = walkKey(e.code);
      if (k) {
        l.keys = { ...l.keys, [k]: true };
        if ((k === "up" || k === "down") && !sess.floating) updateWalk({ floating: true });
        invalidate();
      } else if (e.code === "KeyF" && sess.floating) updateWalk({ floating: false });
      else if (e.code === "KeyK" && !e.repeat) void walkShotRef.current();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const l = live.current;
      if (!walkRef.current || !l) return;
      e.stopImmediatePropagation();
      const k = walkKey(e.code);
      if (k) l.keys = { ...l.keys, [k]: false };
    };
    const onBlur = () => {
      if (live.current) live.current.keys = { ...NO_KEYS };
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  /** Where the Walk tool drops the feet: the flat surface under the pointer (a floor, a top), else the ground. */
  const dropPoint = (e: { clientX: number; clientY: number }): WalkVec3 => {
    const { sx, sy, size } = local(e);
    const y = surfaceFor(sx, sy, size)?.y ?? 0;
    const g = screenToPlane(cam.current, size, sx, sy, y);
    return { x: g.x, y, z: g.z };
  };

  /** The floor under the feet, from the rendered (cut) meshes: see `floorUnder`. */
  const floorAt = (scene: THREE.Scene, feet: WalkVec3): number | null => {
    const walkables: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.userData.walkable && (o as THREE.Mesh).isMesh) walkables.push(o);
    });
    raycaster.set(new THREE.Vector3(feet.x, feet.y + STEP_HEIGHT, feet.z), DOWN);
    const hits = raycaster.intersectObjects(walkables, false).map((h) => ({
      y: h.point.y,
      up: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).y : 0,
    }));
    return floorUnder(hits, feet.y);
  };

  /** One frame of the walk (the rig calls it instead of drawing the editor camera). */
  const walker = useRef<WalkDriver | null>(null);
  walker.current = {
    active: () => walkRef.current !== null && live.current !== null,
    step(camera, scene, size, delta) {
      const sess = walkRef.current!;
      const l = live.current!;
      const p = playerRef.current;
      const dt = Math.min(delta, 0.05);
      if (sess.phase === "walking") {
        let pose = move(l.pose, l.keys, p.speed, dt);
        if (!sess.floating) {
          const floor = floorAt(scene, pose.feet);
          if (floor !== null && floor !== pose.feet.y) pose = { ...pose, feet: { ...pose.feet, y: settle(pose.feet.y, floor, dt) } };
        }
        l.pose = pose;
      }
      const { fov, boom } = walkSettings(sess);
      const frame = frameRect(size.width, size.height, sess.options.frame);
      let shown: CameraPose = { ...walkCamera(l.pose, p.eyeHeight, sess.preset, boom), vfov: viewVerticalFov(fov, frame, size.height) };
      let done = false;
      if (l.flight) {
        const t = l.flight.ms > 0 ? Math.min(1, (performance.now() - l.flight.start) / l.flight.ms) : 1;
        shown = blendPose(l.flight.from, l.flight.toEditor ? editorPose(sess.before) : shown, easeInOut(t));
        if (t >= 1) {
          done = l.flight.toEditor;
          l.flight = null;
          if (!done) {
            const locked = document.pointerLockElement === wrap.current;
            setWalk({ ...sess, phase: locked ? "walking" : "paused", pausedAt: performance.now() });
          }
        }
      }
      camera.position.set(shown.position.x, shown.position.y, shown.position.z);
      camera.up.set(0, 1, 0);
      camera.lookAt(shown.target.x, shown.target.y, shown.target.z);
      // Walking, walls come close: a nearer clipping plane than the editor's.
      if (camera instanceof THREE.PerspectiveCamera && (camera.fov !== shown.vfov || camera.near !== WALK_NEAR)) {
        camera.fov = shown.vfov;
        camera.near = WALK_NEAR;
        camera.updateProjectionMatrix();
      }
      l.last = shown;
      const g = avatarGroup.current;
      if (g) {
        g.visible = sess.preset === "third" && p.third.avatar && sess.phase !== "leaving" && !l.flight;
        g.position.set(l.pose.feet.x, l.pose.feet.y, l.pose.feet.z);
        g.rotation.set(0, (l.pose.yaw * Math.PI) / 180, 0);
      }
      if (done) {
        finishWalk(size);
        invalidate();
        return;
      }
      // The sun and its shadows follow the walker (the editor camera comes back from `before`).
      const eye = eyeOf(l.pose, p.eyeHeight);
      const ahead = lookDir(l.pose.yaw, 0);
      cam.current = { focus: { x: eye.x + ahead.x * 10, z: eye.z + ahead.z * 10 }, yaw: l.pose.yaw, distance: 40 };
      // The agent sees where the human walks (the saved camera stays the editor's).
      const now = performance.now();
      if (now - l.lastReport > WALK_REPORT_MS) {
        l.lastReport = now;
        onViewChangeRef.current(
          { ...viewOf(sess.before, size), walking: { preset: sess.preset, eye: { x: round2(eye.x), y: round2(eye.y), z: round2(eye.z) }, yaw: round2(l.pose.yaw), pitch: round2(l.pose.pitch), fov } },
          sess.before,
        );
      }
      invalidate();
    },
  };

  // A scene opening while walking ends the walk at once (its camera is the new scene's).
  useEffect(() => {
    if (!cameraRestore || !walkRef.current) return;
    if (document.pointerLockElement) document.exitPointerLock();
    live.current = null;
    setWalk(null);
    onWalkChange(false);
  }, [cameraRestore]);
  const pan = useRef<{ pointerId: number; grabbed: GroundPoint; sx: number; sy: number } | null>(null);
  // A footprint being drawn stands on the surface where the press was (`y`, 0 = the ground), described by `on`.
  type OnSurface = { y: number; on: string | null };
  const drawing = useRef<(Draft & OnSurface & { pointerId: number; start: GroundPoint }) | null>(null);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<(Footprint & Draft & OnSurface & { sx: number; sy: number }) | null>(null);
  // Where a press would start a shape (a drawing tool, hovering): shown next to the cursor when it's not the ground.
  const [landing, setLanding] = useState<{ sx: number; sy: number; text: string } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // The note under the cursor, for its text next to it.
  const [noteHover, setNoteHover] = useState<{ id: string; sx: number; sy: number } | null>(null);
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
  const [hotY, setHotY] = useState(false);

  const boxes = nodes.filter(isShape);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  // What's on screen: the server's boxes, with the drag in progress (or just released) applied locally. A copy
  // leaves the originals where they are and shows the copies (`ghosts`) where the drag puts them. A point edit in
  // progress shows too, while its outline is valid.
  const override = drag?.active ? drag : pending;
  const moved = (b: Shape): Shape => (override?.patches[b.id] ? ({ ...b, ...override.patches[b.id] } as Shape) : b);
  const pointPreview = pointDrag && (pointDrag.active || pointDrag.inserted) ? pointDrag : null;
  const previewed = preview ? boxes.map((b) => (preview[b.id] ? ({ ...b, ...preview[b.id] } as Shape) : b)) : boxes;
  const shown = (override && !override.copy ? previewed.map(moved) : previewed).map((b) =>
    pointPreview && !pointPreview.problem && b.id === editing ? ({ ...b, points: roundPoints(pointPreview.points) } as Shape) : b,
  );
  const ghosts = override?.copy ? override.origin.map((b) => ({ ...moved(b), id: `${b.id}:copy` }) as Shape) : [];
  // Hidden holes (Show holes off) can't be clicked or marquee-selected, unless they're selected.
  const selectedIds = new Set(shapesUnder(nodes, selection).map((b) => b.id));
  // Hidden nodes and what's outside the isolation don't show.
  const onView = (visible ? shown.filter((b) => visible.has(b.id)) : shown).filter((b) => showNotes || b.type !== "note" || selectedIds.has(b.id));
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  // What's drawn: each instance as its entity's shapes (IDs like `instance_4/box_2`; `ownerOf` maps a hit back).
  const drawn = expandShapes(onView);
  const pickable = showHoles ? drawn : drawn.filter((b) => !isHole(b) || selectedIds.has(b.id) || selectedIds.has(ownerOf(b.id)));
  // Locked nodes (and what's in them) can't be clicked, hovered or marquee-selected, unless selected from the
  // outliner; they still count as surfaces to draw on and snap to.
  const locked = lockedIds(nodes);
  const selectable = pickable.filter((b) => !locked.has(ownerOf(b.id)) || selectedIds.has(ownerOf(b.id)));
  // Which holes cut which shapes, as shown (so a drag cuts live).
  // A hidden hole cuts nothing; holes outside the isolation still cut what shows (the cut follows the data).
  const hidden = hiddenIds(nodes);
  // Instances cut and are cut as groups of their shapes.
  // In an entity's definition the top level is a group (in every instance), so its holes cut there.
  const cutList = expandNodes([...nodes.filter(isGroup), ...shown.filter((b) => !(isHole(b) && hidden.has(b.id))), ...ghosts]);
  const cuts = cutters(entityMode ? inEntityRoot(cutList) : cutList);
  // For captures, which run after awaits: the scene as it is then.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const cutsRef = useRef(cuts);
  cutsRef.current = cuts;
  const entityModeRef = useRef(entityMode);
  entityModeRef.current = entityMode;
  // The free-form or line in point editing, as shown. A free-form's points sit on its top face (`editTop`); a
  // line's carry their own y, and its path is open.
  const editShape =
    editing !== null ? shown.find((b) => b.id === editing && (b.type === "freeform" || b.type === "line" || b.type === "ramp")) : undefined;
  const editPoints: EditPoint[] | null =
    editShape?.type === "freeform" || editShape?.type === "line" || editShape?.type === "ramp" ? (pointPreview?.points ?? editShape.points) : null;
  const editTop = editShape?.type === "freeform" ? editShape.y + editShape.height : 0;
  const editClosed = editShape?.type === "freeform";
  // A line's selected point has a y arrow to raise or lower it (and the other selected points with it).
  const yArrow =
    tool === "select" && (editShape?.type === "line" || editShape?.type === "ramp") && editPoints && pointSel.length > 0 && editPoints[pointSel[0]]
      ? { x: editPoints[pointSel[0]].x, y: pointY(editPoints[pointSel[0]], 0), z: editPoints[pointSel[0]].z }
      : null;
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
  // Height and scale handles and the profile knobs are for a single closed shape (a line has none; a tilted
  // shape's sit on its own tilted top). Tilt rings are for a single box or cylinder volume or hole.
  const scalable = single && isClosed(single) ? single : undefined;
  const tiltable = single && isFootprinted(single) && single.kind !== "room";
  // The selection frame turns with the selection: live while rotating, then as far as it was turned.
  const selectionKey = selection.join(",");
  const frameTurn = drag?.active && drag.turn !== undefined ? drag.turn : turn?.key === selectionKey ? turn.angle : 0;
  const frame = selectedBoxes.length > 0 ? selectionFrame(selectedBoxes, frameTurn) : null;
  const gizmo =
    frame && selectedBoxes.length > 0
      ? {
          anchor: gizmoAnchor(boundsOf(selectedBoxes), frame),
          parts: [
            ...(scalable
              ? ["x", "y", "z", "rotate", "height", ...SCALE_PARTS, ...profileParts(scalable)]
              : selectedBoxes.every((b) => b.type === "note")
                ? ["x", "y", "z"]
                : ["x", "y", "z", "rotate"]),
            ...(tiltable ? ["pitch", "roll"] : []),
          ] as GizmoPart[],
          boxes: selectedBoxes,
          box: scalable,
          frame,
        }
      : null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top, size: { width: r.width, height: r.height } };
  };

  /** The flat surface under the pointer that a new box, cylinder or free-form would stand on (null: the ground). */
  const surfaceFor = (sx: number, sy: number, size: Size) => surfaceUnder(screenRay(cam.current, size, sx, sy), pickable);
  /** The point under the pointer on the level plane at height `y`, snapped to 0.5 m unless Cmd/Ctrl is held. */
  const planeAt = (e: PointerEvent, y: number) => {
    const { sx, sy, size } = local(e);
    const g = screenToPlane(cam.current, size, sx, sy, y);
    return { sx, sy, point: noSnap(e) ? { x: g.x, z: g.z } : { x: snap(g.x), z: snap(g.z) } };
  };
  /** Where a new shape lands, for the labels: `on hall's floor · y 3`, or null for the ground. */
  const surfaceText = (surface: Surface | null) => {
    if (!surface) return null;
    const n = nodes.find((b) => b.id === ownerOf(surface.id));
    return `on ${n?.name ?? surface.id}'s ${surface.what} · y ${round2(surface.y)}`;
  };
  /** While hovering in a drawing tool: shows where a press would start a shape, when that's not the ground. */
  const showLanding = (sx: number, sy: number, size: Size) => {
    const text = surfaceText(surfaceFor(sx, sy, size));
    setLanding(text ? { sx, sy, text } : null);
  };

  /**
   * What a click on box `id` selects: the node at the current level (the outermost group, or inside the entered
   * group its child). `leaves` says the box is outside the entered group, so the click leaves it.
   */
  const resolve = (id: string) => {
    const inside = context === null ? null : selectableAt(nodes, id, context);
    return inside !== null ? { id: inside, leaves: false } : { id: selectableAt(nodes, id, null) ?? id, leaves: context !== null };
  };
  /**
   * The shape under the cursor and the point where it's hit: a line first (they're drawn over everything, picked
   * within a few px of their path on screen), else the first closed shape the ray hits.
   */
  const hitAt = (sx: number, sy: number, size: Size) => {
    const hit =
      pickNote(cam.current, size, sx, sy, selectable) ??
      pickLine(cam.current, size, sx, sy, selectable) ??
      pickHit(screenRay(cam.current, size, sx, sy), selectable);
    // A part of an instance picks the instance.
    return hit && { ...hit, id: ownerOf(hit.id) };
  };
  const pickAt = (sx: number, sy: number, size: Size) => {
    const id = hitAt(sx, sy, size)?.id;
    return id === undefined ? null : resolve(id).id;
  };
  const gizmoAt = (sx: number, sy: number, size: Size) =>
    gizmo ? hitGizmo(cam.current, size, sx, sy, gizmo.anchor, gizmo.parts, gizmo.boxes, gizmo.frame) : null;
  /** The point, handle or edge of the edited free-form or line under the cursor. */
  const pointAt = (sx: number, sy: number, size: Size) =>
    editPoints ? hitPoints(cam.current, size, sx, sy, editPoints, editTop, pointSel, editClosed) : null;
  /** Whether the cursor is on a line point's y arrow. */
  const yArrowAt = (sx: number, sy: number, size: Size) => !!yArrow && hitGizmo(cam.current, size, sx, sy, yArrow, ["y"]) === "y";

  const cancelDrawing = () => {
    drawing.current = null;
    setDraft(null);
  };

  // Switching tools (or holding Space) mid-drag drops the unfinished footprint, gizmo drag or marquee (keeping
  // whatever the marquee has selected so far). The Pen's outline (or the Line tool's path) takes many clicks, so it
  // survives the hand (Space to pan while drawing) and is dropped by any other tool.
  useEffect(() => {
    cancelDrawing();
    setLanding(null);
    setDrag(null);
    setPointDrag(null);
    setMarquee(null);
    setPen((p) => (tool === "hand" || tool === p.owner ? { ...p, cursor: null, closing: false, drag: null } : NO_PEN));
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
    const others = expandShapes(copy ? onViewRef.current : onViewRef.current.filter((b) => !d.ids.includes(b.id)));
    const mods = { shift: keys.shiftKey, alt: keys.altKey, snap: !noSnap(keys) };
    const size = { width: wrap.current!.clientWidth, height: wrap.current!.clientHeight };
    const { patches, label, turn } = dragUpdate(d, cam.current, size, sx, sy, mods, others);
    return { ...d, active: true, copy, patches, label, turn, sx, sy };
  };

  /** A point's position on screen (a free-form's at ground level, a line's at its own y). */
  const onScreen = (p: Point & { y?: number }) =>
    worldToScreen(cam.current, { width: wrap.current!.clientWidth, height: wrap.current!.clientHeight }, { x: p.x, y: p.y ?? 0, z: p.z });

  /**
   * The Line tool's point under the cursor: on the surface there (a volume's top, a room's floor or wall top; lines
   * don't count), else on the ground. x and z snap to 0.5 m unless Cmd/Ctrl; y comes from the surface.
   */
  const surfaceAt = (e: { clientX: number; clientY: number; metaKey: boolean; ctrlKey: boolean }): LinePoint => {
    const { sx, sy, size } = local(e);
    const hit = pickHit(screenRay(cam.current, size, sx, sy), pickable);
    const p = hit ? hit.point : { ...screenToGround(cam.current, size, sx, sy), y: 0 };
    return noSnap(e) ? { x: p.x, y: round2(p.y), z: p.z } : { x: snap(p.x), y: round2(p.y), z: snap(p.z) };
  };
  /** The Pen's plane: its first point's (once placed), else the surface under the cursor's. */
  const penY = (e: PointerEvent) => {
    if (pen.owner === "pen" && pen.points.length > 0) return pen.y ?? 0;
    const { sx, sy, size } = local(e);
    return surfaceFor(sx, sy, size)?.y ?? 0;
  };
  /**
   * Where the tool puts its next point: the surface under the cursor (the Line and Ramp tools), or the Pen's plane
   * (the surface its first point went on).
   */
  const placeAt = (e: PointerEvent): EditPoint => (tool === "line" || tool === "ramp" ? surfaceAt(e) : planeAt(e, penY(e)).point);

  /**
   * Finishes what the Pen or the Line tool drew (rounded to 2 decimals): the Pen's outline as a free-form, the
   * Line tool's path as a line in the contextual bar's style. Unless it isn't valid: then the status bar says why
   * and the points stay, to fix with Backspace.
   */
  const finishPen = (p: Pen) => {
    if (p.owner === "ramp") {
      const points = rampPoints(p.points);
      const ramp = { id: "", type: "ramp" as const, ...nextRamp, points, createdBy: "human" as const };
      const problem = points.length < MIN_LINE_POINTS ? `a ramp needs at least ${MIN_LINE_POINTS} points` : rampProblem(ramp);
      if (problem) {
        onNotice(`Can't finish: ${problem}`);
        return;
      }
      const { color: _color, ...style } = nextRamp;
      onDrawShape({ type: "ramp", ...style, points });
      setPen(NO_PEN);
      return;
    }
    if (p.owner === "line") {
      const rounded = roundPoints(p.points as LinePoint[]);
      const problem = rounded.length < MIN_LINE_POINTS ? `a line needs at least ${MIN_LINE_POINTS} points` : lineProblem(rounded);
      if (problem) {
        onNotice(`Can't finish: ${problem}`);
        return;
      }
      onDrawShape({ type: "line", points: rounded, thickness: nextLine.thickness, dashed: nextLine.dashed, arrow: nextLine.arrow });
      setPen(NO_PEN);
      return;
    }
    const rounded = roundPoints(p.points);
    const problem = outlineProblem(rounded);
    if (problem) {
      onNotice(`Can't close: ${problem}`);
      return;
    }
    onDrawShape({ type: "freeform", kind: nextKind, ...fieldsFor(nextKind, nextFields), ...(p.y ? { y: round2(p.y) } : {}), points: rounded });
    setPen(NO_PEN);
  };
  const finishPenRef = useRef(finishPen);
  finishPenRef.current = finishPen;

  // Pen and Line tool: a press adds a corner at the (snapped) point, and dragging before release pulls out its
  // handles (a smooth point). With the Pen, pressing the first point (with 3 or more) closes the outline.
  const penDown = (e: PointerEvent) => {
    const { sx, sy } = local(e);
    const own = pen.owner === tool ? pen : { ...NO_PEN, owner: tool as PointTool };
    const { points } = own;
    const first = points[0] && onScreen(points[0]);
    if (tool === "pen" && points.length >= 3 && first && Math.hypot(first.sx - sx, first.sy - sy) <= CLOSE_PX) {
      finishPen(own);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const y = tool === "pen" ? (points.length > 0 ? own.y : penY(e)) : undefined;
    const point = placeAt(e);
    setLanding(null);
    const last = points.at(-1);
    // A second press in the same place (a double-click) adds nothing, but can still pull out the handles.
    const same = last && last.x === point.x && last.z === point.z;
    const next = same ? points : [...points, point];
    setPen({ ...own, ...(y ? { y } : {}), points: next, drag: { pointerId: e.pointerId, index: next.length - 1, sx, sy } });
  };

  /** The Pen as the cursor moves: pulling out the pressed point's handles, or showing where the next point goes. */
  const penMove = (e: PointerEvent) => {
    const { sx, sy, size } = local(e);
    const d = pen.drag;
    if (d?.pointerId === e.pointerId) {
      if (Math.hypot(sx - d.sx, sy - d.sy) < CLICK_PX) return;
      // Handles aren't snapped: the out handle follows the cursor (on the plane at the point's height) and the in
      // handle mirrors it. A line's handles are 3D, flat to start with.
      const p = pen.points[d.index];
      const g = screenToPlane(cam.current, size, sx, sy, p.y ?? pen.y ?? 0);
      const flat = p.y !== undefined ? { y: 0 } : {};
      const out = { x: g.x - p.x, ...flat, z: g.z - p.z };
      const points = pen.points.map((q, i) => (i === d.index ? { ...q, in: { x: -out.x, ...flat, z: -out.z }, out } : q));
      setPen({ ...pen, points, cursor: null });
      return;
    }
    const first = pen.points[0] && onScreen(pen.points[0]);
    const closing = tool === "pen" && pen.points.length >= 3 && !!first && Math.hypot(first.sx - sx, first.sy - sy) <= CLOSE_PX;
    setPen({ ...pen, owner: pen.owner ?? (tool as PointTool), cursor: closing ? { ...pen.points[0] } : placeAt(e), closing });
    if (tool === "pen" && pen.points.length === 0) showLanding(sx, sy, size);
    else setLanding(null);
  };

  /** What's wrong with edited points (a free-form's outline, a line's or a ramp's path), or null. */
  const pointsProblem = (points: EditPoint[]) =>
    editShape?.type === "ramp"
      ? rampProblem({ ...editShape, points: rampPoints(points) })
      : editClosed
        ? outlineProblem(roundPoints(points))
        : lineProblem(roundPoints(points as LinePoint[]));

  /**
   * Sends edited points (rounded) as one step, and shows them until the server's scene arrives. Refused, with the
   * reason in the status bar, if they aren't a valid outline or path. Returns whether they were kept.
   */
  const commitPoints = (points: EditPoint[], verb: string): boolean => {
    const original = boxesRef.current.find((b) => b.id === editing);
    if (original?.type !== "freeform" && original?.type !== "line" && original?.type !== "ramp") return false;
    const rounded = original.type === "ramp" ? rampPoints(points) : roundPoints(points);
    const problem = original.type === "ramp" ? rampProblem({ ...original, points: rampPoints(points) }) : pointsProblem(points);
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
    // Points are dragged on the plane at their height: a free-form's top, a line point's own y.
    const start = part.type === "edge" ? splitEdge(editPoints, part.index, part.t) : editPoints;
    const index = part.type === "edge" ? part.index + 1 : part.index;
    const planeY = pointY(start[index], editTop);
    const grab = screenToPlane(cam.current, size, sx, sy, planeY);
    const base = { pointerId: e.pointerId, planeY, grab, sx0: sx, sy0: sy, sx, sy, active: false, problem: null, start, points: start };
    if (part.type === "handle") {
      setPointDrag({ ...base, mode: "handle", index, side: part.side, indices: [], inserted: false });
      return;
    }
    if (part.type === "edge") {
      setPointSel([index]);
      setPointDrag({ ...base, mode: "points", index, indices: [index], inserted: true });
      return;
    }
    const was = pointSel.includes(index);
    const indices = was ? pointSel : e.shiftKey ? [...pointSel, index] : [index];
    const clickSelection = e.shiftKey ? (was ? pointSel.filter((i) => i !== index) : indices) : [index];
    if (!was) setPointSel(indices);
    setPointDrag({ ...base, mode: "points", index, indices, inserted: false, clickSelection });
  };

  /** A press on a line point's y arrow: raises or lowers the selected points. */
  const yArrowDown = (e: PointerEvent, sx: number, sy: number, size: Size) => {
    if (!editPoints || !yArrow) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const grabY = paramOnLine(cam.current, size, sx, sy, yArrow, AXES.y);
    const base = { pointerId: e.pointerId, planeY: yArrow.y, grab: yArrow, sx0: sx, sy0: sy, sx, sy, active: true, problem: null };
    setPointDrag({ ...base, mode: "y", index: pointSel[0], indices: pointSel, start: editPoints, points: editPoints, inserted: false, grabY });
  };

  /**
   * A point drag as the cursor moves: the grabbed point follows it (snapped to 0.5 m unless Cmd/Ctrl) and the
   * other selected points move with it; a handle follows it freely, turning its opposite with it unless Alt.
   */
  const pointMove = (d: PointDrag, e: PointerEvent, sx: number, sy: number, size: Size) => {
    if (!d.active && Math.hypot(sx - d.sx0, sy - d.sy0) < CLICK_PX) return;
    const q = d.start[d.index];
    if (d.mode === "y") {
      // The grabbed point's y follows the cursor along the vertical, snapping to the ground and the tops under it.
      const from = pointY(q, 0);
      const raw = from + paramOnLine(cam.current, size, sx, sy, { x: q.x, y: from, z: q.z }, AXES.y) - d.grabY!;
      const near = { minX: q.x - 0.01, maxX: q.x + 0.01, minY: from, maxY: from, minZ: q.z - 0.01, maxZ: q.z + 0.01 };
      const y = snapElevation(raw, elevationTargets(near, expandShapes(onViewRef.current)), !noSnap(e));
      const points = movePoints(d.start, d.indices, 0, 0, y - from);
      setPointDrag({ ...d, points, problem: pointsProblem(points), sx, sy, label: `y ${y.toFixed(2)} m` });
      return;
    }
    const p = screenToPlane(cam.current, size, sx, sy, d.planeY);
    let points: EditPoint[];
    if (d.mode === "handle" && d.side) {
      const h = q[d.side]!;
      points = moveHandle(d.start, d.index, d.side, { ...h, x: h.x + p.x - d.grab.x, z: h.z + p.z - d.grab.z }, e.altKey);
    } else {
      let x = q.x + p.x - d.grab.x;
      let z = q.z + p.z - d.grab.z;
      if (!noSnap(e)) [x, z] = [snap(x), snap(z)];
      points = movePoints(d.start, d.indices, x - q.x, z - q.z);
    }
    setPointDrag({ ...d, active: true, points, problem: pointsProblem(points), sx, sy });
  };

  // Select tool: a gizmo handle drags it. Pressing a box selects it (unless it's already selected) and dragging
  // moves the selection; a click selects just that box. With Shift, pressing an unselected box adds it (and a drag
  // moves them all), and clicking a selected one removes it. Empty ground: a drag draws a marquee, a click
  // deselects (Shift keeps the selection).
  // Hand tool (or middle button in any tool): drag to pan, the grabbed ground point stays under the cursor.
  // Box and Cylinder tools: drag a footprint on the ground.
  const onPointerDown = (e: PointerEvent) => {
    // Walking: a click is the shutter, or (paused after a refused lock) continues. Nothing else happens in the view.
    if (walkRef.current) {
      if (e.button !== 0) return;
      if (walkRef.current.phase === "walking") void walkShot();
      else if (walkRef.current.phase === "paused" && walkRef.current.relock) continueWalk();
      return;
    }
    // The Walk tool: a click drops the walker on the surface under it.
    if (e.button === 0 && tool === "walk") {
      startWalk(dropPoint(e));
      return;
    }
    const { sx, sy, size } = local(e);
    // Working in the view drops any highlighted page text, so Cmd/Ctrl+C copies the shapes again, not stale text.
    window.getSelection()?.removeAllRanges();
    // Placing an entity: a click puts an instance on the surface under it.
    if (e.button === 0 && placing) {
      const p = surfaceAt(e);
      onPlaceInstance(placing, { x: round2(p.x), y: round2(p.y), z: round2(p.z) });
      return;
    }
    // The Note tool: a click pins a note on the surface under it.
    if (e.button === 0 && tool === "note") {
      const p = surfaceAt(e);
      onPlaceNote({ x: round2(p.x), y: round2(p.y), z: round2(p.z) });
      return;
    }
    if (e.button === 0 && tool === "select") {
      // In point editing, a press grabs a point, a handle or an edge. Pressing the free-form elsewhere deselects
      // the points; pressing anything else leaves point editing (empty ground does only that).
      if (editShape) {
        if (yArrowAt(sx, sy, size)) {
          yArrowDown(e, sx, sy, size);
          return;
        }
        const part = pointAt(sx, sy, size);
        if (part) {
          pointDown(e, part, sx, sy, size);
          return;
        }
        const hit = hitAt(sx, sy, size);
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
      const hit = hitAt(sx, sy, size);
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
    if (e.button === 0 && isPointTool(tool)) {
      penDown(e);
      return;
    }
    const draws = DRAWS[tool];
    const panButton = e.button === 1 || (e.button === 0 && !draws && !isPointTool(tool));
    const drawButton = e.button === 0 && !!draws;
    if (!panButton && !drawButton) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (panButton) {
      const grabbed = screenToGround(cam.current, size, sx, sy);
      pan.current = { pointerId: e.pointerId, grabbed, sx, sy };
      setPanning(true);
    } else {
      const surface = surfaceFor(sx, sy, size);
      const y = surface?.y ?? 0;
      const { point } = planeAt(e, y);
      const on = surfaceText(surface);
      setLanding(null);
      const shape: Draft = {
        type: draws!,
        kind: nextKind,
        ...(draws === "cylinder" && nextSides !== undefined ? { sides: nextSides } : {}),
        ...fieldsFor(nextKind, nextFields),
      };
      drawing.current = { pointerId: e.pointerId, ...shape, start: point, y, on };
      setDraft({ ...shape, ...point, width: 0, depth: 0, sx, sy, y, on });
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (walkRef.current) return;
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
        for (const id of marqueeHits(cam.current, size, selectable, rectFrom(marquee.start, end))) {
          const r = resolve(ownerOf(id));
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
    if (isPointTool(tool)) {
      penMove(e);
      return;
    }
    const d = drawing.current;
    if (d?.pointerId === e.pointerId) {
      const { point } = planeAt(e, d.y);
      setDraft({ ...d, ...footprintFrom(d.start, point, e.shiftKey, e.altKey), sx, sy });
      return;
    }
    if (DRAWS[tool]) showLanding(sx, sy, size);
    // Just hovering: in point editing, what a press would grab (for the cursor); otherwise highlight the gizmo
    // handle, or in the Select tool the box that a press would grab.
    if (editShape && tool === "select") {
      const onY = yArrowAt(sx, sy, size);
      setHotY(onY);
      setHotPoint(onY ? null : pointAt(sx, sy, size));
      setHotPart(null);
      setHoveredId(null);
      return;
    }
    const hot = gizmoAt(sx, sy, size);
    setHotPart(hot);
    setHoveredId(tool === "select" && !hot ? pickAt(sx, sy, size) : null);
    const note = tool === "select" && !hot ? pickNote(cam.current, size, sx, sy, selectable) : null;
    setNoteHover(note ? { id: note.id, sx, sy } : null);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (walkRef.current) return;
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
      const f = footprintFrom(d.start, planeAt(e, d.y).point, e.shiftKey, e.altKey);
      if (round2(f.width) > 0 && round2(f.depth) > 0) {
        onDrawShape({
          type: d.type,
          ...(d.sides !== undefined ? { sides: d.sides } : {}),
          ...fieldsFor(d.kind, d),
          kind: d.kind,
          ...(d.y !== 0 ? { y: round2(d.y) } : {}),
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
    if (walkRef.current) return;
    // The Line and Ramp tools: a double-click finishes the path (its second press added nothing).
    if (tool === "line" || tool === "ramp") {
      if (pen.owner === tool && pen.points.length > 0) finishPen(pen);
      return;
    }
    if (tool !== "select") return;
    const { sx, sy, size } = local(e);
    if (editShape && editPoints) {
      const part = pointAt(sx, sy, size);
      if (part?.type !== "point") return;
      const smooth = !!(editPoints[part.index].in || editPoints[part.index].out);
      if (commitPoints(togglePoint(editPoints, part.index, editClosed), smooth ? "make it a corner" : "make it smooth")) setPointSel([part.index]);
      return;
    }
    const id = hitAt(sx, sy, size)?.id;
    if (id === undefined) return;
    const target = resolve(id).id;
    if (target === id) {
      // Already the shape itself (an instance: open its entity for editing).
      const hitNode = shown.find((b) => b.id === id);
      if (hitNode?.type === "instance") {
        onOpenEntity(hitNode.entity);
        return;
      }
      const type = hitNode?.type;
      if (type === "freeform" || type === "line" || type === "ramp") {
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
  const editKeys = useRef({ editing, pointSel, pointDrag, editPoints, editClosed, commitPoints, onEditing, onNotice });
  editKeys.current = { editing, pointSel, pointDrag, editPoints, editClosed, commitPoints, onEditing, onNotice };
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
      const left = removePoints(k.editPoints, k.pointSel, k.editClosed ? MIN_POINTS : MIN_LINE_POINTS);
      if (!left) {
        k.onNotice(k.editClosed ? `A free-form needs at least ${MIN_POINTS} points` : `A line needs at least ${MIN_LINE_POINTS} points`);
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
      else if (e.key === "Enter") finishPenRef.current(penRef.current);
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
      // The pause menu scrolls as a page does.
      if (e.target instanceof Element && e.target.closest(".walk-menu")) return;
      e.preventDefault();
      const deltaY = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      // Walking, the wheel is the speed (saved in the player camera).
      if (walkRef.current) {
        if (walkRef.current.phase === "walking") onPlayerRef.current({ ...playerRef.current, speed: Math.round(wheelSpeed(playerRef.current.speed, deltaY) * 10) / 10 });
        return;
      }
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
    if (pointDrag?.active) return pointDrag.mode === "y" ? "resizing" : "moving";
    if (editShape && tool === "select" && hotY) return "resizing";
    if (editShape && tool === "select" && hotPoint) return hotPoint.type === "edge" ? "adding" : "moving";
    if (activePart && isScalePart(activePart)) {
      return scaleBox && size ? `resize-${scaleCursor(cam.current, size, scaleBox, activePart, drag?.active ? drag.frame : gizmo?.frame)}` : "moving";
    }
    if (drag?.active && drag.copy) return "copying";
    if (activePart === "rotate" || activePart === "pitch" || activePart === "roll") return "rotating";
    if (activePart === "y" || activePart === "height") return "resizing";
    if (activePart && isProfilePart(activePart)) return "shaping";
    if (activePart) return "moving";
    if (panning) return "panning";
    return DRAWS[tool] || isPointTool(tool) || tool === "walk" ? "drawing" : tool === "select" ? "selecting" : "";
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
      // An entity dragged from the Library lands on the surface under the drop.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ENTITY_DRAG) || (e.dataTransfer.types.includes(WALK_DRAG) && !walkRef.current)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        // The Walk button dropped here: a walk starts where it lands, paused (a drop can't lock the pointer).
        if (e.dataTransfer.types.includes(WALK_DRAG)) {
          e.preventDefault();
          startWalk(dropPoint(e), { paused: true });
          return;
        }
        const entity = e.dataTransfer.getData(ENTITY_DRAG);
        if (!entity) return;
        e.preventDefault();
        const p = surfaceAt(e);
        onPlaceInstance(entity, { x: round2(p.x), y: round2(p.y), z: round2(p.z) });
      }}
      // Ctrl+click on a Mac opens the context menu; Ctrl is the no-snap modifier here.
      onContextMenu={(e) => e.preventDefault()}
      onPointerLeave={() => {
        onCursor(null);
        setLanding(null);
        setHoveredId(null);
        setNoteHover(null);
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
        camera={{ position: [start.x, start.y, start.z], fov: FOV_DEG, near: EDITOR_NEAR, far: MAX_DISTANCE * 4 }}
      >
        <color attach="background" args={[BACKGROUND]} />
        <CameraRig cam={cam} yawKeys={yawKeys} flight={flight} walker={walker} onViewChange={onViewChange} />
        <CompassSync cam={cam} rose={rose} />
        <Lighting cam={cam} />
        {/* Walking, the view is the player's: no grid, axes, gizmo, highlights or hole ghosts (09.2). */}
        {showGrid && !walk && <Grid cam={cam} />}
        {!walk && <OriginAxes />}
        <Boxes
          boxes={[...drawn, ...expandShapes(ghosts)]}
          entityMode={entityMode}
          cuts={cuts}
          showHoles={showHoles && !walk}
          draft={draft}
          selected={walk ? NO_IDS : new Set(ghosts.length > 0 ? ghosts.map((b) => b.id) : shapesUnder(nodes, selection).map((b) => b.id))}
          hovered={walk ? NO_IDS : new Set(shapesUnder(nodes, [hoveredId, outsideHover].filter((id) => id !== null)).map((b) => b.id))}
        />
        {walk && <Avatar shapes={avatar} group={avatarGroup} />}
        {pen.points.length > 0 && <PenPreview pen={pen} kind={nextKind} fields={nextFields} line={nextLine} ramp={nextRamp} />}
        {editPoints && !walk && (
          <PointOverlay points={editPoints} y={editTop} closed={editClosed} selected={pointSel} bad={!!pointPreview?.problem} />
        )}
        {yArrow && !walk && (
          <TransformGizmo
            anchor={yArrow}
            parts={["y"]}
            boxes={[]}
            frame={{ x: yArrow.x, z: yArrow.z, width: 0, depth: 0, rotation: 0 }}
            hot={pointDrag?.mode === "y" || hotY ? "y" : null}
            cam={cam}
          />
        )}
        {gizmo && !walk && (
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
          {round2(draft.width)} × {round2(draft.depth)} m{draft.on ? ` · ${draft.on}` : ""}
        </div>
      )}
      {noteHover &&
        (() => {
          const note = onView.find((b) => b.id === noteHover.id);
          if (note?.type !== "note") return null;
          const first = note.text.split("\n")[0] || "(empty note)";
          return (
            <div className={note.status === "done" ? "draft-label note-hover done" : "draft-label note-hover"} style={{ left: noteHover.sx + 14, top: noteHover.sy + 14 }}>
              {note.label && <b>{note.label} · </b>}
              {first.length > 90 ? `${first.slice(0, 90)}…` : first}
              {note.status === "done" && " · done"}
            </div>
          );
        })()}
      {landing && !draft && (
        <div className="draft-label" style={{ left: landing.sx + 14, top: landing.sy + 14 }}>
          {landing.text}
        </div>
      )}
      {pen.points.length > 0 && pen.cursor && (
        <PenLabel pen={pen} at={onScreen({ ...pen.cursor, y: pen.cursor.y ?? pen.y })} />
      )}
      <button
        type="button"
        className="compass"
        title="Compass: north is -z. Click to turn the view north-up"
        // Not a press on the view (no marquee, no deselect).
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={() => {
          cam.current = { ...cam.current, yaw: 0 };
          invalidate();
        }}
      >
        <div ref={rose} className="rose">
          <CompassRose />
        </div>
      </button>
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
            pointDrag.label ??
            (pointDrag.mode === "points"
              ? `x ${round2(pointDrag.points[pointDrag.index].x).toFixed(2)} · z ${round2(pointDrag.points[pointDrag.index].z).toFixed(2)}`
              : pointDrag.side === "in"
                ? "in handle"
                : "out handle")}
        </div>
      )}
      {walk && (
        <WalkHud
          session={walk}
          size={viewSize}
          speed={player.speed}
          shots={shots.filter((sh) => sh.camera.kind === "walk" && sh.createdAt >= walk.startedAt).length}
          flash={walkFlash}
        />
      )}
      {walk?.phase === "paused" && !walk.relock && (
        <WalkMenu
          session={walk}
          player={player}
          onPlayer={onPlayer}
          onSession={(patch) => updateWalk(patch)}
          shots={shots.filter((sh) => sh.camera.kind === "walk" && sh.createdAt >= walk.startedAt)}
          onRemoveShot={onRemoveShot}
          onContinue={continueWalk}
          onExit={exitWalk}
        />
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
  entityMode,
  cuts,
  showHoles,
  draft,
  selected,
  hovered,
}: {
  boxes: Shape[];
  /** Editing an entity: a top-level hole is fine there (no warning). */
  entityMode: boolean;
  /** The holes that cut each shape, by its ID. */
  cuts: Map<string, ClosedShape[]>;
  /** Whether holes show as ghosts; hidden ones still show while selected or hovered. */
  showHoles: boolean;
  draft: (Footprint & Draft & { y: number }) | null;
  /** Shape IDs to highlight: in the selection (or in a selected group), and under the cursor. */
  selected: Set<string>;
  hovered: Set<string>;
}) {
  const selectedKey = [...selected].join(",");
  const hoveredKey = [...hovered].join(",");
  useEffect(() => invalidate(), [boxes, draft, selectedKey, hoveredKey]);
  return (
    <>
      {boxes.map((b) => {
        // A part of an instance lights up with it.
        const owner = ownerOf(b.id);
        const highlight = selected.has(b.id) || selected.has(owner) ? "selected" : hovered.has(b.id) || hovered.has(owner) ? "hover" : undefined;
        if (b.type === "line") return <LineMesh key={b.id} line={b} highlight={highlight} />;
        if (b.type === "note") return <NoteMesh key={b.id} note={b} highlight={highlight} />;
        // Instances arrive expanded; one here would be a bug upstream.
        if (b.type === "instance") return null;
        if (isHole(b) && !showHoles && !highlight) return null;
        return (
          <group key={b.id}>
            <ShapeMesh shape={b} highlight={highlight} cuts={cuts.get(b.id)} />
            {isHole(b) && b.parent === undefined && !entityMode && <HoleWarning hole={b} />}
          </group>
        );
      })}
      {draft && draft.width > 0 && draft.depth > 0 && (
        <ShapeMesh
          shape={{
            id: "draft",
            ...(draft.type === "cylinder" ? { type: "cylinder", sides: draft.sides } : { type: "box" }),
            kind: draft.kind,
            ...fieldsFor(draft.kind, draft),
            x: draft.x,
            z: draft.z,
            width: draft.width,
            depth: draft.depth,
            y: draft.y,
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

/** The warning over a hole that cuts nothing (it's outside any group): a small yellow diamond above its top. */
const warningGeometry = new THREE.OctahedronGeometry(0.22);
const warningMaterial = new THREE.MeshBasicMaterial({ color: "#f5c518", depthTest: false });
function HoleWarning({ hole }: { hole: ClosedShape }) {
  const b = boundsOf([hole]);
  return (
    <mesh
      geometry={warningGeometry}
      material={warningMaterial}
      position={[(b.minX + b.maxX) / 2, b.maxY + 0.45, (b.minZ + b.maxZ) / 2]}
      scale={[1, 1.6, 1]}
      renderOrder={4}
    />
  );
}

/** The Pen's outline in progress: blue, or red once it crosses itself. */
const PEN_COLOR = "#3d7be0";
const PEN_BAD_COLOR = "#d0473d";
/** Just above the ground, so the preview isn't hidden in it. */
const PEN_Y = 0.02;

/** The path the Pen would draw now: the placed points, then the cursor as the next one (unless it's closing). */
const penPath = (pen: Pen) => (pen.cursor && !pen.closing ? [...pen.points, pen.cursor] : pen.points);

/**
 * The edge from `a` to `b` as 3D points, both ends included: a line's in 3D, a free-form's at height `y` (curves
 * sampled either way).
 */
function edgePoints(a: EditPoint, b: EditPoint, y: number): Point3[] {
  if (a.y !== undefined && b.y !== undefined) return [...sampleEdge3(a as LinePoint, b as LinePoint), { x: b.x, y: b.y, z: b.z }];
  return [...sampleEdge(a, b), b].map((p) => ({ x: p.x, y, z: p.z }));
}
const at3 = (p: EditPoint, y: number): Point3 => ({ x: p.x, y: p.y ?? y, z: p.z });

/** Next to the cursor: how many points, and what finishes (Enter, a click on the first point, a double-click). */
function PenLabel({ pen, at }: { pen: Pen; at: { sx: number; sy: number } | null }) {
  if (!at) return null;
  const n = pen.points.length;
  const count = `${n} point${n === 1 ? "" : "s"}`;
  const text =
    pen.owner === "line" || pen.owner === "ramp"
      ? n >= 1
        ? `${count} · double-click or Enter to finish`
        : count
      : pen.closing
        ? "click to close"
        : n >= 3
          ? `${n} points · Enter to close`
          : count;
  const on = pen.owner === "pen" && pen.y ? ` · y ${round2(pen.y)}` : "";
  return (
    <div className="draft-label" style={{ left: at.sx + 14, top: at.sy + 14 }}>
      {text}
      {on}
    </div>
  );
}

/**
 * The Pen's (or the Line tool's) preview: the path's edges (curves sampled), each point as a square (the first one
 * bigger once a click there would close the outline), the handles of smooth points. For the Pen, once the outline
 * could close without crossing itself, a draft of the shape at its kind's default height; for the Line tool, the
 * line as it will look (its thickness, dashes and arrows).
 */
function PenPreview({ pen, kind, fields, line, ramp }: { pen: Pen; kind: ShapeKind; fields: KindFields; line: LineStyle; ramp: RampStyle }) {
  const path = penPath(pen);
  const open = pen.owner === "line" || pen.owner === "ramp";
  const bad = !open && pathCrosses(path, pen.closing);
  // The Pen's points are flat: they're drawn just above its plane (the surface its first point went on).
  const lift = (pen.y ?? 0) + PEN_Y;
  const key = JSON.stringify([path, pen.closing, lift]);

  const { lines, dots, handleDots } = useMemo(() => {
    const segments: number[] = [];
    const add = (a: Point3, b: Point3) => segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const edges = pen.closing ? path.length : path.length - 1;
    for (let i = 0; i < edges; i++) {
      const samples = edgePoints(path[i], path[(i + 1) % path.length], lift);
      for (let k = 0; k + 1 < samples.length; k++) add(samples[k], samples[k + 1]);
    }
    const handleEnds: number[] = [];
    for (const p of pen.points) {
      for (const side of ["in", "out"] as const) {
        const end = handleEnd(p, side);
        if (!end) continue;
        const e = at3(end, lift);
        add(at3(p, lift), e);
        handleEnds.push(e.x, e.y, e.z);
      }
    }
    const geometry = (values: number[]) => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    return {
      lines: geometry(segments),
      dots: geometry(pen.points.flatMap((p) => [p.x, p.y ?? lift, p.z])),
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
  const closable = !open && path.length >= 3 && outlineProblem(roundPoints(path)) === null;
  const drawable = pen.owner === "line" && path.length >= MIN_LINE_POINTS && lineProblem(roundPoints(path as LinePoint[])) === null;
  const rampDraft: Ramp | null =
    pen.owner === "ramp" && path.length >= MIN_LINE_POINTS ? { id: "ramp-draft", type: "ramp", ...ramp, points: rampPoints(path), createdBy: "human" } : null;
  const rampOk = rampDraft !== null && rampProblem(rampDraft) === null;
  const first = pen.points[0];
  return (
    <>
      {closable && (
        <ShapeMesh
          shape={{
            id: "pen",
            type: "freeform",
            kind,
            // The drawing tools never tilt (the next shape's fields are a wall, a taper and a bevel).
            ...(fieldsFor(kind, fields) as Omit<KindFields, "pitch" | "roll">),
            y: pen.y ?? 0,
            height: DEFAULT_HEIGHT[kind],
            color: DEFAULT_COLOR,
            points: roundPoints(path),
            createdBy: "human",
          }}
          draft
        />
      )}
      {rampDraft && rampOk && <ShapeMesh shape={rampDraft} draft />}
      {drawable && (
        <LineMesh line={{ id: "line-draft", type: "line", ...line, points: roundPoints(path as LinePoint[]), createdBy: "human" }} />
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
            <bufferAttribute attach="attributes-position" args={[new Float32Array([first.x, lift, first.z]), 3]} />
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
 * Point editing's overlay: the outline (a free-form's, `closed`, on its top face at `y`) or path (a line's, at its
 * points' own heights), every point as a square (hollow, or filled when selected), and each selected point's
 * handles as dots on thin stems. Drawn over everything, at a constant size on screen.
 */
function PointOverlay({
  points,
  y,
  closed,
  selected,
  bad,
}: {
  points: EditPoint[];
  y: number;
  closed: boolean;
  selected: number[];
  bad: boolean;
}) {
  const key = JSON.stringify([points, y, closed, selected]);
  const { lines, all, hollow, ends } = useMemo(() => {
    const segments: number[] = [];
    const add = (a: Point3, b: Point3) => segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const edges = closed ? points.length : points.length - 1;
    for (let i = 0; i < edges; i++) {
      const samples = edgePoints(points[i], points[(i + 1) % points.length], y);
      for (let k = 0; k + 1 < samples.length; k++) add(samples[k], samples[k + 1]);
    }
    const handleEnds: number[] = [];
    for (const i of selected) {
      const p = points[i];
      if (!p) continue;
      for (const side of ["in", "out"] as const) {
        const end = handleEnd(p, side);
        if (!end) continue;
        const e = at3(end, y);
        add(at3(p, y), e);
        handleEnds.push(e.x, e.y, e.z);
      }
    }
    const geometry = (values: number[]) => new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    return {
      lines: geometry(segments),
      all: geometry(points.flatMap((p) => [p.x, p.y ?? y, p.z])),
      hollow: geometry(points.flatMap((p, i) => (selected.includes(i) ? [] : [p.x, p.y ?? y, p.z]))),
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

/**
 * Turns the compass rose (a DOM element over the view) every frame so its N points where north (-z) is on screen,
 * measured at the focus point, so it's exact under the camera's pitch.
 */
function CompassSync({ cam, rose }: { cam: RefObject<CameraState>; rose: RefObject<HTMLDivElement | null> }) {
  const size = useThree((s) => s.size);
  useFrame(() => {
    const el = rose.current;
    const c = cam.current;
    const at = { x: c.focus.x, y: 0, z: c.focus.z };
    const a = worldToScreen(c, size, at);
    const b = worldToScreen(c, size, { ...at, z: at.z - 1 });
    if (!el || !a || !b) return;
    // Clockwise from straight up the screen.
    el.style.transform = `rotate(${(Math.atan2(b.sx - a.sx, a.sy - b.sy) * 180) / Math.PI}deg)`;
  });
  return null;
}

/** A compass card: a red needle and N to the north, E / S / W around it. */
function CompassRose() {
  return (
    <svg viewBox="-30 -30 60 60" width="60" height="60" aria-hidden>
      <circle r="27" className="rim" />
      <path d="M0 -17 L5 0 L-5 0 Z" className="needle-n" />
      <path d="M0 17 L5 0 L-5 0 Z" className="needle-s" />
      <text y="-19" className="n">N</text>
      <text x="21" className="dir">E</text>
      <text y="21" className="dir">S</text>
      <text x="-21" className="dir">W</text>
    </svg>
  );
}

/**
 * A camera flight to frame `bounds` (or to a camera, `to`): planned on its first frame (`from`, `to`, `start`), then
 * eased along. `last` is the camera it set, so a pan, zoom or turn in between (a new camera) ends it.
 */
type Flight = { bounds?: Box3; from?: CameraState; to?: CameraState; start?: number; last?: CameraState };

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** How long the camera takes to fly down into a walk, and back out (09.2). */
const WALK_FLIGHT_MS = 600;
/** How often a walk's pose goes to the server (for the agent's `view.walking`). */
const WALK_REPORT_MS = 250;
const DOWN = new THREE.Vector3(0, -1, 0);
/** The camera's near clipping plane in the editor, and while walking (walls come close). */
const EDITOR_NEAR = 0.5;
const WALK_NEAR = 0.05;
/** A walk's frame, run by the rig while one is under way (see the Viewport). */
type WalkDriver = { active(): boolean; step(camera: THREE.Camera, scene: THREE.Scene, size: Size, delta: number): void };
/** The editor camera as a camera pose (a walk's flights start or end there). */
const editorPose = (c: CameraState): CameraPose => ({ position: cameraPosition(c), target: { x: c.focus.x, y: 0, z: c.focus.z }, vfov: FOV_DEG });
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: WalkVec3, b: WalkVec3, t: number) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t) });
/** Between two camera poses (the target along, so the look turns smoothly). */
const blendPose = (a: CameraPose, b: CameraPose, t: number): CameraPose => {
  // Blend where each looks at 10 m ahead, not the targets 1 m ahead, so a flight doesn't swing the view.
  const far = (c: CameraPose) => {
    const d = { x: c.target.x - c.position.x, y: c.target.y - c.position.y, z: c.target.z - c.position.z };
    const n = Math.hypot(d.x, d.y, d.z) || 1;
    return { x: c.position.x + (d.x / n) * 10, y: c.position.y + (d.y / n) * 10, z: c.position.z + (d.z / n) * 10 };
  };
  return { position: mix3(a.position, b.position, t), target: mix3(far(a), far(b), t), vfov: mix(a.vfov, b.vfov, t) };
};
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Applies the camera state to the three.js camera every frame, integrates yaw, flies to what's framed and reports the view. */
function CameraRig({
  cam,
  yawKeys,
  flight,
  walker,
  onViewChange,
}: {
  cam: RefObject<CameraState>;
  yawKeys: RefObject<Set<YawKey>>;
  flight: RefObject<Flight | null>;
  walker: RefObject<WalkDriver | null>;
  onViewChange: (view: View, camera: CameraState) => void;
}) {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const lastReport = useRef({ key: "", at: 0 });

  useFrame((_, delta) => {
    // A walk moves the camera itself (09.2).
    if (walker.current?.active()) return walker.current.step(camera, scene, size, delta);
    // Back from a walk (its field of view and clipping plane are the walker's).
    if (camera instanceof THREE.PerspectiveCamera && (camera.fov !== FOV_DEG || camera.near !== EDITOR_NEAR)) {
      camera.fov = FOV_DEG;
      camera.near = EDITOR_NEAR;
      camera.updateProjectionMatrix();
    }
    const keys = yawKeys.current;
    const dir = (keys.has("right") ? 1 : 0) - (keys.has("left") ? 1 : 0);
    if (dir !== 0) {
      // Clamp: the first frame after an idle period (frameloop="demand") reports a huge delta.
      cam.current = rotateBy(cam.current, dir * YAW_SPEED_DEG * Math.min(delta, 0.05));
      invalidate();
    }

    const f = flight.current;
    if (f && f.last && cam.current !== f.last) flight.current = null;
    else if (f) {
      const now = performance.now();
      if (f.start === undefined) Object.assign(f, { from: cam.current, to: f.to ?? framedCamera(cam.current, size, f.bounds!), start: now });
      const t = reducedMotion() ? 1 : Math.min(1, (now - f.start!) / FLIGHT_MS);
      cam.current = t >= 1 ? f.to! : lerpCamera(f.from!, f.to!, easeInOut(t));
      f.last = cam.current;
      if (t >= 1) flight.current = null;
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

import { TerrainPanel } from "./TerrainPanel";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { ArrowLeft, BookOpen, ChevronDown, Map as MapIcon, Package, Upload } from "lucide-react";
import {
  DEFAULT_COLOR,
  DEFAULT_LINE_COLOR,
  DEFAULT_NOTE_COLOR,
  DEFAULT_THICKNESS,
  DEFAULT_VIEW,
  DEFAULT_RAMP_WIDTH,
  DEFAULT_WALL,
  MIN_ARRAY_SPACING,
  type ArrayLayout,
  type ArrayLayoutType,
  type ArrayNode,
  type Follow,
  type Box,
  type ClosedShape,
  type Cylinder,
  type Instance,
  type Line,
  type LinePoint,
  type Ramp,
  type Shape,
  type ShapeColor,
  type ShapeKind,
  type ShapePatch,
  type ShapeInput,
  type SceneNode,
  type View,
  type PlayerCamera,
  type ShotCamera,
  type WalkPreset,
  type ClientMessage,
} from "../shared/scene.types";
import { boundsOf, footprintBounds, isClosed, isTilted, polyline, rampStations, reversePoints, round2, wallOf } from "../shared/geometry";
import { shapesUnder, childrenOf, countsText, isShape, isGroup, hiddenIds, lockedIds, subtreeIds, tagsOf } from "../shared/tree";
import { definitionOf, expandShapes } from "../shared/entities";
import { arrayItems, arrayLayout, arrayShortfall, defaultFollowOffset, describeLayout, facingOf, isFollowing, layoutAnchor } from "../shared/arrays";
import type { Box3, CameraState } from "./camera";
import { clipboardText, readClipboard } from "./clipboard";
import { ErrorPanel } from "./ErrorPanel";
import { LibraryPanel } from "./Library";
import { EntitiesPanel } from "./EntitiesPanel";
import { currentTags, entityMeta, type Library } from "../shared/library";
import { reportError } from "./errors";
import { Inspector, type InspectorProps } from "./Inspector";
import { highlightedText, typingInField } from "./keys";
import { Outliner } from "./Outliner";
import { ProjectPicker, Welcome } from "./ProjectPicker";
import { ContextualBar, EDIT_ARRAY_HINT, EDIT_POINTS_HINT, HINTS, TOOLS, ToolBar, ViewBar, WalkBar } from "./ToolBar";
import { useScene, type RenderHandler } from "./useScene";
import { AgentChip } from "./AgentChip";
import { ExportDialog } from "./ExportDialog";
import { Viewport, type CursorPoint, type KindFields, type LineStyle, type RampStyle, type Tool, type ViewportApi } from "./Viewport";
import { blobToBase64 } from "./capture";
import { ShotsPanel, ShutterFlash } from "./ShotsPanel";
import { Wordmark } from "../ui/Wordmark";

/** Fixed-width number (e.g. "  12.50", " -3.00") so the info-label never jitters. */
const coord = (n?: number) => (n === undefined ? "–".padStart(7) : n.toFixed(2).padStart(7));


/** How long a one-off message (like Alt+J's "Alt-drag a copy first") replaces the tool hint. */
const NOTICE_MS = 2500;

/**
 * What to select once the server's next scene arrives: the nodes it added, as chosen by `pick`. `before` holds
 * every node ID from when the edit was sent.
 */
type PendingSelect = { before: Set<string>; pick: (added: SceneNode[], nodes: SceneNode[]) => string[] };

/** The copies' roots among newly added nodes: a copy keeps its original's parent, so it's the ones whose parent is old. */
const copiedRoots = (added: SceneNode[]) => {
  const ids = new Set(added.map((n) => n.id));
  return added.filter((n) => n.parent === undefined || !ids.has(n.parent)).map((n) => n.id);
};

/** An entity's width (its definition's extent along x), or 1 with no shapes: a new layout's spacing comes from it. */
const entityWidth = (id: string) => {
  const shapes = (definitionOf(id) ?? []).filter(isShape);
  if (shapes.length === 0) return 1;
  const b = boundsOf(shapes);
  return b.maxX - b.minX || 1;
};

/**
 * A new layout of `type` for an array, around where its first item is (plan 10 §4), sized from its entity: a path
 * of 4 items along the item's facing, a circle of 8 with the item on it (at start 0, east of the center), or a 3 × 3
 * grid with the item at its first corner. With the facing that layout starts with.
 */
function layoutAround(a: ArrayNode, type: ArrayLayoutType): { layout: ArrayLayout; facing: ArrayNode["facing"] } {
  const first = arrayItems(a)[0] ?? { ...layoutAnchor(a.layout), rotation: 0 };
  const s = Math.max(MIN_ARRAY_SPACING, round2(entityWidth(a.entities[0].entity) * 1.5));
  const { x, y, z } = first;
  if (type === "path") {
    const r = (first.rotation * Math.PI) / 180;
    return {
      layout: { type, points: [{ x, y, z }, { x: round2(x + Math.cos(r) * s * 3), y, z: round2(z - Math.sin(r) * s * 3) }], place: "spacing", spacing: s },
      facing: "along",
    };
  }
  if (type === "circle") {
    const radius = Math.max(1, round2((8 * s) / (2 * Math.PI)));
    return { layout: { type, x: round2(x - radius), y, z, radius, count: 8 }, facing: "tangent" };
  }
  if (type === "scatter") {
    // 20 items in a circle around the first one, turned anyhow.
    return { layout: { type, x, y, z, radius: Math.max(2, round2(s * 4)), count: 20 }, facing: "random" };
  }
  return { layout: { type: "grid", x: round2(x + s), y, z: round2(z + s), columns: 3, rows: 3, spacing: { x: s, z: s } }, facing: "fixed" };
}

/** `lobby (group_1)` or just `box_3`. */
const title = (n: SceneNode) => (n.name ? `${n.name} (${n.id})` : n.id);

/**
 * A shape's numbers, for the inspector (its title is the header): `6 × 4 × 3 m · wall 0.2 · y 0 · 0°` (a room's
 * wall thickness, or a volume's taper and bevel: `20 × 20 × 8 m · smooth · taper 0.6 · bevel 0.5 · y 0 · 0°`), a
 * cylinder's sides: `8 × 8 × 3 m · 8 sides · y 0 · 0°`, a free-form's points and bounds:
 * `7 points · 12.3 × 8 × 3 m · y 0`, and a line's points, length and style:
 * `3 points · 14.2 m long · 3 px · dashed · arrow at the end`.
 */
const details = (s: Shape, library: Library | null) => {
  if (s.type === "array") {
    const { items } = arrayLayout(s);
    const names = s.entities.map((e) => (library ? entityMeta(library, e.entity)?.name : undefined) ?? `missing entity ${e.entity}`).join(", ");
    const b = boundsOf([s]);
    const size = `${round2(b.maxX - b.minX)} × ${round2(b.maxZ - b.minZ)} × ${round2(b.maxY - b.minY)} m`;
    const skipped = s.skip?.length ? ` · ${s.skip.length} skipped` : "";
    return `${items.length} × ${names}${skipped} · ${describeLayout(s.layout)} · ${size}`;
  }
  if (s.type === "instance") {
    const meta = library ? entityMeta(library, s.entity) : undefined;
    const b = boundsOf([s]);
    const tags = library && meta ? currentTags(library, meta.tags).map((t) => ` · #${t}`).join("") : "";
    const size = `${round2(b.maxX - b.minX)} × ${round2(b.maxZ - b.minZ)} × ${round2(b.maxY - b.minY)} m`;
    return `${meta ? meta.name : `missing entity ${s.entity}`} · ${size} · y ${s.y} · ${s.rotation}°${tags}`;
  }
  if (s.type === "terrain") return `${s.width} × ${s.depth} m · base ${s.y} · ${s.resolution} samples`;
  if (s.type === "note") return `note${s.label ? ` · ${s.label}` : ""} · ${s.status} · by ${s.createdBy} · y ${s.y}`;
  if (s.type === "line") {
    const path = polyline(s);
    const length = path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y, p.z - path[i].z), 0);
    const arrow = s.arrow === "end" ? " · arrow at the end" : s.arrow === "both" ? " · arrows at both ends" : "";
    return `${s.points.length} points · ${round2(length)} m long · ${s.thickness} px${s.dashed ? " · dashed" : ""}${arrow}`;
  }
  if (s.type === "ramp") {
    const stations = rampStations(s);
    const ys = s.points.map((p) => p.y);
    const rise = round2(Math.max(...ys) - Math.min(...ys));
    const steps = s.step === undefined ? 0 : s.points.slice(1).reduce((n, p, i) => n + (p.y === s.points[i].y ? 0 : Math.max(1, Math.round(Math.abs(p.y - s.points[i].y) / s.step!))), 0);
    const how = s.step === undefined ? "smooth" : `${steps} steps of ${s.step}`;
    return `${s.points.length} points · ${round2(stations.at(-1)!.s)} m long · ${s.width} m wide · rises ${rise} m · ${how} · ${s.base}`;
  }
  const wall =
    s.kind === "room"
      ? ` · wall ${wallOf(s)}`
      : `${s.taper !== undefined ? ` · taper ${s.taper}` : ""}${s.bevel !== undefined ? ` · bevel ${s.bevel}` : ""}`;
  if (s.type === "freeform") {
    const b = footprintBounds(s);
    return `${s.points.length} points · ${round2(b.maxX - b.minX)} × ${round2(b.maxZ - b.minZ)} × ${s.height} m${wall} · y ${s.y}`;
  }
  const sides = s.type === "cylinder" ? (s.sides !== undefined ? ` · ${s.sides} sides` : " · smooth") : "";
  const tilt = `${s.pitch ? ` · pitch ${s.pitch}°` : ""}${s.roll ? ` · roll ${s.roll}°` : ""}`;
  return `${s.width} × ${s.depth} × ${s.height} m${sides}${wall}${tilt} · y ${s.y} · ${s.rotation}°`;
};

/** localStorage key: whether the Library panel is open. */
const LIBRARY_OPEN_KEY = "dd.library.open";
/** localStorage key: whether the Shots panel is open (09.1). */
const SHOTS_OPEN_KEY = "dd.shots.open";
/** localStorage key: whether the stats readout shows (10.5). */
const STATS_KEY = "dd.stats";
/** localStorage key: the Walk tool's preset (09.2). */
const WALK_PRESET_KEY = "dd.walk.preset";
/** localStorage key prefix: the view bar's toggles (holes, grid, notes, lines, the 3D cursor; 14.1). */
const VIEW_TOGGLE_KEY = "dd.view.";

/** A view bar toggle, remembered per viewer (a convenience: it works without storage). */
function useViewToggle(name: string, initial = true): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      const stored = localStorage.getItem(VIEW_TOGGLE_KEY + name);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(VIEW_TOGGLE_KEY + name, next ? "1" : "0");
    } catch {
      // A convenience only.
    }
  };
  return [on, set];
}

/** How long the pointer rests before the agent is told where (14.1, `view.pointer`). */
const POINTER_REST_MS = 300;
/** The player camera is saved this long after the pause menu's last change (a slider sends many). */
const PLAYER_SAVE_MS = 400;

/**
 * What a node is linked to (13.4), for the inspector's Linked rows: what an instance or array stands on, the stops a
 * line goes through. Unlink keeps what it has now (its height, its points).
 */
function linksOf(node: SceneNode | null | undefined, nodes: SceneNode[], send: (msg: ClientMessage) => void): InspectorProps["links"] {
  const name = (id: string) => {
    const n = nodes.find((m) => m.id === id);
    return n?.name ? `${n.name} (${id})` : id;
  };
  if ((node?.type === "instance" || node?.type === "array") && node.on) {
    const onId = node.on.id;
    return [
      {
        label: "on",
        value: name(onId),
        title: `It stands on ${onId}'s walking surface${node.type === "array" ? " (item by item on an array)" : ""}, and moves up and down with it`,
        unlinkTitle: "Unlink: keep the height it has now (it stops standing on it)",
        onUnlink: () => send({ type: "update_nodes", changes: [{ id: node.id, on: null }] }),
      },
    ];
  }
  if (node?.type === "line" && node.through) {
    const { stops, style } = node.through;
    return [
      {
        label: "through",
        value: `${stops.length} stop${stops.length === 1 ? "" : "s"}${style === "jumps" ? ", as jumps" : ""}`,
        title: `Its points come from ${stops.join(", ")}: it follows them when they move`,
        unlinkTitle: "Unlink: keep the points it has now (editing them unlinks it too)",
        onUnlink: () => send({ type: "update_nodes", changes: [{ id: node.id, through: null }] }),
      },
    ];
  }
  return undefined;
}

export function App() {
  // The agent's renders are drawn by the view (09.3).
  const renderer = useRef<RenderHandler | null>(null);
  const { scene, history, seq, shots, player: savedPlayer, agent, exportStatus, projects, open, restore, library: libraryState, connected, error, clearError, send } =
    useScene(renderer);
  const library = libraryState.library;
  // The Library panel, open or not, remembered per viewer.
  const [libraryOpen, setLibraryOpenState] = useState(() => {
    try {
      return localStorage.getItem(LIBRARY_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setLibraryOpen = (on: boolean) => {
    setLibraryOpenState(on);
    try {
      localStorage.setItem(LIBRARY_OPEN_KEY, on ? "1" : "0");
    } catch {
      // A convenience only.
    }
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  // The Export to Unity dialog (15.2).
  const [exportOpen, setExportOpen] = useState(false);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [camera, setCamera] = useState<CameraState | null>(null);
  const [cursor, setCursor] = useState<CursorPoint | null>(null);
  // Where the pointer last rested (14.1), for the agent's `view.pointer`: the cursor once it's been still a moment.
  const [pointer, setPointer] = useState<CursorPoint | null>(null);
  useEffect(() => {
    if (!cursor) return;
    const t = setTimeout(() => setPointer(cursor), POINTER_REST_MS);
    return () => clearTimeout(t);
  }, [cursor]);
  const [tool, setTool] = useState<Tool>("select");
  // Notes belong in scenes: the Note tool is off while an entity is open.
  const chooseTool = (t: Tool) => {
    if (t === "note" && state.current.open?.entity) return setNotice("Notes go in scenes, not in an entity");
    setTool(t);
  };
  // Holding Space switches to the hand for as long as it's held.
  const [spaceHand, setSpaceHand] = useState(false);
  // Node IDs (boxes and groups), at the level of `context`.
  const [selection, setSelection] = useState<string[]>([]);
  // The group entered with a double-click (null = the top level).
  const [context, setContext] = useState<string | null>(null);
  // The free-form in point editing (entered by double-clicking it, or its Edit points button).
  const [editing, setEditing] = useState<string | null>(null);
  // The node under the cursor in the outliner, highlighted in the view.
  const [outlinerHover, setOutlinerHover] = useState<string | null>(null);
  // The next shape's style in the Box, Cylinder and Pen tools, remembered while the tab is open.
  const [nextKind, setNextKind] = useState<ShapeKind>("room");
  const [nextColor, setNextColor] = useState<ShapeColor>(DEFAULT_COLOR);
  // The Cylinder tool's sides (undefined = smooth).
  const [nextSides, setNextSides] = useState<number | undefined>(undefined);
  // The next shape's kind-specific fields: a room's wall thickness, a volume's taper and bevel (missing = the default).
  const [nextFields, setNextFields] = useState<KindFields>({});
  // The Line tool's next line: its own color (black by default: a near-white line vanishes on the ground) and style.
  const [nextLine, setNextLine] = useState<LineStyle>({ color: DEFAULT_LINE_COLOR, thickness: DEFAULT_THICKNESS, dashed: false, arrow: "none" });
  // After Cmd+G or a copy: what to select when the result arrives (the new group, the copies).
  const pendingSelect = useRef<PendingSelect | null>(null);
  // The last Alt-drag copy's offset (world axes), which Alt+J repeats. Forgotten when the scene changes.
  const lastCopy = useRef<{ dx: number; dy: number; dz: number } | null>(null);
  // The Ramp tool's next ramp.
  const [nextRamp, setNextRamp] = useState<RampStyle>({ kind: "volume", width: DEFAULT_RAMP_WIDTH, base: "solid", color: DEFAULT_COLOR });
  // The view bar: whether holes show as ghosts (off: only what they cut away shows), and the grid.
  const [showModifiers, setShowModifiers] = useState(true);
  const [showHoles, setShowHoles] = useViewToggle("holes");
  const [showNotes, setShowNotes] = useViewToggle("notes");
  const [showLines, setShowLines] = useViewToggle("lines");
  const [showCursor, setShowCursor] = useViewToggle("cursor");
  // The stats readout (10.5), remembered per viewer.
  const [showStats, setShowStatsState] = useState(() => {
    try {
      return localStorage.getItem(STATS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setShowStats = (on: boolean) => {
    setShowStatsState(on);
    try {
      localStorage.setItem(STATS_KEY, on ? "1" : "0");
    } catch {
      // A convenience only.
    }
  };
  // An entity being placed from the Library: the next click in the view puts an instance there.
  const [placing, setPlacing] = useState<string | null>(null);
  // The array whose target the next click in the view picks (10.3: Follow), or null.
  const [followPick, setFollowPick] = useState<string | null>(null);
  // What the camera flies to frame (double-clicking an outliner row's icon): a new object each time.
  const [cameraFrame, setCameraFrame] = useState<{ bounds: Box3 } | { camera: CameraState } | null>(null);
  // The Note tool's next color, and the note it just placed (its text field takes the focus once it's selected).
  const [nextNoteColor, setNextNoteColor] = useState<ShapeColor>(DEFAULT_NOTE_COLOR);
  const [freshNote, setFreshNote] = useState<string | null>(null);
  const [showGrid, setShowGrid] = useViewToggle("grid");
  // Isolation: only this node and what's in it show, plus anything new since it started (`before`: the IDs then),
  // so what's drawn or pasted meanwhile doesn't vanish. For this tab only; not an edit.
  const [isolation, setIsolation] = useState<{ id: string; before: Set<string> } | null>(null);
  // The inspector's sliders while held: their values on the shapes, before they're sent. Cleared when the next scene
  // (the sent value) arrives, when the selection changes, and on an error.
  const [preview, setPreview] = useState<Record<string, ShapePatch> | null>(null);
  // A one-off message in the info-label, in place of the tool hint.
  const [notice, setNotice] = useState<string | null>(null);
  // Shots (09.1): what the view can capture, the Shots panel (remembered per viewer), and the shutter's flash.
  const viewportApi = useRef<ViewportApi | null>(null);
  renderer.current = (job) => {
    const api = viewportApi.current;
    return api ? api.render(job) : Promise.reject(new Error("The editor's view isn't up yet."));
  };
  const [shotsOpen, setShotsOpenState] = useState(() => {
    try {
      return localStorage.getItem(SHOTS_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setShotsOpen = (on: boolean) => {
    setShotsOpenState(on);
    try {
      localStorage.setItem(SHOTS_OPEN_KEY, on ? "1" : "0");
    } catch {
      // A convenience only.
    }
  };
  const [flash, setFlash] = useState(0);
  const shooting = useRef(false);
  /** Takes a shot of the view as framed: a clean capture, saved by the server into the open document. */
  const shutter = async () => {
    const api = viewportApi.current;
    if (!api || !state.current.open || shooting.current) return;
    shooting.current = true;
    setFlash((f) => f + 1);
    try {
      const shot = await api.capture({ notes: true, lines: true });
      send({ type: "add_shot", camera: { kind: "editor", ...shot.camera }, width: shot.width, height: shot.height, image: await blobToBase64(shot.png) });
      if (!shotsOpen) setShotsOpen(true);
    } catch (err) {
      setNotice("The shot wasn't taken");
      reportError("view", err);
    } finally {
      shooting.current = false;
    }
  };
  const shutterRef = useRef(shutter);
  shutterRef.current = shutter;

  // The Walk tool (09.2): the preset the next walk starts with (per viewer), whether a walk is under way (the
  // panels hide), and the player camera: shown as changed at once, saved a moment after the last change.
  const [walkPreset, setWalkPresetState] = useState<WalkPreset>(() => {
    try {
      return localStorage.getItem(WALK_PRESET_KEY) === "third" ? "third" : "first";
    } catch {
      return "first";
    }
  });
  const setWalkPreset = (p: WalkPreset) => {
    setWalkPresetState(p);
    try {
      localStorage.setItem(WALK_PRESET_KEY, p);
    } catch {
      // A convenience only.
    }
  };
  const [walking, setWalking] = useState(false);
  const [pendingPlayer, setPendingPlayer] = useState<PlayerCamera | null>(null);
  const playerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const player = pendingPlayer ?? savedPlayer;
  const changePlayer = (next: PlayerCamera) => {
    setPendingPlayer(next);
    if (playerTimer.current) clearTimeout(playerTimer.current);
    playerTimer.current = setTimeout(() => {
      playerTimer.current = null;
      send({ type: "set_player", player: next });
    }, PLAYER_SAVE_MS);
  };
  // The server's copy caught up (or another tab changed it): show that.
  useEffect(() => {
    if (!playerTimer.current) setPendingPlayer(null);
  }, [savedPlayer]);
  const saveWalkShot = async (shot: { png: Blob; width: number; height: number; camera: ShotCamera }) => {
    try {
      send({ type: "add_shot", camera: shot.camera, width: shot.width, height: shot.height, image: await blobToBase64(shot.png) });
    } catch (err) {
      setNotice("The shot wasn't saved");
      reportError("view", err);
    }
  };

  const nodes = scene?.nodes ?? [];
  const isolated = isolation?.id ?? null;
  const isolatedNode = isolated !== null ? nodes.find((n) => n.id === isolated) : undefined;
  // What the view shows (null = everything): not what's hidden, and while isolated only the isolation.
  const visible = useMemo(() => {
    const hidden = hiddenIds(nodes);
    if (!isolation && hidden.size === 0) return null;
    const inside = isolation ? subtreeIds(nodes, isolation.id) : null;
    const isolatedIn = (id: string) => !isolation || inside!.has(id) || !isolation.before.has(id);
    return new Set(nodes.filter((n) => !hidden.has(n.id) && isolatedIn(n.id)).map((n) => n.id));
  }, [nodes, isolation]);
  // The key handler is installed once; it reads the current state from here.
  // Picking a target ends when its array is no longer the one selected.
  useEffect(() => {
    if (followPick && !(selection.length === 1 && selection[0] === followPick)) setFollowPick(null);
  }, [followPick, selection]);
  const state = useRef({ nodes, selection, context, open, pickerOpen: pickerOpen || exportOpen, view, visible, isolated, placing, followPick });
  state.current = { nodes, selection, context, open, pickerOpen: pickerOpen || exportOpen, view, visible, isolated, placing, followPick };

  /** Isolates a node (null ends it). Isolating a group enters it, so what's drawn next goes in it. */
  const isolate = useCallback(
    (id: string | null) => {
      const all = state.current.nodes;
      const node = id === null ? undefined : all.find((n) => n.id === id);
      if (!node) {
        setIsolation(null);
        return;
      }
      setIsolation({ id: node.id, before: new Set(all.map((n) => n.id)) });
      if (isGroup(node)) {
        setContext(node.id);
        setSelection((sel) => sel.filter((s) => s !== node.id));
      }
    },
    [],
  );
  // An isolated node that's gone (deleted, undone, another scene) ends the isolation.
  useEffect(() => {
    if (isolation && !nodes.some((n) => n.id === isolation.id)) setIsolation(null);
  }, [nodes, isolation]);

  const activeTool: Tool = spaceHand ? "hand" : tool;
  const boxes = nodes.filter(isShape);
  const selectedNodes = nodes.filter((n) => selection.includes(n.id));
  const selectedShapes = shapesUnder(nodes, selection);

  // A scene opened (here, in another tab, or when this tab connected): close the picker, drop the local state that
  // belonged to the old scene, and restore the scene's selection (the Viewport restores its camera). A rename
  // doesn't send `restore`, so it changes nothing here.
  const sceneKey = open ? `${open.project.id}/${open.scene.id}${open.entity ? `/${open.entity.id}` : ""}` : "";
  // Edit entity mode (08.5): the entity whose definition is open, instead of the scene.
  const editingEntity = open?.entity ?? null;
  useEffect(() => {
    if (!restore) return;
    setPickerOpen(false);
    setSelection(restore.selection);
    setContext(null);
    setIsolation(null);
    setPlacing(null);
    setEditing(null);
    setOutlinerHover(null);
    pendingSelect.current = null;
    lastCopy.current = null;
  }, [restore]);

  // Point editing lasts while its free-form is the whole selection, in the Select tool.
  useEffect(() => {
    if (editing !== null && (selection.length !== 1 || selection[0] !== editing)) setEditing(null);
  }, [editing, selection]);
  useEffect(() => setEditing(null), [tool]);

  useEffect(() => setPreview(null), [scene, selection, error]);

  // Errors from the server go to the error log too, since the dock only shows the latest one until the next scene.
  useEffect(() => {
    if (error) reportError("server", error);
  }, [error]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  /** Copies nodes by an offset (one step) and selects the copies when they arrive. */
  const duplicate = useCallback(
    (ids: string[], offset: { dx: number; dy: number; dz: number }) => {
      pendingSelect.current = { before: new Set(state.current.nodes.map((n) => n.id)), pick: copiedRoots };
      send({ type: "duplicate_nodes", ids, ...offset });
    },
    [send],
  );

  // The tab's title follows the open scene.
  useEffect(() => {
    document.title = open ? `${open.scene.name} — ${open.project.name} · OrlaBlocks` : "OrlaBlocks";
  }, [open]);

  // Tell the server what's visible so the agent's get_scene knows where to draw, and where the camera is, so the
  // scene reopens there.
  useEffect(() => {
    if (connected && camera) send({ type: "set_view", view: { ...view, ...(isolated ? { isolated } : {}), ...(pointer ? { pointer } : {}) }, camera });
  }, [connected, view, camera, send, isolated, pointer]);

  // Tell the server what's selected so the agent knows what "this" means. The last tab to change it wins.
  const selectionKey = selection.join(",");
  useEffect(() => {
    if (connected) send({ type: "set_selection", ids: selectionKey ? selectionKey.split(",") : [] });
  }, [connected, selectionKey, send]);

  // A new scene: drop selected nodes that went away (undo, Clear, the agent, another tab), leave an entered group
  // that went away, and select what Cmd+G or a copy just made.
  useEffect(() => {
    if (!scene) return;
    const ids = new Set(scene.nodes.map((n) => n.id));
    setSelection((sel) => (sel.every((id) => ids.has(id)) ? sel : sel.filter((id) => ids.has(id))));
    setContext((c) => (c !== null && !ids.has(c) ? null : c));
    const pending = pendingSelect.current;
    if (pending) {
      const made = pending.pick(scene.nodes.filter((n) => !pending.before.has(n.id)), scene.nodes);
      if (made.length > 0) {
        pendingSelect.current = null;
        setSelection(made);
      }
    }
  }, [scene]);

  // V / H / B pick a tool, Space holds the hand. Shift+X / Shift+Z mirror the selection on that world axis. Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes.
  // Cmd/Ctrl+A selects everything at the current level, Cmd/Ctrl+G groups the selection, Cmd/Ctrl+Shift+G ungroups
  // it, Delete / Backspace removes it, Esc deselects and leaves an entered group.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (typingInField(e)) return;
      // The Library panel has its own undo, and keys there are its own.
      if (e.target instanceof HTMLElement && e.target.closest(".library-panel")) return;
      const key = e.key.toLowerCase();
      const { nodes, selection, context, open, pickerOpen, visible, isolated } = state.current;
      // Nothing to edit while the picker is up (and while nothing is open, it always is).
      if (!open || pickerOpen) return;
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
      if (mod && (key === "z" || key === "y")) {
        e.preventDefault();
        send({ type: key === "y" || e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod && !e.shiftKey && key === "a") {
        e.preventDefault();
        // Not what's locked or hidden by the isolation.
        const locked = lockedIds(nodes);
        setSelection(childrenOf(nodes, context ?? undefined).filter((n) => !locked.has(n.id) && (!visible || visible.has(n.id))).map((n) => n.id));
        return;
      }
      if (mod && key === "g") {
        e.preventDefault();
        if (selection.length === 0) return;
        if (!e.shiftKey) {
          const grouped = selection;
          pendingSelect.current = {
            before: new Set(nodes.map((n) => n.id)),
            // The new group that holds the grouped nodes.
            pick: (added, next) =>
              added
                .filter((n) => isGroup(n) && next.some((c) => c.parent === n.id && grouped.includes(c.id)))
                .slice(0, 1)
                .map((n) => n.id),
          };
          send({ type: "group_nodes", ids: selection });
          return;
        }
        const groupIds = selection.filter((id) => nodes.some((n) => n.id === id && isGroup(n)));
        if (groupIds.length === 0) return;
        // Their contents take their place in the selection.
        const freed = nodes.filter((n) => n.parent !== undefined && groupIds.includes(n.parent)).map((n) => n.id);
        send({ type: "ungroup", ids: groupIds });
        setSelection([...selection.filter((id) => !groupIds.includes(id)), ...freed]);
        return;
      }
      if (e.key === " ") {
        // Also keeps a focused button from being pressed by Space.
        e.preventDefault();
        if (!e.repeat) setSpaceHand(true);
        return;
      }
      // Alt+J repeats the last copy's offset on the current selection. Matched on the code: on a Mac, Alt+J types ∆.
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyJ") {
        e.preventDefault();
        if (lastCopy.current && selection.length > 0) duplicate(selection, lastCopy.current);
        else setNotice("Alt-drag a copy first");
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.shiftKey && (key === "x" || key === "z")) {
        if (selection.length > 0) send({ type: "mirror_nodes", ids: selection, axis: key });
        return;
      }
      if (e.key === "Escape" && state.current.placing) {
        setPlacing(null);
        return;
      }
      if (e.key === "Escape" && state.current.followPick) {
        setFollowPick(null);
        return;
      }
      // In Edit entity mode, Esc with nothing selected (and nothing isolated) goes back to the scene.
      if (e.key === "Escape" && state.current.open?.entity && selection.length === 0 && !isolated && context === null) {
        send({ type: "close_entity" });
        return;
      }
      if (e.key === "Escape") {
        // While isolated, Esc deselects first (staying in the isolated group), then ends the isolation.
        if (isolated && selection.length > 0) setSelection([]);
        else {
          setSelection([]);
          setContext(null);
          if (isolated) isolate(null);
        }
      }
      // I isolates the single selected node, or ends the isolation.
      if (key === "i") {
        if (selection.length === 1 && selection[0] !== isolated) isolate(selection[0]);
        else if (isolated) isolate(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection.length > 0) {
        e.preventDefault();
        send({ type: "remove_nodes", ids: selection });
      }
      if (key === "k") {
        void shutterRef.current();
        return;
      }
      const match = TOOLS.find((t) => t.key === key);
      if (match) chooseTool(match.tool);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || typingInField(e)) return;
      e.preventDefault();
      setSpaceHand(false);
    };
    const onBlur = () => setSpaceHand(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [send, duplicate]);

  // Cmd/Ctrl+C / X / V through the browser's copy, cut and paste events (no permission prompt), with the system
  // clipboard, so they work across scenes, tabs and reloads. Off while typing in a field (normal text copy and
  // paste) and while the picker is up. Paste lands centered in the view, inside the entered group if there is one.
  useEffect(() => {
    const ours = (e: ClipboardEvent) => {
      const { open, pickerOpen } = state.current;
      return !typingInField(e) && !!open && !pickerOpen;
    };
    const onCopy = (e: ClipboardEvent) => {
      const { nodes, selection } = state.current;
      if (!ours(e) || selection.length === 0 || !e.clipboardData || highlightedText()) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", clipboardText(nodes, selection));
      if (e.type === "cut") send({ type: "remove_nodes", ids: selection, cut: true });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!ours(e)) return;
      const pasted = readClipboard(e.clipboardData?.getData("text/plain"));
      if (!pasted) return;
      e.preventDefault();
      const { nodes, context, view } = state.current;
      pendingSelect.current = { before: new Set(nodes.map((n) => n.id)), pick: copiedRoots };
      send({ type: "paste_nodes", nodes: pasted, focus: view.focus, parent: context });
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [send]);

  /** A path array's follow controls (10.3): what it follows (or null), picking a target in the view, At, Offset and Unlink. */
  const followControls = (along: Follow | undefined, id: string, update: (change: Record<string, unknown>) => void) => {
    const target = along ? nodes.find((n) => n.id === along.id) : undefined;
    const shape = target && isShape(target) ? target : undefined;
    return {
      along: along ? { id: along.id, name: target?.name, closed: !!shape && isClosed(shape), at: along.at ?? ("top" as const), offset: along.offset ?? (shape ? defaultFollowOffset(shape) : 0) } : null,
      picking: followPick === id,
      onPick: () => setFollowPick(followPick === id ? null : id),
      onChange: (patch: { at?: "top" | "bottom"; offset?: number }) => update({ layout: { along: patch } }),
      onUnlink: () => update({ layout: { along: null } }),
    };
  };

  // Kind and sides are for a single shape; color applies to every shape in the selection (groups included).
  const single = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const singleShape = single && isShape(single) ? single : null;
  // Instances have no color of their own (their shapes are the entity's).
  const colored = selectedShapes.filter((b): b is Exclude<Shape, Instance | ArrayNode> => b.type !== "instance" && b.type !== "array");
  const sharedColor = colored.length > 0 && colored.every((b) => b.color === colored[0].color) ? colored[0].color : null;
  const contextNode = context !== null ? nodes.find((n) => n.id === context) : undefined;
  const selectionTitle = single ? title(single) : `${selectedNodes.length} selected`;
  // A single group shows what's in it, like the agent's outline.
  // What follows the selected shape (10.3): `followed by array_2`.
  const followers = singleShape ? nodes.filter((n) => isFollowing(n) && n.layout.along.id === singleShape.id).map((n) => n.id) : [];
  const followedBy = followers.length > 0 ? ` · followed by ${followers.join(", ")}` : "";
  const selectionInfo = singleShape
    ? details(singleShape, library) + followedBy
    : single
      ? countsText(nodes.filter((n) => n.id !== single.id && subtreeIds(nodes, single.id).has(n.id)))
      : `${selectedShapes.length} shape${selectedShapes.length === 1 ? "" : "s"}`;
  // What Convert to free-form converts: every box and cylinder in the selection (groups included).
  // A tilted shape can't convert (a free-form's outline is on the ground).
  const convertible = selectedShapes.filter((s) => (s.type === "box" || s.type === "cylinder") && !isTilted(s));
  const convert = () => {
    const ids = convertible.map((s) => s.id);
    const before = nodes;
    // Select the free-forms in their originals' places (each takes its original's place in the list).
    pendingSelect.current = {
      before: new Set(before.map((n) => n.id)),
      pick: (added, next) => {
        const made = new Set(added.map((n) => n.id));
        return selection.map((id) => {
          const n = next[before.findIndex((b) => b.id === id)];
          return ids.includes(id) && n && made.has(n.id) ? n.id : id;
        });
      },
    };
    send({ type: "convert_nodes", ids });
  };
  const editable =
    // Every array has an edit mode (10.4): its item dots and handles, and a path's or an area's points.
    singleShape?.type === "freeform" || singleShape?.type === "line" || singleShape?.type === "array" ? singleShape : null;
  // Kind is for closed shapes: hidden when only lines are selected, disabled unless a single closed shape is.
  const singleClosed = singleShape && isClosed(singleShape) ? singleShape : null;
  const selectedLines = selectedShapes.filter((s): s is Line => s.type === "line");
  const onlyLines = selectedShapes.length > 0 && selectedLines.length === selectedShapes.length;
  // The selected lines' style: each value when they all share it.
  const shared = <K extends keyof LineStyle>(k: K) =>
    selectedLines.every((l) => l[k] === selectedLines[0][k]) ? selectedLines[0]?.[k] : undefined;
  // The wall control acts on every room in the selection; it shows their thickness when they share one.
  const selectedRooms = selectedShapes.filter((s): s is ClosedShape => isClosed(s) && s.kind === "room");
  const wallControl =
    selectedRooms.length > 0
      ? {
          value: selectedRooms.every((r) => wallOf(r) === wallOf(selectedRooms[0])) ? wallOf(selectedRooms[0]) : undefined,
          onChange: (wall: number) => send({ type: "update_nodes", changes: selectedRooms.map((r) => ({ id: r.id, wall })) }),
        }
      : undefined;
  // The taper and bevel sliders act on every volume and hole in the selection, showing each value when they all share it.
  const selectedVolumes = selectedShapes.filter((s): s is ClosedShape => isClosed(s) && s.kind !== "room");
  const sharedOf = (f: "taper" | "bevel") =>
    selectedVolumes.every((v) => (v[f] ?? 0) === (selectedVolumes[0][f] ?? 0)) ? (selectedVolumes[0]?.[f] ?? 0) : undefined;
  const profileControl =
    selectedVolumes.length > 0
      ? {
          taper: sharedOf("taper"),
          bevel: sharedOf("bevel"),
          onChange: (patch: { taper?: number; bevel?: number }) =>
            send({ type: "update_nodes", changes: selectedVolumes.map((v) => ({ id: v.id, ...patch })) }),
          onPreview: (patch: { taper?: number; bevel?: number } | null) =>
            setPreview(patch && Object.fromEntries(selectedVolumes.map((v) => [v.id, patch]))),
        }
      : undefined;
  // The tilt fields act on every box and cylinder volume or hole in the selection, each around its own center.
  // Tilt (14.4): every closed shape, instance and array selected, each by its own pitch and roll (a free-form's and
  // an array's around the world's axes).
  const tiltable = selection.flatMap((id) => {
    const n = nodes.find((m) => m.id === id);
    return n && ((isShape(n) && isClosed(n)) || n.type === "instance" || n.type === "array") ? [n as ClosedShape | Instance | ArrayNode] : [];
  });
  const sharedTilt = (f: "pitch" | "roll") => (tiltable.every((v) => (v[f] ?? 0) === (tiltable[0][f] ?? 0)) ? (tiltable[0]?.[f] ?? 0) : undefined);
  const tiltControl =
    tiltable.length > 0
      ? {
          pitch: sharedTilt("pitch"),
          roll: sharedTilt("roll"),
          onChange: (patch: { pitch?: number; roll?: number }) => send({ type: "update_nodes", changes: tiltable.map((v) => ({ id: v.id, ...patch })) }),
        }
      : undefined;
  // Yaw (14.4): a box's, cylinder's or instance's turn, typed (only the gizmo set it before).
  const yawable = tiltable.filter((n): n is Box | Cylinder | Instance => n.type === "box" || n.type === "cylinder" || n.type === "instance");
  const yawControl =
    yawable.length > 0 && yawable.length === tiltable.length
      ? {
          value: yawable.every((n) => n.rotation === yawable[0].rotation) ? yawable[0].rotation : undefined,
          onChange: (rotation: number) => send({ type: "update_nodes", changes: yawable.map((n) => ({ id: n.id, rotation })) }),
        }
      : undefined;
  // Instances and arrays selected directly (14.3): their uniform scale.
  const scaled = selection.flatMap((id) => {
    const n = nodes.find((m) => m.id === id);
    return n && (n.type === "instance" || n.type === "array") ? [n] : [];
  });
  const scaleControl =
    scaled.length > 0
      ? {
          value: scaled.every((n) => (n.scale ?? 1) === (scaled[0].scale ?? 1)) ? (scaled[0].scale ?? 1) : undefined,
          onChange: (scale: number) => send({ type: "update_nodes", changes: scaled.map((n) => ({ id: n.id, scale })) }),
        }
      : undefined;
  // The drawing tools' next shape: its wall control for a room, its taper and bevel for a volume.
  const setNext = (patch: KindFields) => setNextFields({ ...nextFields, ...patch });
  const nextWallControl =
    nextKind === "room"
      ? { value: nextFields.wall ?? DEFAULT_WALL, onChange: (wall: number) => setNext({ wall: wall === DEFAULT_WALL ? undefined : wall }) }
      : undefined;
  const nextProfileControl =
    nextKind !== "room"
      ? {
          taper: nextFields.taper ?? 0,
          bevel: nextFields.bevel ?? 0,
          onChange: (patch: { taper?: number; bevel?: number }) =>
            setNext(Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === 0 ? undefined : v]))),
        }
      : undefined;
  // The ramp controls act on every selected ramp, showing each value when they all share it.
  const selectedRamps = selectedShapes.filter((s): s is Ramp => s.type === "ramp");
  const sharedRamp = <K extends keyof RampStyle>(k: K) =>
    selectedRamps.every((r) => r[k] === selectedRamps[0][k]) ? selectedRamps[0]?.[k] : undefined;
  const rampControls =
    selectedRamps.length > 0
      ? {
          style: { width: sharedRamp("width"), step: sharedRamp("step"), base: sharedRamp("base") },
          onChange: (patch: Partial<RampStyle>) =>
            send({
              type: "update_nodes",
              changes: selectedRamps.map((r) => ({ id: r.id, ...patch, ...("step" in patch && patch.step === undefined ? { step: null } : {}) })),
            }),
          onReverse: () =>
            send({ type: "update_nodes", changes: selectedRamps.map((r) => ({ id: r.id, points: reversePoints(r.points as LinePoint[]) })) }),
        }
      : undefined;
  const lineControls =
    selectedLines.length > 0
      ? {
          style: { thickness: shared("thickness"), dashed: shared("dashed"), arrow: shared("arrow") },
          onChange: (patch: Partial<LineStyle>) => send({ type: "update_nodes", changes: selectedLines.map((l) => ({ id: l.id, ...patch })) }),
          onPreview: (patch: { thickness: number } | null) => setPreview(patch && Object.fromEntries(selectedLines.map((l) => [l.id, patch]))),
          onReverse: () => send({ type: "update_nodes", changes: selectedLines.map((l) => ({ id: l.id, points: reversePoints(l.points) })) }),
        }
      : undefined;

  // The contextual bar (kind and colors) and the inspector (every other field): for the drawing tool's next shape,
  // or for the selection in the Select tool.
  const nextTitle: Partial<Record<Tool, string>> = { box: "next box", cylinder: "next cylinder", pen: "next free-form", line: "next line", ramp: "next ramp", note: "next note" };
  const closedTool = tool === "box" || tool === "cylinder" || tool === "pen";
  const selecting = tool === "select" && selectedNodes.length > 0;
  const bar: ComponentProps<typeof ContextualBar> | null = closedTool
    ? { kind: nextKind, onKind: setNextKind, color: nextColor, onColor: setNextColor }
    : tool === "line"
      ? { kind: null, color: nextLine.color, onColor: (color) => setNextLine({ ...nextLine, color }) }
      : tool === "ramp"
        ? { kind: null, color: nextRamp.color, onColor: (color) => setNextRamp({ ...nextRamp, color }) }
        : tool === "note"
          ? { kind: null, color: nextNoteColor, onColor: setNextNoteColor }
          : selecting
          ? {
              kind: singleClosed?.kind ?? null,
              kindDisabled: !singleClosed,
              onKind: !selectedShapes.some(isClosed)
                ? undefined
                : (kind) => singleClosed && send({ type: "update_nodes", changes: [{ id: singleClosed.id, kind }] }),
              color: sharedColor,
              onColor: (color) => colored.length > 0 && send({ type: "update_nodes", changes: colored.map((b) => ({ id: b.id, color })) }),
            }
          : null;
  const inspector: InspectorProps | null = closedTool
    ? {
        title: nextTitle[tool]!,
        sides: tool === "cylinder" ? { value: nextSides, onChange: setNextSides } : undefined,
        wall: nextWallControl,
        profile: nextProfileControl,
      }
    : tool === "line"
      ? { title: "next line", line: { style: nextLine, onChange: (patch) => setNextLine({ ...nextLine, ...patch }) } }
      : tool === "ramp"
        ? { title: "next ramp", ramp: { style: nextRamp, onChange: (patch) => setNextRamp({ ...nextRamp, ...patch }) } }
        : tool === "note"
          ? { title: "next note", info: "click to pin it on the surface under the cursor, then write it here" }
          : selecting
          ? {
              title: contextNode ? `${contextNode.name ?? contextNode.id} › ${selectionTitle}` : selectionTitle,
              info: editing && editable ? `editing ${editable.type === "array" ? "items" : "points"} · ${selectionInfo}` : selectionInfo,
              library,
              links: linksOf(single, nodes, send),
              instance:
                single?.type === "instance" && library
                  ? {
                      entity: single.entity,
                      entities: library.entities,
                      onEdit: () => send({ type: "open_entity", entity: single.entity }),
                      onSwap: (entity) => send({ type: "update_nodes", changes: [{ id: single.id, entity }] }),
                      onDetach: () => {
                        pendingSelect.current = { before: new Set(nodes.map((n) => n.id)), pick: (added) => added.filter((n) => n.type === "group" && n.parent === single.parent).map((n) => n.id).slice(0, 1) };
                        send({ type: "detach_instances", ids: [single.id] });
                      },
                      onArray: editingEntity
                        ? undefined
                        : () => {
                            pendingSelect.current = { before: new Set(nodes.map((n) => n.id)), pick: (added) => added.filter((n) => n.type === "array").map((n) => n.id) };
                            send({ type: "make_array", id: single.id });
                          },
                    }
                  : undefined,
              array:
                single?.type === "array" && library
                  ? (() => {
                      const { items } = arrayLayout(single);
                      const update = (change: Record<string, unknown>) => send({ type: "update_nodes", changes: [{ id: single.id, ...change }] });
                      return {
                        entities: single.entities,
                        library: library.entities,
                        layout: single.layout,
                        facing: facingOf(single),
                        rotation: single.rotation ?? 0,
                        jitter: single.jitter ?? 0,
                        turnJitter: single.turnJitter ?? 0,
                        seed: single.seed ?? 1,
                        items: items.length,
                        skipped: single.skip?.length ?? 0,
                        shortfall: arrayShortfall(single),
                        onEntities: (entities: { entity: string; weight?: number }[]) => update({ entities }),
                        follow: single.layout.type === "path" ? followControls(single.layout.along, single.id, update) : undefined,
                        onLayoutType: (type: ArrayLayoutType) => update(layoutAround(single, type)),
                        onLayout: (patch: Record<string, unknown>) => update({ layout: patch }),
                        onChange: (patch: Record<string, unknown>) => update(patch),
                        onEdit: (entity: string) => send({ type: "open_entity", entity }),
                        onRestoreAll: () => update({ skip: [] }),
                        onDetach: () => {
                          pendingSelect.current = { before: new Set(nodes.map((n) => n.id)), pick: (added) => added.filter((n) => n.type === "group" && n.parent === single.parent).map((n) => n.id).slice(0, 1) };
                          send({ type: "detach_instances", ids: [single.id] });
                        },
                      };
                    })()
                  : undefined,
              makeEntity:
                !editingEntity && selectedShapes.length > 0 && !selectedShapes.some((b) => b.type === "instance" || b.type === "array" || b.type === "note" || b.type === "terrain")
                  ? {
                      suggested: (single && isGroup(single) ? single.name : undefined) ?? "entity",
                      onMake: (name) => {
                        pendingSelect.current = { before: new Set(nodes.map((n) => n.id)), pick: (added) => added.filter((n) => n.type === "instance").map((n) => n.id) };
                        send({ type: "make_entity", ids: selection, name });
                      },
                    }
                  : undefined,
              note:
                single?.type === "note"
                  ? {
                      text: single.text,
                      label: single.label ?? "",
                      status: single.status,
                      focus: freshNote === single.id,
                      onFocused: () => setFreshNote(null),
                      onChange: (patch) => send({ type: "update_nodes", changes: [{ id: single.id, ...patch }] }),
                    }
                  : undefined,
              description:
                single && isGroup(single)
                  ? { value: single.description ?? "", onChange: (text) => send({ type: "update_nodes", changes: [{ id: single.id, description: text || null }] }) }
                  : undefined,
              tags:
                // An instance's tags are its entity's (edited in the Entities panel), so it has no field of its own.
                single && single.type !== "line" && single.type !== "note" && single.type !== "instance" && single.type !== "array" && library
                  ? {
                      value: currentTags(library, tagsOf(single)),
                      onChange: (tags) => send({ type: "update_nodes", changes: [{ id: single.id, tags }] }),
                      onCreate: (name) => {
                        send({ type: "update_library", upsert: [{ kind: "tag", name }] });
                        send({ type: "update_nodes", changes: [{ id: single.id, tags: [...currentTags(library, tagsOf(single)), name] }] });
                      },
                    }
                  : undefined,
              sides:
                singleShape?.type === "cylinder"
                  ? { value: singleShape.sides, onChange: (sides) => send({ type: "update_nodes", changes: [{ id: singleShape.id, sides: sides ?? null }] }) }
                  : undefined,
              wall: wallControl,
              profile: profileControl,
              tilt: tiltControl && { ...tiltControl, ...(yawControl ? { yaw: yawControl } : {}) },
              scale: scaleControl,
              onScaleBy: selectedShapes.some((s) => s.type !== "note")
                ? (factor) => {
                    const b = boundsOf(selectedShapes);
                    send({ type: "transform_nodes", ids: selection, scale: factor, pivot: { x: round2((b.minX + b.maxX) / 2), y: round2(b.minY), z: round2((b.minZ + b.maxZ) / 2) } });
                  }
                : undefined,
              line: lineControls,
              ramp: rampControls,
              onMirror: (axis) => send({ type: "mirror_nodes", ids: selection, axis }),
              onConvert: convertible.length > 0 ? convert : undefined,
              editPoints: editable
                ? { active: editing === editable.id, onToggle: () => setEditing(editing ? null : editable.id), ...(editable.type === "array" ? { label: "Edit items" } : {}) }
                : undefined,
            }
          : null;

  return (
    <div className={[libraryOpen && open && library ? "app library-open" : "app", walking ? "walking" : ""].join(" ").trim()}>
      <Viewport
        tool={activeTool}
        nodes={nodes}
        selection={selection}
        context={context}
        onContext={setContext}
        editing={editing}
        onEditing={setEditing}
        outsideHover={outlinerHover}
        nextKind={nextKind}
        nextSides={nextSides}
        nextFields={nextFields}
        nextLine={nextLine}
        nextRamp={nextRamp}
        showModifiers={showModifiers}
        showHoles={showHoles}
        showGrid={showGrid}
        visible={visible}
        preview={preview}
        onSelect={setSelection}
        showNotes={showNotes}
        showLines={showLines}
        showCursor={showCursor}
        showStats={showStats}
        entityMode={!!editingEntity}
        onOpenEntity={(entity) => send({ type: "open_entity", entity })}
        onPickTarget={
          followPick
            ? (id) => {
                send({ type: "update_nodes", changes: [{ id: followPick, layout: { along: { id } } }] });
                setFollowPick(null);
              }
            : undefined
        }
        placing={placing}
        onPlaceInstance={(entity, at) => {
          pendingSelect.current = { before: new Set(nodes.map((n) => n.id)), pick: (added) => added.filter((n) => n.type === "instance").map((n) => n.id) };
          send({ type: "add_shapes", shapes: [{ type: "instance", entity, ...at, ...(context !== null ? { parent: context } : {}) }] });
          setPlacing(null);
          setTool("select");
        }}
        onPlaceNote={(at) => {
          pendingSelect.current = {
            before: new Set(nodes.map((n) => n.id)),
            pick: (added) => {
              const note = added.find((n) => n.type === "note");
              if (note) setFreshNote(note.id);
              return note ? [note.id] : [];
            },
          };
          send({ type: "add_shapes", shapes: [{ type: "note", ...at, text: "", color: nextNoteColor, ...(context !== null ? { parent: context } : {}) }] });
          setTool("select");
        }}
        onDrawShape={(shape) =>
          send({
            type: "add_shapes",
            // Into the entered group (an isolated group is entered), like a paste.
            shapes: [
              {
                ...shape,
                ...(context !== null ? { parent: context } : {}),
                color: shape.type === "line" ? nextLine.color : shape.type === "ramp" ? nextRamp.color : nextColor,
              } as ShapeInput,
            ],
          })
        }
        onUpdate={(changes) => send({ type: "update_nodes", changes })}
        onTransform={(t) => send({ type: "transform_nodes", ...t })}
        onTilt={(t) => send({ type: "rotate_nodes", ...t })}
        onDuplicate={({ ids, ...offset }) => {
          lastCopy.current = offset;
          duplicate(ids, offset);
        }}
        onNotice={setNotice}
        onCursor={setCursor}
        onViewChange={(v, c) => {
          setView(v);
          setCamera({ focus: { ...c.focus }, yaw: c.yaw, distance: c.distance });
        }}
        cameraRestore={restore}
        cameraFrame={cameraFrame}
        api={viewportApi}
        walkPreset={walkPreset}
        player={player}
        onPlayer={changePlayer}
        avatarEntity={library?.entities.find((e) => e.id === "human")?.id ?? library?.entities.find((e) => e.name === "human")?.id ?? null}
        onWalkShot={(shot) => void saveWalkShot(shot)}
        onWalkChange={(on) => {
          setWalking(on);
          if (!on) setTool("select");
        }}
        shots={shots}
        onRemoveShot={(id) => send({ type: "remove_shot", id })}
      />

      <div className="left-dock">
        <Outliner
          key={sceneKey}
          nodes={nodes}
          selection={selection}
          onSelect={(ids, ctx) => {
            setSelection(ids);
            setContext(ctx);
          }}
          onHover={setOutlinerHover}
          onRename={(id, name) => send({ type: "update_nodes", changes: [{ id, name }] })}
          onPlace={(ids, parent, before) => send({ type: "place_nodes", ids, parent, before })}
          isolated={isolated}
          visible={visible}
          onIsolate={isolate}
          onLock={(id, locked) => send({ type: "update_nodes", changes: [{ id, locked }] })}
          onHide={(id, hidden) => send({ type: "update_nodes", changes: [{ id, hidden }] })}
          onFrame={(id) => {
            const shapes = expandShapes(shapesUnder(nodes, [id]));
            if (shapes.length === 0) setNotice("Nothing to frame: it's empty");
            else setCameraFrame({ bounds: boundsOf(shapes) });
          }}
          entityNames={Object.fromEntries((library?.entities ?? []).map((e) => [e.id, e.name]))}
          entityMode={!!editingEntity}
        />
      </div>
      {flash > 0 && <ShutterFlash key={flash} />}
      {open && shotsOpen && (
        <ShotsPanel
          shots={shots}
          seq={seq}
          sceneName={editingEntity ? editingEntity.name : open.scene.name}
          onGoTo={(shot) => {
            if (shot.camera.kind === "editor") setCameraFrame({ camera: { focus: shot.camera.focus, yaw: shot.camera.yaw, distance: shot.camera.distance } });
            else viewportApi.current?.walkTo(shot.camera);
          }}
          onCaption={(id, caption) => send({ type: "update_shot", id, caption })}
          onRemove={(id) => send({ type: "remove_shot", id })}
          onNotice={setNotice}
          onClose={() => setShotsOpen(false)}
        />
      )}
      {open && library && (
        <EntitiesPanel
          library={library}
          uses={libraryState.uses}
          edit={(e) => send({ type: "update_library", ...e })}
          placing={placing}
          onPlace={(id) => (editingEntity ? setNotice("Entities can't hold instances: go back to a scene to place one") : setPlacing(placing === id ? null : id))}
          onEdit={(id) => send({ type: "open_entity", entity: id })}
          editing={editingEntity?.id ?? null}
        />
      )}

      {open && (
        <div className="top-left">
          <div className="brand">
            <Wordmark size="small" />
          </div>
          <button
            type="button"
            className="project-bar"
            title="Projects and scenes"
            onClick={() => {
              clearError();
              setPickerOpen(true);
            }}
          >
            <MapIcon size={14} className="icon" />
            <span className="where">
              {open.project.name} ▸ {open.scene.name}
              {editingEntity && ` ▸ ${library ? (entityMeta(library, editingEntity.id)?.name ?? editingEntity.name) : editingEntity.name}`}
            </span>
            <ChevronDown size={14} className="icon" />
          </button>
          <button
            type="button"
            className={libraryOpen ? "library-toggle active" : "library-toggle"}
            title={libraryOpen ? "Close the library" : "The project's library: skills, tags and the design guide"}
            onClick={() => setLibraryOpen(!libraryOpen)}
          >
            <BookOpen size={14} />
          </button>
          <button
            type="button"
            className={exportStatus?.auto ? "library-toggle active" : "library-toggle"}
            title={exportStatus?.auto ? "Export: to Unity after every step" : "Export: to Unity, or as a 3D file"}
            onClick={() => {
              clearError();
              setExportOpen(true);
            }}
          >
            <Upload size={14} />
          </button>
          <AgentChip
            agent={agent}
            here={!!agent && !editingEntity && agent.project === open.project.id && agent.scene === open.scene.id}
            canInvite={!editingEntity}
            onInvite={() => send({ type: "invite_agent" })}
            onStop={() => send({ type: "stop_agent" })}
            onJoin={() => agent && send({ type: "open_scene", project: agent.project, scene: agent.scene })}
          />
        </div>
      )}

      {open && library && libraryOpen && (
        <LibraryPanel
          library={library}
          history={libraryState.history}
          uses={libraryState.uses}
          send={send}
          onClose={() => setLibraryOpen(false)}
        />
      )}
      {editingEntity && (
        <div className="entity-banner">
          <Package size={14} />
          <span>
            Editing entity <b>{library ? (entityMeta(library, editingEntity.id)?.name ?? editingEntity.name) : editingEntity.name}</b>
            {" · "}
            {(() => {
              const u = libraryState.uses.entities[editingEntity.id];
              return u ? `placed ${u.nodes} time${u.nodes === 1 ? "" : "s"} in ${u.sceneNames.join(", ")}` : "not placed yet";
            })()}
            {" · the origin is its pivot; changes reach every instance"}
          </span>
          <button type="button" title="Back to the scene (Esc with nothing selected)" onClick={() => send({ type: "close_entity" })}>
            <ArrowLeft size={13} /> Back to {open?.scene.name}
          </button>
        </div>
      )}
      {placing && library && (
        <div className="placing-banner">
          Placing <b>{entityMeta(library, placing)?.name ?? placing}</b>: click on a surface in the view
          <button type="button" onClick={() => setPlacing(null)}>
            Esc
          </button>
        </div>
      )}

      <div className="info-label">
        <span className={connected ? "conn" : "conn offline"}>
          <i className="dot" />
          {connected ? "connected" : "offline"}
        </span>
        <span className="coords">
          x {coord(cursor?.x)} · y {coord(cursor?.y)} · z {coord(cursor?.z)} m
        </span>
        <span className="coords">yaw {`${Math.round(view.yaw)}°`.padStart(4)}</span>
        <span className="sep" />
        <span className="counts">
          {scene
            ? countsText(nodes)
            : "—"}
        </span>
        <span className="sep" />
        <span className={notice ? "hint notice" : "hint"}>{notice ?? (editing && activeTool === "select" ? (nodes.find((n) => n.id === editing)?.type === "array" ? EDIT_ARRAY_HINT : EDIT_POINTS_HINT) : HINTS[activeTool])}</span>
      </div>

      <div className="dock">
        {error && <div className="error">{error}</div>}
        {bar && <ContextualBar {...bar} />}
        {activeTool === "walk" && <WalkBar preset={walkPreset} onPreset={setWalkPreset} />}
        <ToolBar
          tool={activeTool}
          onTool={chooseTool}
          history={history}
          connected={connected}
          onUndo={() => send({ type: "undo" })}
          onRedo={() => send({ type: "redo" })}
          onClear={() => send({ type: "clear" })}
        />
      </div>

      {open && !editingEntity && <TerrainPanel nodes={nodes} selection={selection} show={showModifiers} toggle={() => setShowModifiers(!showModifiers)} focus={view.focus}
        create={(shapes) => { pendingSelect.current = { before: new Set(nodes.map((n) => n.id)), pick: (added) => added.filter((n) => n.type === "terrain").map((n) => n.id) }; send({ type: "add_shapes", shapes }); }}
        update={(changes) => send({ type: "update_nodes", changes })} enter={(id) => { setContext(id); setSelection([]); setNextKind("volume"); setTool("box"); }} />}
      {inspector && <Inspector {...inspector} />}

      <div className="top-right">
        {open && (
          <ViewBar
            holes={{ on: showHoles, onToggle: () => setShowHoles(!showHoles) }}
            grid={{ on: showGrid, onToggle: () => setShowGrid(!showGrid) }}
            notes={{ on: showNotes, onToggle: () => setShowNotes(!showNotes) }}
            lines={{ on: showLines, onToggle: () => setShowLines(!showLines) }}
            cursor={{ on: showCursor, onToggle: () => setShowCursor(!showCursor) }}
            stats={{ on: showStats, onToggle: () => setShowStats(!showStats) }}
            isolated={
              isolated
                ? { label: isolatedNode ? title(isolatedNode) : isolated, onEnd: () => isolate(null) }
                : null
            }
            shots={{ count: shots.length, panelOpen: shotsOpen, onShutter: () => void shutter(), onTogglePanel: () => setShotsOpen(!shotsOpen) }}
          />
        )}
        <ErrorPanel />
      </div>

      {!connected && open === null && <Welcome />}
      {connected && (open === null || pickerOpen) && (
        <ProjectPicker
          projects={projects}
          open={open ?? null}
          error={error}
          onClose={open ? () => setPickerOpen(false) : undefined}
          send={send}
          agent={agent}
        />
      )}
      {open && exportOpen && exportStatus && <ExportDialog status={exportStatus} error={error} send={send} onClose={() => setExportOpen(false)} />}
    </div>
  );
}

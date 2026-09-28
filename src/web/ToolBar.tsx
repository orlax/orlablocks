import {
  Activity,
  Box as BoxIcon,
  Cylinder,
  Eye,
  EyeOff,
  Camera,
  Focus,
  Moon,
  Images,
  Grid3x3,
  Hand,
  MousePointer2,
  PenTool,
  PersonStanding,
  User,
  UserRound,
  Redo2,
  Square,
  SquareDashed,
  SquareDot,
  StickyNote,
  Sun,
  SunMoon,
  Trash2,
  Undo2,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { PALETTE, SHAPE_COLORS, type HistorySummary, type ShapeColor, type ShapeKind, type WalkPreset } from "../shared/scene.types";
import { Stairs } from "./icons";
import { applyTheme, nextTheme, readTheme, systemIsDark } from "./theme";
import { WALK_DRAG, type Tool } from "./Viewport";

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export const TOOLS: { tool: Tool; label: string; key: string; icon: LucideIcon }[] = [
  { tool: "select", label: "Select", key: "v", icon: MousePointer2 },
  { tool: "hand", label: "Hand", key: "h", icon: Hand },
  { tool: "box", label: "Box", key: "b", icon: BoxIcon },
  { tool: "cylinder", label: "Cylinder", key: "c", icon: Cylinder },
  { tool: "pen", label: "Pen (free-form)", key: "p", icon: PenTool },
  { tool: "line", label: "Line", key: "l", icon: Waypoints },
  { tool: "ramp", label: "Ramp (and stairs)", key: "r", icon: Stairs },
  { tool: "note", label: "Note", key: "n", icon: StickyNote },
  { tool: "walk", label: "Walk (drag onto the view, or click in it)", key: "w", icon: PersonStanding },
];

/** What each tool does and its modifiers, shown in the info-label. */
export const HINTS: Record<Tool, string> = {
  select: `click to select (Shift adds) · drag a box to move it (Alt copies, Alt+J repeats) · ⇧X/⇧Z mirror · drag empty ground to marquee · ${MOD}A all · Space to pan`,
  hand: "drag to pan · scroll to zoom · A/D or ←/→ to rotate",
  box: `drag to draw, on the surface under the cursor (a top, a floor, a wall top, else the ground) · Shift square · Alt from center · ${MOD} no snap · Esc to cancel`,
  cylinder: `drag to draw, on the surface under the cursor · Shift circle · Alt from center · ${MOD} no snap · Esc to cancel`,
  pen: `click for a corner (the first one sets the surface it stands on) · drag for a curve · click the first point or Enter to close · ⌫ removes the last point · ${MOD} no snap · Esc to cancel`,
  line: `click to place a point on the surface under the cursor · drag for a curve · double-click or Enter to finish · ⌫ removes the last point · ${MOD} no snap · Esc to cancel`,
  ramp: `click on the floor, then on the top it climbs to (each point on the surface under the cursor) · drag for a curve · double-click or Enter to finish · ⌫ removes the last point · ${MOD} no snap · Esc to cancel`,
  note: "click to pin a note on the surface under the cursor, then write it in the inspector · a label (up to 3 letters) makes it a flag",
  walk: "click on a floor to drop in · then the mouse looks, WASD walks, E/Q float, F lands, Shift is fast, the wheel sets the speed, a click takes a shot · Esc pauses, Esc again exits",
};

/** The hint in an array's edit mode (10.4: double-click it, or Edit items). */
export const EDIT_ARRAY_HINT =
  `click an item's dot (Shift-click adds) · ⌫ skips the selected items, or brings skipped ones back · drag the orange handles: a center (it snaps to shapes' centers), ` +
  `a radius (Shift: a circle's start), a grid's spacing (Shift: equal) · a path's or an area's points drag as a line's · ${MOD} no snap · Esc or click outside to finish`;

/** The hint while editing a free-form's points (the Select tool, after double-clicking it). */
export const EDIT_POINTS_HINT =
  `drag a point or handle (Alt breaks a smooth point; a line's point: its green arrow raises it) · Shift-click adds points · click an edge to add a point · ` +
  `double-click a point: corner ↔ smooth · ⌫ deletes points · ${MOD} no snap · Esc or click outside to finish`;

const KINDS: { kind: ShapeKind; label: string; icon: LucideIcon }[] = [
  { kind: "room", label: "Room (hollow)", icon: SquareDashed },
  { kind: "volume", label: "Volume (solid)", icon: Square },
  { kind: "hole", label: "Hole (cuts the shapes in its group, beside its group, and in the groups beside those)", icon: SquareDot },
];

/** The floating bar at the bottom: the tools, then undo / redo / clear. */
export function ToolBar({
  tool,
  onTool,
  history,
  connected,
  onUndo,
  onRedo,
  onClear,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  history: HistorySummary;
  connected: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
}) {
  return (
    <div className="tool-bar">
      {TOOLS.map(({ tool: t, label, key, icon: Icon }) => (
        <button
          key={t}
          className={t === tool ? "tool active" : "tool"}
          title={`${label} (${key.toUpperCase()})`}
          onClick={() => onTool(t)}
          // The Walk button can be dropped onto the view: the walk starts where it lands.
          draggable={t === "walk"}
          onDragStart={
            t === "walk"
              ? (e) => {
                  e.dataTransfer.setData(WALK_DRAG, "1");
                  e.dataTransfer.effectAllowed = "copy";
                }
              : undefined
          }
        >
          <Icon size={20} />
          <span className="key">{key.toUpperCase()}</span>
        </button>
      ))}
      <span className="sep" />
      <IconButton
        icon={Undo2}
        onClick={onUndo}
        disabled={!connected || !history.canUndo}
        title={history.undoLabel ? `Undo: ${history.undoLabel} (${MOD}Z)` : "Nothing to undo"}
      />
      <IconButton
        icon={Redo2}
        onClick={onRedo}
        disabled={!connected || !history.canRedo}
        title={history.redoLabel ? `Redo: ${history.redoLabel} (${MOD}⇧Z)` : "Nothing to redo"}
      />
      <IconButton icon={Trash2} onClick={onClear} disabled={!connected} title="Clear the scene" />
    </div>
  );
}

function IconButton({ icon: Icon, ...props }: { icon: LucideIcon; onClick: () => void; disabled?: boolean; title: string }) {
  return (
    <button className="icon" {...props}>
      <Icon size={16} />
    </button>
  );
}

/**
 * The bar just above the tool-bar: the kind toggle and the palette swatches. What it acts on is up to the caller
 * (the next shape in a drawing tool, the selection in the Select tool); every other field is in the inspector.
 * `kind` / `color` are the highlighted values, null when there's none to highlight.
 */
export function ContextualBar({
  kind,
  kindDisabled = false,
  onKind,
  color,
  onColor,
}: {
  kind: ShapeKind | null;
  kindDisabled?: boolean;
  /** Shows the kind toggle (not for lines and ramps, which have no choice of kind). */
  onKind?: (kind: ShapeKind) => void;
  color: ShapeColor | null;
  onColor: (color: ShapeColor) => void;
}) {
  return (
    <div className="contextual-bar">
      {onKind && (
        <>
          <div className="segmented">
            {KINDS.map(({ kind: k, label, icon: Icon }) => (
              <button
                key={k}
                className={k === kind ? "active" : ""}
                disabled={kindDisabled}
                title={kindDisabled ? `${label}: select a single shape to change its kind` : label}
                onClick={() => onKind(k)}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
          <span className="sep" />
        </>
      )}
      <div className="swatches">
        {SHAPE_COLORS.map((c) => (
          <button
            key={c}
            className={c === color ? "swatch active" : "swatch"}
            style={{ background: PALETTE[c] }}
            title={c}
            onClick={() => onColor(c)}
          />
        ))}
      </div>
    </div>
  );
}

/** The Walk tool's contextual bar: the preset the next walk starts with (09.2). */
export function WalkBar({ preset, onPreset }: { preset: WalkPreset; onPreset: (preset: WalkPreset) => void }) {
  return (
    <div className="contextual-bar">
      <div className="segmented labeled">
        <button className={preset === "first" ? "active" : ""} title="First person: the camera is the eye" onClick={() => onPreset("first")}>
          <User size={15} /> First person
        </button>
        <button className={preset === "third" ? "active" : ""} title="Third person: over the shoulder of the human" onClick={() => onPreset("third")}>
          <UserRound size={15} /> Third person
        </button>
      </div>
    </div>
  );
}

/**
 * The view bar, top right: what the view shows. Holes as ghosts (off: only what they cut away shows, for a clean
 * look) and the grid, both for this tab only; and while a node is isolated, which one, with ✕ to show everything.
 * Then the shutter (a shot of the view, `K`) and the Shots panel's button, with how many there are (09.1).
 */
export function ViewBar({
  holes,
  grid,
  notes,
  stats,
  isolated,
  shots,
}: {
  holes: { on: boolean; onToggle: () => void };
  grid: { on: boolean; onToggle: () => void };
  notes: { on: boolean; onToggle: () => void };
  stats: { on: boolean; onToggle: () => void };
  isolated: { label: string; onEnd: () => void } | null;
  shots: { count: number; panelOpen: boolean; onShutter: () => void; onTogglePanel: () => void };
}) {
  return (
    <div className="view-bar">
      {isolated && (
        <>
          <span className="isolated" title="Only this and what's in it show (Esc with nothing selected, or I, shows everything)">
            <Focus size={13} /> {isolated.label}
            <button type="button" title="Show everything" onClick={isolated.onEnd}>
              <X size={13} />
            </button>
          </span>
          <span className="sep" />
        </>
      )}
      <button
        type="button"
        className={holes.on ? "toggle" : "toggle off"}
        title={holes.on ? "Hide holes: see only what they cut away" : "Show holes as ghosts"}
        onClick={holes.onToggle}
      >
        {holes.on ? <Eye size={13} /> : <EyeOff size={13} />} holes
      </button>
      <button type="button" className={grid.on ? "toggle" : "toggle off"} title={grid.on ? "Hide the grid" : "Show the grid"} onClick={grid.onToggle}>
        <Grid3x3 size={13} /> grid
      </button>
      <button type="button" className={notes.on ? "toggle" : "toggle off"} title={notes.on ? "Hide the notes" : "Show the notes"} onClick={notes.onToggle}>
        <StickyNote size={13} /> notes
      </button>
      <button
        type="button"
        className={stats.on ? "toggle" : "toggle off"}
        title={stats.on ? "Hide the stats (render time, draw calls, triangles, shapes)" : "Show the stats: render time, draw calls, triangles and shapes"}
        onClick={stats.onToggle}
      >
        <Activity size={13} /> stats
      </button>
      <span className="sep" />
      <button type="button" title="Take a shot of the view (K)" onClick={shots.onShutter}>
        <Camera size={13} />
      </button>
      <button
        type="button"
        className={shots.panelOpen ? "toggle" : "toggle off"}
        title={shots.panelOpen ? "Hide the Shots panel" : "Show the Shots panel"}
        onClick={shots.onTogglePanel}
      >
        <Images size={13} /> {shots.count}
      </button>
      <span className="sep" />
      <ThemeToggle />
    </div>
  );
}

const THEME_ICONS = { system: SunMoon, light: Sun, dark: Moon };

/** The theme toggle (plan 12): System → Light → Dark, remembered in this browser. */
function ThemeToggle() {
  const [choice, setChoice] = useState(readTheme);
  // System's tooltip says what it shows now, so follow the OS while it's open.
  const [dark, setDark] = useState(systemIsDark);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const Icon = THEME_ICONS[choice];
  const now = choice === "system" ? `System (${dark ? "dark" : "light"} now)` : choice === "light" ? "Light" : "Dark";
  return (
    <button
      type="button"
      title={`Theme: ${now}. Click for ${nextTheme(choice)}`}
      onClick={() => {
        const next = nextTheme(choice);
        applyTheme(next);
        setChoice(next);
      }}
    >
      <Icon size={13} />
    </button>
  );
}


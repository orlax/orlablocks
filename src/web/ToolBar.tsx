import {
  Box as BoxIcon,
  Cylinder,
  Eye,
  EyeOff,
  Camera,
  Focus,
  Images,
  Grid3x3,
  Hand,
  MousePointer2,
  PenTool,
  Redo2,
  Square,
  SquareDashed,
  SquareDot,
  StickyNote,
  Trash2,
  Undo2,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { PALETTE, SHAPE_COLORS, type HistorySummary, type ShapeColor, type ShapeKind } from "../shared/scene.types";
import { Stairs } from "./icons";
import type { Tool } from "./Viewport";

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
};

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

/**
 * The view bar, top right: what the view shows. Holes as ghosts (off: only what they cut away shows, for a clean
 * look) and the grid, both for this tab only; and while a node is isolated, which one, with ✕ to show everything.
 * Then the shutter (a shot of the view, `K`) and the Shots panel's button, with how many there are (09.1).
 */
export function ViewBar({
  holes,
  grid,
  notes,
  isolated,
  shots,
}: {
  holes: { on: boolean; onToggle: () => void };
  grid: { on: boolean; onToggle: () => void };
  notes: { on: boolean; onToggle: () => void };
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
    </div>
  );
}


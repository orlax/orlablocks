import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Box as BoxIcon,
  Circle,
  Cylinder,
  FlipHorizontal2,
  Hand,
  Minus,
  MousePointer2,
  PenTool,
  Plus,
  Redo2,
  Square,
  SquareDashed,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { MirrorAxis } from "../shared/geometry";
import { MAX_SIDES, MIN_SIDES, PALETTE, SHAPE_COLORS, type HistorySummary, type ShapeColor, type ShapeKind } from "../shared/scene.types";
import type { Tool } from "./Viewport";

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export const TOOLS: { tool: Tool; label: string; key: string; icon: LucideIcon }[] = [
  { tool: "select", label: "Select", key: "v", icon: MousePointer2 },
  { tool: "hand", label: "Hand", key: "h", icon: Hand },
  { tool: "box", label: "Box", key: "b", icon: BoxIcon },
  { tool: "cylinder", label: "Cylinder", key: "c", icon: Cylinder },
  { tool: "pen", label: "Pen (free-form)", key: "p", icon: PenTool },
];

/** What each tool does and its modifiers, shown in the info-label. */
export const HINTS: Record<Tool, string> = {
  select: `click to select (Shift adds) · drag a box to move it (Alt copies, Alt+J repeats) · ⇧X/⇧Z mirror · drag empty ground to marquee · ${MOD}A all · Space to pan`,
  hand: "drag to pan · scroll to zoom · A/D or ←/→ to rotate",
  box: `drag to draw · Shift square · Alt from center · ${MOD} no snap · Esc to cancel`,
  cylinder: `drag to draw · Shift circle · Alt from center · ${MOD} no snap · Esc to cancel`,
  pen: `click for a corner · drag for a curve · click the first point or Enter to close · ⌫ removes the last point · ${MOD} no snap · Esc to cancel`,
};

/**
 * The mirror buttons: a flip icon (turned a quarter for Z, so the two differ at a glance), and the world axis as a
 * letter colored like the gizmo's arrow. The icon can't show the direction on screen (the camera turns, the axes
 * don't), so the letter names the axis.
 */
const MIRRORS: { axis: MirrorAxis; title: string }[] = [
  { axis: "x", title: "Mirror on X (⇧X): swap east and west, across the selection's center" },
  { axis: "z", title: "Mirror on Z (⇧Z): swap +z and -z, across the selection's center" },
];

const KINDS: { kind: ShapeKind; label: string; icon: LucideIcon }[] = [
  { kind: "room", label: "Room (hollow)", icon: SquareDashed },
  { kind: "volume", label: "Volume (solid)", icon: Square },
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
 * The bar just above the tool-bar: a kind toggle, the palette swatches and some read-only numbers.
 * What it acts on is up to the caller (the next box in the Box tool, the selection in the Select tool).
 * `kind` / `color` are the highlighted values, null when there's none to highlight.
 */
export function ContextualBar({
  kind,
  kindDisabled = false,
  onKind,
  color,
  onColor,
  onMirror,
  sides,
  children,
}: {
  kind: ShapeKind | null;
  kindDisabled?: boolean;
  onKind: (kind: ShapeKind) => void;
  color: ShapeColor | null;
  onColor: (color: ShapeColor) => void;
  /** Shows the X / Z mirror buttons (the Select tool). */
  onMirror?: (axis: MirrorAxis) => void;
  /** Shows the sides control (the Cylinder tool, a selected cylinder): the side count, undefined = smooth. */
  sides?: { value: number | undefined; onChange: (sides: number | undefined) => void };
  children?: ReactNode;
}) {
  return (
    <div className="contextual-bar">
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
      {sides && (
        <>
          <span className="sep" />
          <SidesControl {...sides} />
        </>
      )}
      {onMirror && (
        <>
          <span className="sep" />
          <div className="mirrors">
            {MIRRORS.map(({ axis, title }) => (
              <button key={axis} className={`mirror ${axis}`} title={title} onClick={() => onMirror(axis)}>
                <FlipHorizontal2 size={16} />
                <span className="axis">{axis.toUpperCase()}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {children && (
        <>
          <span className="sep" />
          <span className="info">{children}</span>
        </>
      )}
    </div>
  );
}

/** The count − and + switch to from smooth, before any count has been used. */
const DEFAULT_SIDES = 8;

/**
 * A cylinder's sides: a smooth toggle, then − / a count field / +. From smooth, − or + switches to the last count
 * used here (8 at first); typing a count and pressing Enter (or leaving the field) sets it, clamped to 3..64.
 */
function SidesControl({ value, onChange }: { value: number | undefined; onChange: (sides: number | undefined) => void }) {
  const [last, setLast] = useState(DEFAULT_SIDES);
  // What's being typed, until it's committed; null = show the value. Esc cancels it (the blur then commits nothing).
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (value !== undefined) setLast(value);
  }, [value]);
  const set = (n: number) => onChange(Math.min(MAX_SIDES, Math.max(MIN_SIDES, Math.round(n))));
  const commit = () => {
    if (!cancelled.current && text !== null && text.trim() !== "" && Number.isFinite(Number(text))) set(Number(text));
    cancelled.current = false;
    setText(null);
  };
  const smooth = value === undefined;
  return (
    <div className="sides">
      <button className={smooth ? "smooth active" : "smooth"} title="Smooth: a circle or an oval" onClick={() => onChange(undefined)}>
        <Circle size={16} />
      </button>
      <button title="One side fewer" disabled={!smooth && value <= MIN_SIDES} onClick={() => set(smooth ? last : value - 1)}>
        <Minus size={14} />
      </button>
      <input
        type="text"
        inputMode="numeric"
        className={smooth ? "count smooth" : "count"}
        title={`Sides, ${MIN_SIDES} to ${MAX_SIDES}`}
        value={text ?? (smooth ? "" : String(value))}
        placeholder={smooth ? "smooth" : ""}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancelled.current = true;
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <button title="One side more" disabled={!smooth && value >= MAX_SIDES} onClick={() => set(smooth ? last : value + 1)}>
        <Plus size={14} />
      </button>
    </div>
  );
}

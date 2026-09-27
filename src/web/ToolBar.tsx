import type { ReactNode } from "react";
import { Box as BoxIcon, FlipHorizontal2, Hand, MousePointer2, Redo2, Square, SquareDashed, Trash2, Undo2, type LucideIcon } from "lucide-react";
import type { MirrorAxis } from "../shared/geometry";
import { BOX_COLORS, PALETTE, type BoxColor, type BoxKind, type HistorySummary } from "../shared/scene.types";
import type { Tool } from "./Viewport";

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export const TOOLS: { tool: Tool; label: string; key: string; icon: LucideIcon }[] = [
  { tool: "select", label: "Select", key: "v", icon: MousePointer2 },
  { tool: "hand", label: "Hand", key: "h", icon: Hand },
  { tool: "box", label: "Box", key: "b", icon: BoxIcon },
];

/** What each tool does and its modifiers, shown in the info-label. */
export const HINTS: Record<Tool, string> = {
  select: `click to select (Shift adds) · drag a box to move it (Alt copies, Alt+J repeats) · ⇧X/⇧Z mirror · drag empty ground to marquee · ${MOD}A all · Space to pan`,
  hand: "drag to pan · scroll to zoom · A/D or ←/→ to rotate",
  box: `drag to draw · Shift square · Alt from center · ${MOD} no snap · Esc to cancel`,
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

const KINDS: { kind: BoxKind; label: string; icon: LucideIcon }[] = [
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
  children,
}: {
  kind: BoxKind | null;
  kindDisabled?: boolean;
  onKind: (kind: BoxKind) => void;
  color: BoxColor | null;
  onColor: (color: BoxColor) => void;
  /** Shows the X / Z mirror buttons (the Select tool). */
  onMirror?: (axis: MirrorAxis) => void;
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
            title={kindDisabled ? `${label}: select a single box to change its kind` : label}
            onClick={() => onKind(k)}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>
      <span className="sep" />
      <div className="swatches">
        {BOX_COLORS.map((c) => (
          <button
            key={c}
            className={c === color ? "swatch active" : "swatch"}
            style={{ background: PALETTE[c] }}
            title={c}
            onClick={() => onColor(c)}
          />
        ))}
      </div>
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

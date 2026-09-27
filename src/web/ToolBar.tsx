import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  Box as BoxIcon,
  BrickWall,
  Circle,
  Cylinder,
  FlipHorizontal2,
  Hand,
  Minus,
  MousePointer2,
  MoveHorizontal,
  MoveRight,
  PenTool,
  Plus,
  Pyramid,
  SquareRoundCorner,
  Spline,
  Redo2,
  Rotate3d,
  Square,
  SquareDashed,
  SquareDot,
  Trash2,
  Undo2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { MirrorAxis } from "../shared/geometry";
import {
  DEFAULT_RAMP_WIDTH,
  DEFAULT_WALL,
  MAX_SIDES,
  MAX_THICKNESS,
  MIN_SIDES,
  MIN_THICKNESS,
  MIN_RAMP_WIDTH,
  MIN_STEP,
  MIN_WALL,
  PALETTE,
  SHAPE_COLORS,
  type HistorySummary,
  type LineArrow,
  type ShapeColor,
  type ShapeKind,
} from "../shared/scene.types";
import { Stairs } from "./icons";
import type { LineStyle, RampStyle, Tool } from "./Viewport";

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export const TOOLS: { tool: Tool; label: string; key: string; icon: LucideIcon }[] = [
  { tool: "select", label: "Select", key: "v", icon: MousePointer2 },
  { tool: "hand", label: "Hand", key: "h", icon: Hand },
  { tool: "box", label: "Box", key: "b", icon: BoxIcon },
  { tool: "cylinder", label: "Cylinder", key: "c", icon: Cylinder },
  { tool: "pen", label: "Pen (free-form)", key: "p", icon: PenTool },
  { tool: "line", label: "Line", key: "l", icon: Waypoints },
  { tool: "ramp", label: "Ramp (and stairs)", key: "r", icon: Stairs },
];

/** What each tool does and its modifiers, shown in the info-label. */
export const HINTS: Record<Tool, string> = {
  select: `click to select (Shift adds) · drag a box to move it (Alt copies, Alt+J repeats) · ⇧X/⇧Z mirror · drag empty ground to marquee · ${MOD}A all · Space to pan`,
  hand: "drag to pan · scroll to zoom · A/D or ←/→ to rotate",
  box: `drag to draw · Shift square · Alt from center · ${MOD} no snap · Esc to cancel`,
  cylinder: `drag to draw · Shift circle · Alt from center · ${MOD} no snap · Esc to cancel`,
  pen: `click for a corner · drag for a curve · click the first point or Enter to close · ⌫ removes the last point · ${MOD} no snap · Esc to cancel`,
  line: `click to place a point on the surface under the cursor · drag for a curve · double-click or Enter to finish · ⌫ removes the last point · ${MOD} no snap · Esc to cancel`,
  ramp: `click on the floor, then on the top it climbs to (each point on the surface under the cursor) · drag for a curve · double-click or Enter to finish · ⌫ removes the last point · ${MOD} no snap · Esc to cancel`,
};

/** The hint while editing a free-form's points (the Select tool, after double-clicking it). */
export const EDIT_POINTS_HINT =
  `drag a point or handle (Alt breaks a smooth point; a line's point: its green arrow raises it) · Shift-click adds points · click an edge to add a point · ` +
  `double-click a point: corner ↔ smooth · ⌫ deletes points · ${MOD} no snap · Esc or click outside to finish`;

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
  { kind: "hole", label: "Hole (cuts the shapes in its group and its sibling groups)", icon: SquareDot },
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
  wall,
  profile,
  tilt,
  onConvert,
  editPoints,
  line,
  ramp,
  children,
}: {
  kind: ShapeKind | null;
  kindDisabled?: boolean;
  /** Shows the kind toggle (not for lines, which have no kind). */
  onKind?: (kind: ShapeKind) => void;
  color: ShapeColor | null;
  onColor: (color: ShapeColor) => void;
  /** Shows the X / Z mirror buttons (the Select tool). */
  onMirror?: (axis: MirrorAxis) => void;
  /** Shows the sides control (the Cylinder tool, a selected cylinder): the side count, undefined = smooth. */
  sides?: { value: number | undefined; onChange: (sides: number | undefined) => void };
  /** Shows the wall control (rooms): the thickness in meters, undefined when the selected rooms differ. */
  wall?: { value: number | undefined; onChange: (wall: number) => void };
  /** Shows the taper and bevel sliders (volumes): each value, undefined when the selected volumes differ. */
  profile?: { taper: number | undefined; bevel: number | undefined; onChange: (patch: { taper?: number; bevel?: number }) => void };
  /** Shows the pitch and roll fields and Reset tilt (box and cylinder volumes): each value, undefined when they differ. */
  tilt?: { pitch: number | undefined; roll: number | undefined; onChange: (patch: { pitch?: number; roll?: number }) => void };
  /** Shows Convert to free-form (the selection has boxes or cylinders). */
  onConvert?: () => void;
  /** Shows Edit points (a single free-form or line is selected): whether it's in point editing, and a toggle. */
  editPoints?: { active: boolean; onToggle: () => void };
  /** Shows the line controls (the Line tool, selected lines): thickness, dashes, arrows, and Reverse if given. */
  line?: { style: Partial<LineStyle>; onChange: (patch: Partial<LineStyle>) => void; onReverse?: () => void };
  /** Shows the ramp controls (the Ramp tool, selected ramps): kind, width, steps and base, and Reverse if given. */
  ramp?: { style: Partial<RampStyle>; onChange: (patch: Partial<RampStyle>) => void; onReverse?: () => void };
  children?: ReactNode;
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
      {sides && (
        <>
          <span className="sep" />
          <SidesControl {...sides} />
        </>
      )}
      {wall && (
        <>
          <span className="sep" />
          <WallControl {...wall} />
        </>
      )}
      {profile && (
        <>
          <span className="sep" />
          <FractionSlider
            icon={Pyramid}
            title="Taper: how much the top shrinks toward the center (1 = a point)"
            value={profile.taper}
            onChange={(taper) => profile.onChange({ taper })}
          />
          <FractionSlider
            icon={SquareRoundCorner}
            title="Bevel: how round the top edge is (1 = as round as it fits)"
            value={profile.bevel}
            onChange={(bevel) => profile.onChange({ bevel })}
          />
        </>
      )}
      {line && (
        <>
          <span className="sep" />
          <LineControls {...line} />
        </>
      )}
      {ramp && (
        <>
          <span className="sep" />
          <RampControls {...ramp} />
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
      {tilt && (
        <>
          <span className="sep" />
          <TiltControl {...tilt} />
        </>
      )}
      {(onConvert || editPoints) && (
        <>
          <span className="sep" />
          {onConvert && (
            <button className="labeled" title="Convert to free-form: its outline becomes points you can edit (a new ID)" onClick={onConvert}>
              <Spline size={16} /> Convert to free-form
            </button>
          )}
          {editPoints && (
            <button
              className={editPoints.active ? "labeled active" : "labeled"}
              title={editPoints.active ? "Finish editing points (Esc)" : "Edit points (or double-click the shape)"}
              onClick={editPoints.onToggle}
            >
              <Spline size={16} /> {editPoints.active ? "Done" : "Edit points"}
            </button>
          )}
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

/** The wall control's − / + step, in meters. */
const WALL_STEP = 0.05;

/**
 * A room's wall thickness: a wall icon, − / a field in meters / +. The buttons step by 0.05 m; typing a value and
 * pressing Enter (or leaving the field) sets it, at least MIN_WALL. A value that differs across the selection
 * shows as not set, and − / + then start from the default.
 */
function WallControl({ value, onChange }: { value: number | undefined; onChange: (wall: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const set = (n: number) => onChange(Math.max(MIN_WALL, Math.round(n * 100) / 100));
  const commit = () => {
    if (!cancelled.current && text !== null && text.trim() !== "" && Number.isFinite(Number(text))) set(Number(text));
    cancelled.current = false;
    setText(null);
  };
  const current = value ?? DEFAULT_WALL;
  return (
    <div className="sides wall" title="Wall thickness, grown inward from the outline">
      <BrickWall size={16} className="label-icon" />
      <button title="Thinner walls" disabled={value !== undefined && value <= MIN_WALL} onClick={() => set(current - WALL_STEP)}>
        <Minus size={14} />
      </button>
      <input
        type="text"
        inputMode="decimal"
        className="count"
        title={`Wall thickness in meters, at least ${MIN_WALL}`}
        value={text ?? (value === undefined ? "" : `${value} m`)}
        placeholder="–"
        onFocus={() => setText(value === undefined ? "" : String(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancelled.current = true;
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <button title="Thicker walls" onClick={() => set(current + WALL_STEP)}>
        <Plus size={14} />
      </button>
    </div>
  );
}

/**
 * A 0..1 slider in steps of 0.05, with an icon and its value. It sends the value on release, so dragging it is one
 * step. A value that differs across the selection shows as not set.
 */
function FractionSlider({ icon: Icon, title, value, onChange }: { icon: LucideIcon; title: string; value: number | undefined; onChange: (v: number) => void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value ?? 0;
  const commit = () => {
    if (dragging !== null && dragging !== value) onChange(dragging);
    setDragging(null);
  };
  return (
    <label className="fraction" title={title}>
      <Icon size={16} className="label-icon" />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={shown}
        onChange={(e) => setDragging(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="value">{value === undefined && dragging === null ? "–" : shown.toFixed(2)}</span>
    </label>
  );
}

/** The tilt fields' − / + step, in degrees (the rings' snap). */
const TILT_STEP = 15;

/** A degrees field with − / + in 15° steps: typing a value and pressing Enter (or leaving the field) sets it. */
function AngleField({ label, title, value, onChange }: { label: string; title: string; value: number | undefined; onChange: (deg: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    if (!cancelled.current && text !== null && text.trim() !== "" && Number.isFinite(Number(text))) onChange(Number(text));
    cancelled.current = false;
    setText(null);
  };
  const current = value ?? 0;
  return (
    <div className="sides angle" title={title}>
      <span className="label">{label}</span>
      <button title={`${label} −${TILT_STEP}°`} onClick={() => onChange(current - TILT_STEP)}>
        <Minus size={14} />
      </button>
      <input
        type="text"
        inputMode="decimal"
        className="count"
        value={text ?? (value === undefined ? "" : `${value}°`)}
        placeholder="–"
        onFocus={() => setText(value === undefined ? "" : String(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancelled.current = true;
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <button title={`${label} +${TILT_STEP}°`} onClick={() => onChange(current + TILT_STEP)}>
        <Plus size={14} />
      </button>
    </div>
  );
}

/**
 * A box's or cylinder's tilt: pitch (around its own x axis, + leans the top toward its +z) and roll (around its own
 * z axis), in degrees, and Reset tilt, which levels it (both 0) in one step.
 */
function TiltControl({ pitch, roll, onChange }: { pitch: number | undefined; roll: number | undefined; onChange: (patch: { pitch?: number; roll?: number }) => void }) {
  const level = pitch === 0 && roll === 0;
  return (
    <div className="tilt">
      <AngleField label="pitch" title="Pitch: degrees around the shape's own x axis (the red ring)" value={pitch} onChange={(p) => onChange({ pitch: p })} />
      <AngleField label="roll" title="Roll: degrees around the shape's own z axis (the blue ring)" value={roll} onChange={(r) => onChange({ roll: r })} />
      <button className="labeled" disabled={level} title="Reset tilt: level it again (pitch and roll 0)" onClick={() => onChange({ pitch: 0, roll: 0 })}>
        <Rotate3d size={16} /> Reset tilt
      </button>
    </div>
  );
}

/**
 * A ramp's shape: volume or hole, its width (− / meters / +, in 0.25 m steps), smooth or stepped (with the riser
 * height, − / meters / +, in 0.05 m steps), and a solid or floating base. A value that differs across the selection
 * shows as not set.
 */
function RampControls({
  style,
  onChange,
  onReverse,
}: {
  style: Partial<RampStyle>;
  onChange: (patch: Partial<RampStyle>) => void;
  onReverse?: () => void;
}) {
  const stepped = style.step !== undefined;
  return (
    <div className="ramp-controls">
      <div className="segmented">
        {KINDS.filter((k) => k.kind !== "room").map(({ kind: k, label, icon: Icon }) => (
          <button key={k} className={style.kind === k ? "active" : ""} title={label} onClick={() => onChange({ kind: k as RampStyle["kind"] })}>
            <Icon size={16} />
          </button>
        ))}
      </div>
      <MetersField
        label="width"
        title="Width, centered on the path"
        value={style.width}
        step={0.25}
        min={MIN_RAMP_WIDTH}
        fallback={DEFAULT_RAMP_WIDTH}
        onChange={(width) => onChange({ width })}
      />
      <button
        className={stepped ? "labeled" : "labeled active"}
        title="Smooth: a ramp, no steps"
        onClick={() => onChange({ step: undefined })}
      >
        smooth
      </button>
      <MetersField
        label="steps"
        title="The riser height: stairs"
        value={style.step}
        step={0.05}
        min={MIN_STEP}
        fallback={DEFAULT_STEP}
        onChange={(step) => onChange({ step })}
      />
      <div className="segmented">
        {(["solid", "floating"] as const).map((base) => (
          <button
            key={base}
            className={style.base === base ? "active labeled" : "labeled"}
            title={base === "solid" ? "Solid: filled down to its lowest point" : "Floating: a slab under the surface"}
            onClick={() => onChange({ base })}
          >
            {base}
          </button>
        ))}
      </div>
      {onReverse && (
        <button className="labeled" title="Reverse: the ramp runs the other way (the same shape)" onClick={onReverse}>
          <ArrowLeftRight size={16} /> Reverse
        </button>
      )}
    </div>
  );
}

/** The step a stepped ramp starts from (from smooth, − or + switch to it). */
const DEFAULT_STEP = 0.2;

/** A meters field with − / +: typing a value and pressing Enter (or leaving the field) sets it, at least `min`. */
function MetersField({
  label,
  title,
  value,
  step,
  min,
  fallback,
  onChange,
}: {
  label: string;
  title: string;
  value: number | undefined;
  step: number;
  min: number;
  fallback?: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const set = (n: number) => onChange(Math.max(min, Math.round(n * 100) / 100));
  const commit = () => {
    if (!cancelled.current && text !== null && text.trim() !== "" && Number.isFinite(Number(text))) set(Number(text));
    cancelled.current = false;
    setText(null);
  };
  const current = value ?? fallback;
  return (
    <div className="sides angle" title={title}>
      <span className="label">{label}</span>
      <button title={`${label} −${step}`} onClick={() => set(current === undefined ? min : value === undefined ? current : current - step)}>
        <Minus size={14} />
      </button>
      <input
        type="text"
        inputMode="decimal"
        className="count"
        value={text ?? (value === undefined ? "" : `${value} m`)}
        placeholder="–"
        onFocus={() => setText(value === undefined ? "" : String(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancelled.current = true;
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <button title={`${label} +${step}`} onClick={() => set(current === undefined ? min : value === undefined ? current : current + step)}>
        <Plus size={14} />
      </button>
    </div>
  );
}

const ARROWS: { arrow: LineArrow; label: string; icon: LucideIcon }[] = [
  { arrow: "none", label: "No arrows", icon: Minus },
  { arrow: "end", label: "Arrow at the end", icon: MoveRight },
  { arrow: "both", label: "Arrows at both ends", icon: MoveHorizontal },
];

/**
 * A line's style: a thickness slider (screen pixels), a dashes toggle, the arrow choice and, for selected lines,
 * Reverse (which flips the arrow's direction). A value that differs across the selection shows as not set. The
 * slider sends its value on release, so dragging it is one step.
 */
function LineControls({ style, onChange, onReverse }: { style: Partial<LineStyle>; onChange: (patch: Partial<LineStyle>) => void; onReverse?: () => void }) {
  // The slider's value while it's being dragged; null = show the style's.
  const [dragging, setDragging] = useState<number | null>(null);
  const thickness = dragging ?? style.thickness ?? MIN_THICKNESS;
  const commit = () => {
    if (dragging !== null && dragging !== style.thickness) onChange({ thickness: dragging });
    setDragging(null);
  };
  return (
    <div className="line-controls">
      <label className="thickness" title={`Thickness: ${thickness} px on screen`}>
        <input
          type="range"
          min={MIN_THICKNESS}
          max={MAX_THICKNESS}
          step={1}
          value={thickness}
          onChange={(e) => setDragging(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <span className="value">{style.thickness === undefined && dragging === null ? "–" : `${thickness} px`}</span>
      </label>
      <button className={style.dashed ? "labeled active" : "labeled"} title="Dashed" onClick={() => onChange({ dashed: !style.dashed })}>
        - - -
      </button>
      <div className="segmented">
        {ARROWS.map(({ arrow, label, icon: Icon }) => (
          <button key={arrow} className={style.arrow === arrow ? "active" : ""} title={label} onClick={() => onChange({ arrow })}>
            <Icon size={16} />
          </button>
        ))}
      </div>
      {onReverse && (
        <button className="labeled" title="Reverse: the line runs the other way (so does its arrow)" onClick={onReverse}>
          <ArrowLeftRight size={16} /> Reverse
        </button>
      )}
    </div>
  );
}

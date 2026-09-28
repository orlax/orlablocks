import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Circle,
  FlipHorizontal2,
  GripVertical,
  Minus,
  MoveHorizontal,
  MoveRight,
  Plus,
  Rotate3d,
  Spline,
  type LucideIcon,
} from "lucide-react";
import type { MirrorAxis } from "../shared/geometry";
import {
  DEFAULT_RAMP_WIDTH,
  DEFAULT_WALL,
  MAX_SIDES,
  MAX_THICKNESS,
  MIN_RAMP_WIDTH,
  MIN_SIDES,
  MIN_STEP,
  MIN_THICKNESS,
  MIN_WALL,
  MAX_DESCRIPTION,
  type LineArrow,
} from "../shared/scene.types";
import type { LineStyle, RampStyle } from "./Viewport";

/**
 * The inspector: a floating panel with the fields of what's selected (or of the drawing tool's next shape), grouped
 * in sections, and the selection's actions (mirror, convert, edit points). The contextual bar keeps only the kind
 * and the colors. It's dragged by its header, collapses to it, and remembers both per viewer; it's kept on screen.
 * Sliders preview while dragged (`onPreview`) and send one step on release; fields send on Enter or blur.
 */

/** A value being previewed (a slider held), or null when the preview ends without a change. */
export type Preview<T> = (patch: T | null) => void;

export type InspectorProps = {
  /** What it shows: `lobby (box_3)`, `3 selected`, `next box`. */
  title: string;
  /** The read-only numbers (`6 × 4 × 3 m · wall 0.2 · y 0 · 0°`). */
  info?: string;
  /** A single group's description: what that part of the level is, for people and the agent. */
  description?: { value: string; onChange: (text: string) => void };
  /** A cylinder's sides: the side count, undefined = smooth. */
  sides?: { value: number | undefined; onChange: (sides: number | undefined) => void };
  /** Rooms: the wall thickness in meters, undefined when the selected rooms differ. */
  wall?: { value: number | undefined; onChange: (wall: number) => void };
  /** Volumes and holes: taper and bevel, each undefined when they differ. */
  profile?: {
    taper: number | undefined;
    bevel: number | undefined;
    onChange: (patch: { taper?: number; bevel?: number }) => void;
    onPreview?: Preview<{ taper?: number; bevel?: number }>;
  };
  /** Box and cylinder volumes and holes: pitch and roll, each undefined when they differ. */
  tilt?: { pitch: number | undefined; roll: number | undefined; onChange: (patch: { pitch?: number; roll?: number }) => void };
  /** Lines: thickness, dashes, arrows, and Reverse if given. */
  line?: { style: Partial<LineStyle>; onChange: (patch: Partial<LineStyle>) => void; onPreview?: Preview<{ thickness: number }>; onReverse?: () => void };
  /** Ramps: width, steps and base, and Reverse if given. */
  ramp?: { style: Partial<RampStyle>; onChange: (patch: Partial<RampStyle>) => void; onReverse?: () => void };
  /** The X / Z mirror buttons (the Select tool). */
  onMirror?: (axis: MirrorAxis) => void;
  /** Convert to free-form (the selection has boxes or cylinders). */
  onConvert?: () => void;
  /** Edit points (a single free-form, line or ramp): whether it's in point editing, and a toggle. */
  editPoints?: { active: boolean; onToggle: () => void };
};

export function Inspector({ title, info, description, sides, wall, profile, tilt, line, ramp, onMirror, onConvert, editPoints }: InspectorProps) {
  const { ref, header, style, collapsed, toggle } = useFloating();
  const actions = onMirror || onConvert || editPoints;
  return (
    <div className={collapsed ? "inspector collapsed" : "inspector"} ref={ref} style={style}>
      <div className="inspector-header" {...header} title="Drag to move the inspector · double-click to put it back">
        <GripVertical size={13} className="grip" />
        <span className="inspector-title">{title}</span>
        <button type="button" className="inspector-collapse" title={collapsed ? "Show the fields" : "Collapse"} onClick={toggle}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {!collapsed && (
        <div className="inspector-body">
          {info && <div className="inspector-info">{info}</div>}
          {description && (
            <Section label="Description">
              <DescriptionField {...description} />
            </Section>
          )}
          {sides && (
            <Section label="Shape">
              <Row label="sides">
                <SidesControl {...sides} />
              </Row>
            </Section>
          )}
          {wall && (
            <Section label="Walls">
              <Row label="thickness">
                <NumberField
                  title={`Wall thickness in meters, grown inward from the outline (at least ${MIN_WALL})`}
                  value={wall.value}
                  unit="m"
                  step={0.05}
                  min={MIN_WALL}
                  fallback={DEFAULT_WALL}
                  onChange={wall.onChange}
                />
              </Row>
            </Section>
          )}
          {profile && (
            <Section label="Profile">
              <Row label="taper">
                <Slider
                  title="Taper: how much the top shrinks toward the center (1 = a point)"
                  value={profile.taper}
                  onChange={(taper) => profile.onChange({ taper })}
                  onPreview={profile.onPreview && ((taper) => profile.onPreview!(taper === null ? null : { taper }))}
                />
              </Row>
              <Row label="bevel">
                <Slider
                  title="Bevel: how round the top edge is (1 = as round as it fits)"
                  value={profile.bevel}
                  onChange={(bevel) => profile.onChange({ bevel })}
                  onPreview={profile.onPreview && ((bevel) => profile.onPreview!(bevel === null ? null : { bevel }))}
                />
              </Row>
            </Section>
          )}
          {tilt && <TiltSection {...tilt} />}
          {ramp && <RampSection {...ramp} />}
          {line && <LineSection {...line} />}
          {actions && (
            <Section label="Actions">
              <div className="inspector-actions">
                {onMirror &&
                  MIRRORS.map(({ axis, title }) => (
                    <button key={axis} className={`mirror ${axis}`} title={title} onClick={() => onMirror(axis)}>
                      <FlipHorizontal2 size={16} />
                      <span className="axis">{axis.toUpperCase()}</span>
                    </button>
                  ))}
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
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="inspector-section">
      <div className="inspector-section-label">{label}</div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inspector-row">
      <span className="inspector-label">{label}</span>
      <div className="inspector-control">{children}</div>
    </div>
  );
}

// ---- Floating ----

const STORE_KEY = "dungeon-designer.inspector";
type Placement = { x?: number; y?: number; collapsed?: boolean };

function loadPlacement(): Placement {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
function savePlacement(p: Placement) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    // No storage (a private window, blocked site data): the placement lasts for this tab only.
  }
}

/**
 * The panel's placement: where the header was dragged to (none = its place in the stylesheet, top right), and
 * whether it's collapsed. The header always stays inside the window, also when the window shrinks.
 */
function useFloating() {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>(loadPlacement);
  const grab = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

  const clamp = (x: number, y: number) => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.querySelector<HTMLElement>(".inspector-header")?.offsetHeight ?? 32;
    return { x: Math.round(Math.min(Math.max(0, x), Math.max(0, innerWidth - w))), y: Math.round(Math.min(Math.max(0, y), Math.max(0, innerHeight - h))) };
  };

  // Back on screen after a resize (or a placement saved on a bigger window).
  useLayoutEffect(() => {
    const fit = () =>
      setPlacement((p) => {
        if (p.x === undefined || p.y === undefined) return p;
        const c = clamp(p.x, p.y);
        return c.x === p.x && c.y === p.y ? p : { ...p, ...c };
      });
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);
  // Saved as it changes (a drag writes a few small values per frame).
  useEffect(() => savePlacement(placement), [placement]);

  const header = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      const r = ref.current!.getBoundingClientRect();
      grab.current = { pointerId: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = grab.current;
      if (!g || g.pointerId !== e.pointerId) return;
      setPlacement((p) => ({ ...p, ...clamp(e.clientX - g.dx, e.clientY - g.dy) }));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (grab.current?.pointerId === e.pointerId) grab.current = null;
    },
    onPointerCancel: () => void (grab.current = null),
    onDoubleClick: (e: ReactMouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("button")) return;
      setPlacement({ collapsed: placement.collapsed });
    },
  };
  const style = placement.x !== undefined && placement.y !== undefined ? { left: placement.x, top: placement.y, right: "auto" } : undefined;
  return { ref, header, style, collapsed: !!placement.collapsed, toggle: () => setPlacement({ ...placement, collapsed: !placement.collapsed }) };
}

// ---- Fields ----

const MIRRORS: { axis: MirrorAxis; title: string }[] = [
  { axis: "x", title: "Mirror on X (⇧X): swap east and west, across the selection's center" },
  { axis: "z", title: "Mirror on Z (⇧Z): swap +z and -z, across the selection's center" },
];

/**
 * A field for a number, with − / +: typing a value and pressing Enter (or leaving the field) sets it, Esc cancels.
 * Values keep 2 decimals and stay at least `min`. A value that differs across the selection shows as not set, and
 * − / + then start from `fallback`.
 */
function NumberField({
  title,
  value,
  unit,
  step,
  min,
  fallback,
  onChange,
}: {
  title: string;
  value: number | undefined;
  unit: string;
  step: number;
  min?: number;
  fallback: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const set = (n: number) => onChange(Math.max(min ?? -Infinity, Math.round(n * 100) / 100));
  const commit = () => {
    if (!cancelled.current && text !== null && text.trim() !== "" && Number.isFinite(Number(text))) set(Number(text));
    cancelled.current = false;
    setText(null);
  };
  const stepBy = (d: number) => set(value === undefined ? fallback : value + d);
  return (
    <div className="stepper" title={title}>
      <button title={`−${step}`} disabled={min !== undefined && value !== undefined && value <= min} onClick={() => stepBy(-step)}>
        <Minus size={14} />
      </button>
      <input
        type="text"
        inputMode="decimal"
        className="count"
        value={text ?? (value === undefined ? "" : `${value}${unit === "°" ? "°" : ` ${unit}`}`)}
        placeholder="–"
        onFocus={() => setText(value === undefined ? "" : String(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancelled.current = true;
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <button title={`+${step}`} onClick={() => stepBy(step)}>
        <Plus size={14} />
      </button>
    </div>
  );
}

/**
 * A group's description: free text, sent when the field is left (or on ⌘Enter / Ctrl+Enter); Esc cancels. Enter
 * alone starts a new line.
 */
function DescriptionField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    if (!cancelled.current && text !== null && text.trim() !== value) onChange(text.trim());
    cancelled.current = false;
    setText(null);
  };
  return (
    <textarea
      className="description"
      rows={3}
      maxLength={MAX_DESCRIPTION}
      title="What this part of the level is, for you and the agent (it shows in the agent's outline). ⌘Enter to set, Esc to cancel"
      placeholder="What this part of the level is: entry hall, safe zone…"
      value={text ?? value}
      onFocus={() => setText(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancelled.current = true;
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) e.currentTarget.blur();
      }}
    />
  );
}

/**
 * A slider with its value: it previews while dragged (`onPreview`) and sends the value on release, so dragging it
 * is one step. A value that differs across the selection shows as not set.
 */
function Slider({
  title,
  value,
  min = 0,
  max = 1,
  step = 0.05,
  format = (v) => v.toFixed(2),
  onChange,
  onPreview,
}: {
  title: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onPreview?: (v: number | null) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value ?? min;
  const commit = () => {
    if (dragging === null) return;
    if (dragging !== value) onChange(dragging);
    else onPreview?.(null);
    setDragging(null);
  };
  return (
    <label className="slider" title={title}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDragging(v);
          onPreview?.(v);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="value">{value === undefined && dragging === null ? "–" : format(shown)}</span>
    </label>
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
    <div className="stepper">
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

/**
 * A box's or cylinder's tilt: pitch (around its own x axis, + leans the top toward its +z) and roll (around its own
 * z axis), in degrees with − / + in 15° steps (the rings' snap), and Reset tilt, which levels it in one step.
 */
function TiltSection({ pitch, roll, onChange }: NonNullable<InspectorProps["tilt"]>) {
  const level = pitch === 0 && roll === 0;
  return (
    <Section label="Tilt">
      <Row label="pitch">
        <NumberField title="Pitch: degrees around the shape's own x axis (the red ring)" value={pitch} unit="°" step={15} fallback={0} onChange={(p) => onChange({ pitch: p })} />
      </Row>
      <Row label="roll">
        <NumberField title="Roll: degrees around the shape's own z axis (the blue ring)" value={roll} unit="°" step={15} fallback={0} onChange={(r) => onChange({ roll: r })} />
      </Row>
      <Row label="">
        <button className="labeled" disabled={level} title="Reset tilt: level it again (pitch and roll 0)" onClick={() => onChange({ pitch: 0, roll: 0 })}>
          <Rotate3d size={16} /> Reset tilt
        </button>
      </Row>
    </Section>
  );
}

/** The step a stepped ramp starts from (from smooth, − or + switch to it). */
const DEFAULT_STEP = 0.2;

/**
 * A ramp's shape: its width (in 0.25 m steps), smooth or stepped (with the riser height, in 0.05 m steps), and a
 * solid or floating base.
 */
function RampSection({ style, onChange, onReverse }: NonNullable<InspectorProps["ramp"]>) {
  const stepped = style.step !== undefined;
  return (
    <Section label="Ramp">
      <Row label="width">
        <NumberField
          title="Width, centered on the path"
          value={style.width}
          unit="m"
          step={0.25}
          min={MIN_RAMP_WIDTH}
          fallback={DEFAULT_RAMP_WIDTH}
          onChange={(width) => onChange({ width })}
        />
      </Row>
      <Row label="surface">
        <button className={stepped ? "labeled" : "labeled active"} title="Smooth: a ramp, no steps" onClick={() => onChange({ step: undefined })}>
          smooth
        </button>
      </Row>
      <Row label="steps">
        <NumberField title="The riser height: stairs" value={style.step} unit="m" step={0.05} min={MIN_STEP} fallback={DEFAULT_STEP} onChange={(step) => onChange({ step })} />
      </Row>
      <Row label="base">
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
      </Row>
      {onReverse && (
        <Row label="">
          <button className="labeled" title="Reverse: the ramp runs the other way (the same shape)" onClick={onReverse}>
            <ArrowLeftRight size={16} /> Reverse
          </button>
        </Row>
      )}
    </Section>
  );
}

const ARROWS: { arrow: LineArrow; label: string; icon: LucideIcon }[] = [
  { arrow: "none", label: "No arrows", icon: Minus },
  { arrow: "end", label: "Arrow at the end", icon: MoveRight },
  { arrow: "both", label: "Arrows at both ends", icon: MoveHorizontal },
];

/** A line's style: its thickness (screen pixels), dashes, arrows and, for selected lines, Reverse (which flips the arrow). */
function LineSection({ style, onChange, onPreview, onReverse }: NonNullable<InspectorProps["line"]>) {
  return (
    <Section label="Line">
      <Row label="thickness">
        <Slider
          title="Thickness on screen"
          value={style.thickness}
          min={MIN_THICKNESS}
          max={MAX_THICKNESS}
          step={1}
          format={(v) => `${v} px`}
          onChange={(thickness) => onChange({ thickness })}
          onPreview={onPreview && ((thickness) => onPreview(thickness === null ? null : { thickness }))}
        />
      </Row>
      <Row label="dashes">
        <button className={style.dashed ? "labeled active" : "labeled"} title="Dashed" onClick={() => onChange({ dashed: !style.dashed })}>
          - - -
        </button>
      </Row>
      <Row label="arrows">
        <div className="segmented">
          {ARROWS.map(({ arrow, label, icon: Icon }) => (
            <button key={arrow} className={style.arrow === arrow ? "active" : ""} title={label} onClick={() => onChange({ arrow })}>
              <Icon size={16} />
            </button>
          ))}
        </div>
      </Row>
      {onReverse && (
        <Row label="">
          <button className="labeled" title="Reverse: the line runs the other way (so does its arrow)" onClick={onReverse}>
            <ArrowLeftRight size={16} /> Reverse
          </button>
        </Row>
      )}
    </Section>
  );
}

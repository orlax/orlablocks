import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Link,
  Ellipsis,
  Slash,
  Sparkles,
  Square,
  SquareDashedBottom,
  Squircle,
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
  Dices,
  X,
  Grid3x3,
  Rotate3d,
  Spline,
  Package,
  PencilRuler,
  Scaling,
  Unlink,
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
  MAX_NOTE_LABEL,
  MAX_NOTE_TEXT,
  MAX_ARRAY_ENTITIES,
  MAX_ARRAY_ITEMS,
  MAX_SCALE,
  MIN_ARRAY_SPACING,
  MIN_SCALE,
  type ArrayFacing,
  type ArrayLayout,
  type ArrayLayoutType,
  type ArrayPlace,
  type LineArrow,
  type NoteStatus,
} from "../shared/scene.types";
import { currentTags, type EntityMeta, type Library } from "../shared/library";
import { useFloating } from "./floating";
import { EntityPicker } from "./EntityPicker";
import { RefTextArea, TagsField } from "./RefText";
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
  /** What the node is linked to (13.4): what it stands on, what a line goes through; Unlink keeps what it has now. */
  links?: { label: string; value: string; title: string; unlinkTitle: string; onUnlink: () => void }[];
  /** What it shows: `lobby (box_3)`, `3 selected`, `next box`. */
  title: string;
  /** The read-only numbers (`6 × 4 × 3 m · wall 0.2 · y 0 · 0°`). */
  info?: string;
  /** The project library, for the description's references and the tags field. */
  library?: Library | null;
  /**
   * A single note: its text (with references), its label (the letters on its flag) and whether it's done. `focus`
   * puts the caret in the text (a note just placed), once.
   */
  note?: {
    text: string;
    label: string;
    status: NoteStatus;
    focus: boolean;
    onFocused: () => void;
    onChange: (patch: { text?: string; label?: string | null; status?: NoteStatus }) => void;
  };
  /**
   * A single instance: its entity (a picker over every entity, to swap it), that entity's description and tags
   * (the entity's, not the instance's), and Detach.
   */
  instance?: {
    entity: string;
    entities: EntityMeta[];
    onSwap: (entity: string) => void;
    onDetach: () => void;
    /** Edit entity: open its definition (every instance follows the edits). */
    onEdit: () => void;
    /** Array (10.1): the instance becomes an array of its entity, its first item where the instance is. */
    onArray?: () => void;
  };
  /** A single array (10.1): its entities, its layout's fields, how its items turn, Edit entity and Detach. */
  array?: ArrayControls;
  /** Make entity (the selection has shapes, and no instances or notes): with the name to give it. */
  makeEntity?: { suggested: string; onMake: (name: string) => void };
  /** A single group's description: what that part of the level is, for people and the agent. */
  description?: { value: string; onChange: (text: string) => void };
  /** A single group's or shape's tags (not a line's), and adding a new tag to the library and to it. */
  tags?: { value: string[]; onChange: (tags: string[]) => void; onCreate: (name: string) => void };
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
  /** Instances and arrays (14.3): their uniform scale, undefined when they differ. */
  scale?: { value: number | undefined; onChange: (scale: number) => void };
  /** Scale… (14.3): the whole selection scaled by a factor about the bottom center of its bounds. */
  onScaleBy?: (factor: number) => void;
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
  editPoints?: { active: boolean; onToggle: () => void; label?: string };
};

/** What the inspector's array section shows and changes (see `ArraySection`). */
export type ArrayControls = {
  entities: { entity: string; weight?: number }[];
  library: EntityMeta[];
  layout: ArrayLayout;
  /** The facing in effect (the layout's default when the array has none). */
  facing: ArrayFacing;
  rotation: number;
  /** The noise (10.2): meters, ± degrees, and its seed. */
  jitter: number;
  turnJitter: number;
  seed: number;
  /** How many items it has, how many are skipped, and why it has fewer than its layout asks for (or null). */
  items: number;
  skipped: number;
  shortfall: string | null;
  /** The whole new list of entities, with their weights. */
  onEntities: (entities: { entity: string; weight?: number }[]) => void;
  /**
   * A path's follow (10.3): what it follows (its name, and whether it's a closed shape, which has a top and a
   * bottom), or null; whether the view is picking a target; pick, change, unlink.
   */
  follow?: {
    along: { id: string; name?: string; closed: boolean; at: "top" | "bottom"; offset: number } | null;
    picking: boolean;
    onPick: () => void;
    onChange: (patch: { at?: "top" | "bottom"; offset?: number }) => void;
    onUnlink: () => void;
  };
  onLayoutType: (type: ArrayLayoutType) => void;
  onLayout: (patch: Record<string, unknown>) => void;
  onChange: (patch: { facing?: ArrayFacing; rotation?: number; jitter?: number; turnJitter?: number; seed?: number }) => void;
  onEdit: (entity: string) => void;
  onDetach: () => void;
  /** Bring every skipped item back (10.4). */
  onRestoreAll: () => void;
};

export function Inspector({ title, info, library = null, links, note, instance, array, makeEntity, description, tags, sides, wall, profile, scale, onScaleBy, tilt, line, ramp, onMirror, onConvert, editPoints }: InspectorProps) {
  const { ref, header, style, collapsed, toggle } = useFloating("orlablocks.inspector", ".inspector-header");
  const actions = onMirror || onConvert || editPoints || makeEntity || onScaleBy;
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
          {links && links.length > 0 && (
            <Section label="Linked">
              {links.map((link) => (
                <Row key={link.label} label={link.label}>
                  <span className="array-follows" title={link.title}>
                    {link.value}
                  </span>
                  <button className="labeled" title={link.unlinkTitle} onClick={link.onUnlink}>
                    <Unlink size={14} /> Unlink
                  </button>
                </Row>
              ))}
            </Section>
          )}
          {note && <NoteSection {...note} library={library} />}
          {instance && <InstanceSection {...instance} library={library} />}
          {array && library && <ArraySection {...array} lib={library} />}
          {description && (
            <Section label="Description">
              <DescriptionField {...description} library={library} />
            </Section>
          )}
          {tags && (
            <Section label="Tags">
              <TagsField library={library} tags={tags.value} onChange={tags.onChange} onCreate={tags.onCreate} />
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
          {scale && (
            <Section label="Scale">
              <Row label="scale">
                <NumberField
                  title={`Its entity's uniform scale, around its pivot (1 = as defined; ${MIN_SCALE} to ${MAX_SCALE})`}
                  value={scale.value}
                  unit="×"
                  step={0.25}
                  min={MIN_SCALE}
                  fallback={1}
                  onChange={(v) => scale.onChange(Math.min(MAX_SCALE, v))}
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
                    <Spline size={16} /> {editPoints.active ? "Done" : (editPoints.label ?? "Edit points")}
                  </button>
                )}
                {onScaleBy && <ScaleBy onScale={onScaleBy} />}
                {makeEntity && <MakeEntity {...makeEntity} />}
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
function DescriptionField({ value, onChange, library }: { value: string; onChange: (text: string) => void; library: Library | null }) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    if (!cancelled.current && text !== null && text.trim() !== value) onChange(text.trim());
    cancelled.current = false;
    setText(null);
  };
  return (
    <RefTextArea
      library={library}
      className="description"
      rows={3}
      maxLength={MAX_DESCRIPTION}
      title="What this part of the level is, for you and the agent (it shows in the agent's outline). @skill and #tag refer to the library. ⌘Enter to set, Esc to cancel"
      placeholder="What this part of the level is: entry hall, safe zone, a @telekinesis puzzle…"
      value={text ?? value}
      onFocus={() => setText(value)}
      onValue={setText}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") cancelled.current = true;
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) e.currentTarget.blur();
      }}
    />
  );
}

/** Make entity: a button that asks for the entity's name in place, then makes it (Enter) or doesn't (Esc). */
/**
 * Scale… (14.3): a factor for the whole selection, about the bottom center of its bounds, as one step. Everything in
 * meters grows (walls, heights and steps too), as the gizmo's uniform handle does.
 */
function ScaleBy({ onScale }: { onScale: (factor: number) => void }) {
  const [factor, setFactor] = useState<string | null>(null);
  if (factor === null) {
    return (
      <button className="labeled" title="Scale the selection by a factor about the bottom center of its bounds (walls, heights and steps too)" onClick={() => setFactor("2")}>
        <Scaling size={16} /> Scale…
      </button>
    );
  }
  const apply = () => {
    const f = Number(factor);
    if (Number.isFinite(f) && f >= MIN_SCALE && f <= MAX_SCALE && f !== 1) onScale(f);
    setFactor(null);
  };
  return (
    <div className="make-entity">
      <input
        autoFocus
        value={factor}
        inputMode="decimal"
        title="The factor: 2 doubles it, 0.5 halves it (Enter scales, Esc cancels)"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setFactor(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
          if (e.key === "Escape") setFactor(null);
        }}
        onBlur={() => setFactor(null)}
      />
      <button className="labeled primary" onMouseDown={(e) => e.preventDefault()} onClick={apply}>
        ×
      </button>
    </div>
  );
}

function MakeEntity({ suggested, onMake }: { suggested: string; onMake: (name: string) => void }) {
  const [name, setName] = useState<string | null>(null);
  if (name === null) {
    return (
      <button
        className="labeled"
        title="Make entity: these become a prefab in the project library, and one instance of it takes their place"
        onClick={() => setName(suggested)}
      >
        <Package size={16} /> Make entity
      </button>
    );
  }
  const make = () => {
    if (name.trim()) onMake(name.trim());
    setName(null);
  };
  return (
    <div className="make-entity">
      <input
        autoFocus
        value={name}
        placeholder="entity name"
        title="The entity's name (Enter makes it, Esc cancels)"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") make();
          if (e.key === "Escape") setName(null);
        }}
        onBlur={() => setName(null)}
      />
      <button className="labeled primary" onMouseDown={(e) => e.preventDefault()} onClick={make}>
        Make
      </button>
    </div>
  );
}

/** An instance: which entity it shows (swap it), what that entity is (its description and tags), and Detach. */
function InstanceSection({ entity, entities, onSwap, onDetach, onEdit, onArray, library }: NonNullable<InspectorProps["instance"]> & { library: Library | null }) {
  const meta = entities.find((e) => e.id === entity);
  return (
    <Section label="Entity">
      <Row label="shows">
        {library ? (
          <EntityPicker value={entity} library={library} title="Swap: show another entity in the same place" onPick={onSwap} />
        ) : (
          <select className="entity-picker" value={entity} title="Swap: show another entity in the same place" onChange={(e) => onSwap(e.target.value)}>
            {!meta && <option value={entity}>missing: {entity}</option>}
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
      </Row>
      {meta?.description && <p className="entity-description">{meta.description}</p>}
      {meta?.tags && meta.tags.length > 0 && (
        <div className="entity-tags" title="The entity's tags: every instance carries them (edit them in the Library)">
          {currentTags(library ?? { tags: [], skills: [], entities: [], guide: "" }, meta.tags).map((t) => (
            <span key={t} className="chip">
              #{t}
            </span>
          ))}
        </div>
      )}
      <div className="inspector-actions">
        {meta && (
          <button className="labeled" title="Edit entity: change its shapes (or double-click the instance); every instance follows" onClick={onEdit}>
            <PencilRuler size={16} /> Edit entity
          </button>
        )}
        {onArray && (
          <button className="labeled" title="Array: repeat it along a path, around a circle, in a grid or scattered (it becomes the first item)" onClick={onArray}>
            <Grid3x3 size={16} /> Array
          </button>
        )}
        <button className="labeled" title="Detach: turn it into a plain group of shapes you can edit (it stops following the entity)" onClick={onDetach}>
          <Unlink size={16} /> Detach
        </button>
      </div>
    </Section>
  );
}

const LAYOUTS: { type: ArrayLayoutType; icon: LucideIcon; title: string }[] = [
  { type: "path", icon: Spline, title: "Path: along a path (edit its points)" },
  { type: "circle", icon: Circle, title: "Circle: around a circle, or an arc" },
  { type: "grid", icon: Grid3x3, title: "Grid: in rows and columns" },
  { type: "scatter", icon: Sparkles, title: "Scatter: at random in a circle or an area" },
];
const PLACES: { place: ArrayPlace; label: string }[] = [
  { place: "spacing", label: "every … m" },
  { place: "count", label: "a number of" },
  { place: "corners", label: "on the corners" },
  { place: "midpoints", label: "mid-edge" },
];
const FACINGS: Record<ArrayLayoutType, { facing: ArrayFacing; label: string }[]> = {
  path: [
    { facing: "along", label: "along the path" },
    { facing: "fixed", label: "fixed" },
    { facing: "random", label: "random" },
  ],
  circle: [
    { facing: "tangent", label: "along the circle" },
    { facing: "out", label: "out" },
    { facing: "in", label: "in" },
    { facing: "fixed", label: "fixed" },
    { facing: "random", label: "random" },
  ],
  grid: [
    { facing: "fixed", label: "with the grid" },
    { facing: "random", label: "random" },
  ],
  scatter: [
    { facing: "random", label: "random" },
    { facing: "fixed", label: "fixed" },
  ],
};

/**
 * An array's entities (10.2): one row each, with its entity, its weight (and its share of the items) and a remove
 * button while there's more than one; + entity adds a row.
 */
function EntitiesField({ entities, library, onChange }: { entities: ArrayControls["entities"]; library: Library; onChange: ArrayControls["onEntities"] }) {
  const total = entities.reduce((sum, e) => sum + (e.weight ?? 1), 0);
  const set = (i: number, patch: { entity?: string; weight?: number }) =>
    onChange(entities.map((e, k) => (k === i ? { ...e, ...patch, ...(patch.weight === 1 ? { weight: undefined } : {}) } : e)));
  return (
    <div className="array-entities">
      {entities.map((e, i) => {
        return (
          <div key={i} className="array-entity">
            <EntityPicker value={e.entity} library={library} title="The entity these items show" onPick={(entity) => set(i, { entity })} />
            {entities.length > 1 && (
              <>
                <NumberField title="Weight: how often it's chosen among these" value={e.weight ?? 1} unit="" step={1} min={0.1} fallback={1} onChange={(weight) => set(i, { weight })} />
                <span className="array-share" title="Its share of the items">
                  {Math.round(((e.weight ?? 1) / total) * 100)}%
                </span>
                <button className="icon" title="Remove this entity" onClick={() => onChange(entities.filter((_, k) => k !== i))}>
                  <X size={14} />
                </button>
              </>
            )}
          </div>
        );
      })}
      {entities.length < MAX_ARRAY_ENTITIES && (
        <button className="labeled" title="Add an entity: each item shows one of them, chosen by weight" onClick={() => onChange([...entities, { entity: entities[0].entity }])}>
          <Plus size={14} /> entity
        </button>
      )}
    </div>
  );
}

/** A square outline around a circle: where a scatter's area starts. */
const squareAround = (x: number, z: number, r: number) => [
  { x: round(x - r), z: round(z - r) },
  { x: round(x + r), z: round(z - r) },
  { x: round(x + r), z: round(z + r) },
  { x: round(x - r), z: round(z + r) },
];
/** The circle a scatter's area becomes: around its points' bounds. */
function circleFromArea(area: { x: number; z: number }[]) {
  const xs = area.map((p) => p.x);
  const zs = area.map((p) => p.z);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  return { x: round((x0 + x1) / 2), z: round((z0 + z1) / 2), radius: Math.max(0.5, round(Math.max(x1 - x0, z1 - z0) / 2)) };
}
const round = (n: number) => Math.round(n * 100) / 100;

/** A count field: whole numbers, 1 up to MAX_ARRAY_ITEMS. */
function CountField({ title, value, onChange }: { title: string; value: number; onChange: (n: number) => void }) {
  return <NumberField title={title} value={value} unit="" step={1} min={1} fallback={1} onChange={(n) => onChange(Math.min(MAX_ARRAY_ITEMS, Math.max(1, Math.round(n))))} />;
}

/**
 * An array (10.1): which entity it repeats (several show as a list), its layout (path, circle or grid) and that
 * layout's fields, how its items face and turn, and Edit entity and Detach. Each field sends one step.
 */
function ArraySection(props: ArrayControls & { lib: Library }) {
  const { entities, library, lib, layout, facing, rotation, jitter, turnJitter, seed, items, skipped, shortfall, follow, onEntities, onLayoutType, onLayout, onChange, onEdit, onDetach, onRestoreAll } = props;
  const along = follow?.along ?? null;
  const facings = FACINGS[layout.type];
  return (
    <Section label="Array">
      <div className="inspector-label array-repeats">repeats</div>
      <EntitiesField entities={entities} library={lib} onChange={onEntities} />
      <Row label="layout">
        <div className="segmented">
          {LAYOUTS.map((l) => (
            <button key={l.type} className={layout.type === l.type ? "active" : ""} title={l.title} onClick={() => layout.type !== l.type && onLayoutType(l.type)}>
              <l.icon size={16} />
            </button>
          ))}
        </div>
      </Row>
      {layout.type === "path" && follow && (
        <Row label="follows">
          {along ? (
            <>
              <span className="array-follows" title={`Its path is ${along.id}'s: it follows every change to it`}>
                {along.name ? `${along.name} (${along.id})` : along.id}
              </span>
              <button className="labeled" title="Unlink: keep the path it has now as its own points (it stops following)" onClick={follow.onUnlink}>
                <Unlink size={14} /> Unlink
              </button>
            </>
          ) : (
            <button
              className={follow.picking ? "labeled active" : "labeled"}
              title={follow.picking ? "Click a shape in the view to follow it (Esc cancels)" : "Follow: take the path from a shape (a room's wall top, a volume's edge, a ramp, a line), live"}
              onClick={follow.onPick}
            >
              <Link size={14} /> {follow.picking ? "Click a shape…" : "Follow a shape"}
            </button>
          )}
        </Row>
      )}
      {layout.type === "path" && follow && along && (
        <>
          {along.closed && (
            <Row label="at">
              <div className="segmented">
                <button className={along.at === "top" ? "active" : ""} title="Top: its wall top (a volume's top)" onClick={() => follow.onChange({ at: "top" })}>
                  <ArrowUpToLine size={16} />
                </button>
                <button className={along.at === "bottom" ? "active" : ""} title="Bottom: its floor" onClick={() => follow.onChange({ at: "bottom" })}>
                  <ArrowDownToLine size={16} />
                </button>
              </div>
            </Row>
          )}
          <Row label="offset">
            <NumberField
              title={along.closed ? "Meters inward from its outline (half a room's wall is its centerline)" : "Meters to the right of travel"}
              value={along.offset}
              unit="m"
              step={0.05}
              fallback={0}
              onChange={(offset) => follow.onChange({ offset })}
            />
          </Row>
        </>
      )}
      {layout.type === "path" && (
        <>
          <Row label="items">
            <select className="entity-picker" value={layout.place} title="How the items are placed along the path" onChange={(e) => onLayout({ place: e.target.value })}>
              {PLACES.map((p) => (
                <option key={p.place} value={p.place}>
                  {p.label}
                </option>
              ))}
            </select>
          </Row>
          {layout.place === "spacing" && (
            <Row label="spacing">
              <NumberField
                title="Meters between items: fitted, so they land evenly along the path"
                value={layout.spacing}
                unit="m"
                step={0.25}
                min={MIN_ARRAY_SPACING}
                fallback={1}
                onChange={(spacing) => onLayout({ spacing })}
              />
            </Row>
          )}
          {layout.place === "count" && (
            <Row label="count">
              <CountField title="How many items, evenly along the path" value={layout.count ?? 1} onChange={(count) => onLayout({ count })} />
            </Row>
          )}
          {!along && (
            <Row label="closed">
              <label className="note-done" title="Closed: the path loops back to its first point">
                <input type="checkbox" checked={!!layout.closed} onChange={(e) => onLayout({ closed: e.target.checked })} />
                loop
              </label>
            </Row>
          )}
        </>
      )}
      {layout.type === "scatter" && (
        <>
          <Row label="in">
            <div className="segmented">
              <button
                className={layout.area ? "" : "active"}
                title="In a circle: a center and a radius"
                onClick={() => layout.area && onLayout(circleFromArea(layout.area))}
              >
                <Circle size={16} />
              </button>
              <button
                className={layout.area ? "active" : ""}
                title="In an area: an outline you reshape with Edit points, like a free-form"
                onClick={() => !layout.area && onLayout({ area: squareAround(layout.x ?? 0, layout.z ?? 0, layout.radius ?? 1) })}
              >
                <Squircle size={16} />
              </button>
            </div>
          </Row>
          {!layout.area && (
            <>
              <Row label="center x">
                <NumberField title="The circle's center x (east +)" value={layout.x} unit="m" step={0.5} fallback={0} onChange={(x) => onLayout({ x })} />
              </Row>
              <Row label="center z">
                <NumberField title="The circle's center z (south +)" value={layout.z} unit="m" step={0.5} fallback={0} onChange={(z) => onLayout({ z })} />
              </Row>
              <Row label="radius">
                <NumberField title="The circle's radius" value={layout.radius} unit="m" step={0.5} min={0.05} fallback={5} onChange={(radius) => onLayout({ radius })} />
              </Row>
            </>
          )}
          <Row label="y">
            <NumberField title="The height the items stand at" value={layout.y} unit="m" step={0.25} fallback={0} onChange={(y) => onLayout({ y })} />
          </Row>
          <Row label="count">
            <CountField title="How many items (fewer when they can't all fit apart)" value={layout.count} onChange={(count) => onLayout({ count })} />
          </Row>
          <Row label="apart">
            <NumberField title="Meters at least between items" value={layout.minDistance ?? 0} unit="m" step={0.25} min={0} fallback={0} onChange={(minDistance) => onLayout({ minDistance })} />
          </Row>
        </>
      )}
      {(layout.type === "circle" || layout.type === "grid") && (
        <>
          <Row label="center x">
            <NumberField title="The center's x (east +)" value={layout.x} unit="m" step={0.5} fallback={0} onChange={(x) => onLayout({ x })} />
          </Row>
          <Row label="center z">
            <NumberField title="The center's z (south +)" value={layout.z} unit="m" step={0.5} fallback={0} onChange={(z) => onLayout({ z })} />
          </Row>
          <Row label="y">
            <NumberField title="The height the items stand at" value={layout.y} unit="m" step={0.25} fallback={0} onChange={(y) => onLayout({ y })} />
          </Row>
        </>
      )}
      {layout.type === "circle" && (
        <>
          <Row label="radius">
            <NumberField title="From the center to each item's pivot" value={layout.radius} unit="m" step={0.25} min={0.05} fallback={5} onChange={(radius) => onLayout({ radius })} />
          </Row>
          <Row label="count">
            <CountField title="How many items" value={layout.count} onChange={(count) => onLayout({ count })} />
          </Row>
          <Row label="start">
            <NumberField title="The first item's angle: 0 = east, 90 = north" value={layout.start ?? 0} unit="°" step={15} fallback={0} onChange={(start) => onLayout({ start })} />
          </Row>
          <Row label="sweep">
            <NumberField
              title="Degrees covered, counterclockwise from the start (360 = all round; less is an arc with items at both ends)"
              value={layout.sweep ?? 360}
              unit="°"
              step={15}
              min={1}
              fallback={360}
              onChange={(sweep) => onLayout({ sweep: Math.min(360, sweep) })}
            />
          </Row>
          <Row label="rise">
            <NumberField
              title="Meters the items climb over the sweep (over a full circle, in one turn): a spiral of platforms"
              value={layout.rise ?? 0}
              unit="m"
              step={0.25}
              fallback={0}
              onChange={(rise) => onLayout({ rise })}
            />
          </Row>
        </>
      )}
      {layout.type === "grid" && (
        <>
          <Row label="columns">
            <CountField title="Along the grid's own x" value={layout.columns} onChange={(columns) => onLayout({ columns })} />
          </Row>
          <Row label="rows">
            <CountField title="Along the grid's own z" value={layout.rows} onChange={(rows) => onLayout({ rows })} />
          </Row>
          <Row label="layers">
            <CountField title="Up" value={layout.layers ?? 1} onChange={(layers) => onLayout({ layers, ...(layers > 1 && !layout.spacing.y ? { spacing: { ...layout.spacing, y: 3 } } : {}) })} />
          </Row>
          <Row label="spacing x">
            <NumberField title="Meters between columns" value={layout.spacing.x} unit="m" step={0.25} min={0} fallback={1} onChange={(x) => onLayout({ spacing: { ...layout.spacing, x } })} />
          </Row>
          <Row label="spacing z">
            <NumberField title="Meters between rows" value={layout.spacing.z} unit="m" step={0.25} min={0} fallback={1} onChange={(z) => onLayout({ spacing: { ...layout.spacing, z } })} />
          </Row>
          {(layout.layers ?? 1) > 1 && (
            <Row label="spacing y">
              <NumberField title="Meters between layers" value={layout.spacing.y} unit="m" step={0.25} min={0} fallback={3} onChange={(y) => onLayout({ spacing: { ...layout.spacing, y } })} />
            </Row>
          )}
          <Row label="turn">
            <NumberField title="The grid's turn, counterclockwise seen from above" value={layout.rotation ?? 0} unit="°" step={15} fallback={0} onChange={(r) => onLayout({ rotation: r })} />
          </Row>
          <Row label="stagger">
            <label className="note-done" title="Every other row offset by half a column (brick)">
              <input type="checkbox" checked={!!layout.stagger} onChange={(e) => onLayout({ stagger: e.target.checked })} />
              brick
            </label>
          </Row>
        </>
      )}
      <Row label="facing">
        <select className="entity-picker" value={facing} title="How each item turns" onChange={(e) => onChange({ facing: e.target.value as ArrayFacing })}>
          {facings.map((f) => (
            <option key={f.facing} value={f.facing}>
              {f.label}
            </option>
          ))}
          {!facings.some((f) => f.facing === facing) && <option value={facing}>{facing}</option>}
        </select>
      </Row>
      <Row label="item turn">
        <NumberField title="Degrees added to every item's facing" value={rotation} unit="°" step={15} fallback={0} onChange={(r) => onChange({ rotation: r })} />
      </Row>
      <Row label="jitter">
        <NumberField title="Noise: each item moves up to this many meters on the ground" value={jitter} unit="m" step={0.1} min={0} fallback={0} onChange={(j) => onChange({ jitter: j })} />
      </Row>
      <Row label="turn jitter">
        <NumberField title="Noise: each item turns up to ± this many degrees" value={turnJitter} unit="°" step={5} min={0} fallback={0} onChange={(t) => onChange({ turnJitter: Math.min(180, t) })} />
      </Row>
      <Row label="seed">
        <div className="seed-row">
          <NumberField title="The noise's seed: the same seed, the same look" value={seed} unit="" step={1} fallback={1} onChange={(n) => onChange({ seed: Math.round(n) })} />
          <button className="icon" title="Reroll: a new seed, a new look" onClick={() => onChange({ seed: 1 + Math.floor(Math.random() * 99999) })}>
            <Dices size={16} />
          </button>
        </div>
      </Row>
      <div className="inspector-info">
        {items} item{items === 1 ? "" : "s"}
        {skipped > 0 ? ` · ${skipped} skipped` : ""}
        {shortfall ? ` · ${shortfall}` : ""}
        {skipped > 0 && (
          <button className="link" title="Bring every skipped item back" onClick={onRestoreAll}>
            restore all
          </button>
        )}
      </div>
      <div className="inspector-actions">
        {entities.map(({ entity }) =>
          library.some((e) => e.id === entity) ? (
            <button key={entity} className="labeled" title="Edit entity: change its shapes; every item follows" onClick={() => onEdit(entity)}>
              <PencilRuler size={16} /> Edit {entities.length > 1 ? (library.find((e) => e.id === entity)?.name ?? entity) : "entity"}
            </button>
          ) : null,
        )}
        <button className="labeled" title="Detach: turn it into a group of plain instances where its items are (they stop following the layout)" onClick={onDetach}>
          <Unlink size={16} /> Detach
        </button>
      </div>
    </Section>
  );
}

/** A note's fields: the text (sent on leaving it or ⌘Enter), the flag's label, and Done. */
function NoteSection({ text, label, status, focus, onFocused, onChange, library }: NonNullable<InspectorProps["note"]> & { library: Library | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    wrap.current?.querySelector("textarea")?.focus();
    onFocused();
  }, [focus, onFocused]);
  const commit = () => {
    if (!cancelled.current && draft !== null && draft.trim() !== text) onChange({ text: draft.trim() });
    cancelled.current = false;
    setDraft(null);
  };
  const commitLabel = () => {
    if (labelDraft !== null && labelDraft.trim() !== label) onChange({ label: labelDraft.trim() || null });
    setLabelDraft(null);
  };
  return (
    <Section label="Note">
      <div ref={wrap}>
        <RefTextArea
          library={library}
          className="description"
          rows={4}
          maxLength={MAX_NOTE_TEXT}
          title="What the note says, for you and the agent. @skill and #tag refer to the library. ⌘Enter to set, Esc to cancel"
          placeholder="In this area we need a @telekinesis challenge…"
          value={draft ?? text}
          onFocus={() => setDraft(text)}
          onValue={setDraft}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelled.current = true;
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) e.currentTarget.blur();
          }}
        />
      </div>
      <Row label="flag">
        <input
          className="note-label"
          maxLength={MAX_NOTE_LABEL}
          placeholder="TK"
          title={`Up to ${MAX_NOTE_LABEL} letters shown on the note's flag; empty makes it a plain pin`}
          value={labelDraft ?? label}
          onFocus={() => setLabelDraft(label)}
          onChange={(e) => setLabelDraft(e.target.value.toUpperCase())}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setLabelDraft(label);
              e.currentTarget.blur();
            }
          }}
        />
        <label className="note-done" title="Done: handled (it grays out, and leaves the agent's outline)">
          <input type="checkbox" checked={status === "done"} onChange={(e) => onChange({ status: e.target.checked ? "done" : "open" })} />
          done
        </label>
      </Row>
    </Section>
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
        <button className={stepped ? "icon" : "icon active"} title="Smooth: a ramp, no steps" onClick={() => onChange({ step: undefined })}>
          <Slash size={16} />
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
              className={style.base === base ? "active" : ""}
              title={base === "solid" ? "Solid: filled down to its lowest point" : "Floating: a slab under the surface"}
              onClick={() => onChange({ base })}
            >
              {base === "solid" ? <Square size={16} /> : <SquareDashedBottom size={16} />}
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
        <button className={style.dashed ? "icon active" : "icon"} title="Dashed" onClick={() => onChange({ dashed: !style.dashed })}>
          <Ellipsis size={16} />
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

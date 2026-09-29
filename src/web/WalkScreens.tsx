import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { Trash2 } from "lucide-react";
import { definitionOf, expandShapes } from "../shared/entities";
import { DEFAULT_COLOR, type PlayerCamera, type Shape, type ShotView, type WalkPreset } from "../shared/scene.types";
import type { CameraState } from "./camera";
import { ShapeMesh } from "./ShapeMesh";
import { FRAME_GUIDES, frameRect, MAX_SPEED, MIN_SPEED, NO_KEYS, type Boom, type FrameGuide, type MoveKeys, type Pose, type Vec3 } from "./walk";

/**
 * The Walk tool's session and its screens (plan 09 §5): the HUD while walking, the pause menu, and the avatar. The
 * math is in `walk.ts`; the view (`Viewport.tsx`) runs the session: pointer lock, keys, and the camera every frame.
 */

/** Options for this walk (and the next ones, per viewer): not part of the player camera. */
export type WalkOptions = { crosshair: boolean; frame: FrameGuide; shotSize: number; shotNotes: boolean; shotLines: boolean };
export const DEFAULT_WALK_OPTIONS: WalkOptions = { crosshair: true, frame: "16:9", shotSize: 1920, shotNotes: false, shotLines: false };
export const SHOT_SIZES = [1280, 1920, 2560, 3840];
const OPTIONS_KEY = "dd.walk.options";

export function loadWalkOptions(): WalkOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}");
    return { ...DEFAULT_WALK_OPTIONS, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch {
    return DEFAULT_WALK_OPTIONS;
  }
}
export function saveWalkOptions(options: WalkOptions) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // A convenience only.
  }
}

/**
 * A walk in progress. `entering` flies the camera down to the eye, `walking` has the pointer locked, `paused` shows
 * the menu, and `leaving` flies back to `before`, the editor camera from before the walk.
 */
export type WalkSession = {
  phase: "entering" | "walking" | "paused" | "leaving";
  preset: WalkPreset;
  /** Free of floor-follow (after `E` / `Q`), until `F` lands. */
  floating: boolean;
  /** For this walk only (going to a walk shot): its field of view and boom instead of the player camera's. */
  override: { fov: number; boom?: Boom } | null;
  before: CameraState;
  options: WalkOptions;
  /** When the walk started: the shots taken since are this walk's. */
  startedAt: string;
  /**
   * Released (14.1): paused with the menu closed and the mouse free, for working in another window while this one
   * keeps showing the walk. Clicks in the view don't take the mouse back (a click that only focuses the window is
   * safe); Enter or the chip's Continue does. A refused pointer lock (Chrome waits a moment after an Esc) ends here too.
   */
  released: boolean;
  /** When the menu opened, so the Esc that paused doesn't also exit. */
  pausedAt: number;
};

/** A camera between two others (the flights in and out). */
export type CameraPose = { position: Vec3; target: Vec3; vfov: number };

/** What the view's frame loop reads and writes while walking, without re-rendering. */
export type WalkLive = {
  pose: Pose;
  keys: MoveKeys;
  /** The flight in or out: from the camera at its start, eased over `ms`; `toEditor` flies to `before`. */
  flight: { from: CameraPose; start: number; ms: number; toEditor: boolean } | null;
  /** The camera as last drawn (a flight out starts from it). */
  last: CameraPose | null;
  lastReport: number;
};
export const newLive = (pose: Pose): WalkLive => ({ pose, keys: { ...NO_KEYS }, flight: null, last: null, lastReport: 0 });

/** The walk key a key code is (by position, so WASD works on any layout), or null. */
export function walkKey(code: string): keyof MoveKeys | null {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      return "forward";
    case "KeyS":
    case "ArrowDown":
      return "back";
    case "KeyA":
    case "ArrowLeft":
      return "left";
    case "KeyD":
    case "ArrowRight":
      return "right";
    case "KeyE":
      return "up";
    case "KeyQ":
      return "down";
    case "ShiftLeft":
    case "ShiftRight":
      return "fast";
    default:
      return null;
  }
}

/**
 * The walker's shapes, standing at `at` (its feet) turned by `rotation` (the yaw; at 0 it faces north): the project's
 * `human` entity, or a capsule of the eye's height if the project has none. The view draws them at the origin and
 * moves them every frame; a walk shot places them where the walker is.
 */
export function avatarShapes(human: string | null, eyeHeight: number, at: { x: number; y: number; z: number; rotation: number } = { x: 0, y: 0, z: 0, rotation: 0 }): Shape[] {
  if (human && definitionOf(human)) {
    return expandShapes([{ id: "avatar", type: "instance", entity: human, ...at, createdBy: "human" }]);
  }
  return [
    {
      id: "avatar",
      type: "cylinder",
      kind: "volume",
      x: at.x,
      z: at.z,
      y: at.y,
      width: 0.5,
      depth: 0.5,
      height: eyeHeight + 0.15,
      rotation: 0,
      color: DEFAULT_COLOR,
      createdBy: "human",
    } as Shape,
  ];
}

/** The avatar in the view: its shapes in a group the frame loop places at the feet and turns with the yaw. */
export function Avatar({ shapes, group }: { shapes: Shape[]; group: RefObject<THREE.Group | null> }) {
  return (
    <group ref={group}>
      {shapes.map((s) => (s.type === "line" || s.type === "note" || s.type === "instance" || s.type === "array" ? null : <ShapeMesh key={s.id} shape={s} walkable={false} />))}
    </group>
  );
}

/** Over the view while walking: the frame guide, the crosshair, a line of what's going on, and a shot's flash. */
export function WalkHud({
  session,
  size,
  speed,
  shots,
  flash,
}: {
  session: WalkSession;
  size: { width: number; height: number };
  speed: number;
  /** Shots taken during this walk. */
  shots: number;
  /** The last shot's ID while its flash shows. */
  flash: { key: number; label: string } | null;
}) {
  const frame = frameRect(size.width, size.height, session.options.frame);
  const guide = session.options.frame !== "none";
  const preset = session.preset === "first" ? "First person" : "Third person";
  return (
    <div className="walk-hud" aria-hidden>
      {guide && (
        <div className="walk-frame" style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} />
      )}
      {session.options.crosshair && session.phase === "walking" && <div className="walk-crosshair" />}
      <div className="walk-status">
        Walking · {preset} · {Math.round(speed * 10) / 10} m/s{session.floating ? " · floating (F lands)" : ""}
        {shots > 0 && ` · ${shots} shot${shots === 1 ? "" : "s"}`}
        <span className="muted"> · click for a shot · Esc pauses</span>
      </div>
      {flash && (
        <div key={flash.key} className="walk-flash">
          <span>{flash.label}</span>
        </div>
      )}
    </div>
  );
}

/**
 * A released walk's chip (14.1): the walk is paused and the mouse is free. Continue (or Enter) takes the mouse back,
 * Menu (or Tab) opens the pause menu again.
 */
export function WalkReleased({ onContinue, onMenu }: { onContinue: () => void; onMenu: () => void }) {
  return (
    <div className="walk-released">
      <span>Paused · the mouse is free</span>
      <button type="button" className="primary" onClick={onContinue}>
        Continue <kbd>Enter</kbd>
      </button>
      <button type="button" onClick={onMenu}>
        Menu <kbd>Tab</kbd>
      </button>
    </div>
  );
}

/** A number field for the pause menu: a slider and its value. */
function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="walk-field">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="value">
        {Math.round(value * 100) / 100}
        {unit}
      </span>
    </label>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="walk-field toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="walk-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/**
 * The pause menu (`Esc` while walking): the player camera (saved for the project, shown live behind), this walk's
 * options, the shots taken so far, and Continue (`Enter`) or Exit (`Esc`).
 */
export function WalkMenu({
  session,
  player,
  onPlayer,
  onSession,
  shots,
  onRemoveShot,
  onContinue,
  onRelease,
  onExit,
}: {
  session: WalkSession;
  player: PlayerCamera;
  onPlayer: (player: PlayerCamera) => void;
  onSession: (patch: Partial<WalkSession>) => void;
  shots: ShotView[];
  onRemoveShot: (id: string) => void;
  onContinue: () => void;
  /** Closes the menu and leaves the mouse free (14.1). */
  onRelease: () => void;
  onExit: () => void;
}) {
  const third = session.preset === "third";
  const fov = session.override?.fov ?? (third ? player.third.fov : player.first.fov);
  const setFov = (v: number) => {
    if (session.override) onSession({ override: { ...session.override, fov: v } });
    else onPlayer(third ? { ...player, third: { ...player.third, fov: v } } : { ...player, first: { fov: v } });
  };
  const setOptions = (patch: Partial<WalkOptions>) => {
    const options = { ...session.options, ...patch };
    saveWalkOptions(options);
    onSession({ options });
  };
  // The strip keeps up with deletes without waiting for the server.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  useEffect(() => setRemoved(new Set()), [shots]);
  const strip = useMemo(() => shots.filter((s) => !removed.has(s.id)).reverse(), [shots, removed]);

  return (
    <div className="walk-menu-backdrop" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="walk-menu" role="dialog" aria-label="Walk paused">
        <div className="walk-menu-title">Paused</div>
        <Section title="Player camera">
          <div className="segmented walk-presets">
            {(["first", "third"] as const).map((p) => (
              <button key={p} type="button" className={session.preset === p ? "active" : ""} onClick={() => onSession({ preset: p, override: null })}>
                {p === "first" ? "First person" : "Third person"}
              </button>
            ))}
          </div>
          {session.override && <div className="walk-note">Using the shot's camera for this walk. Changing the preset goes back to the player camera.</div>}
          <Slider label="Eye height" value={player.eyeHeight} min={0.5} max={3} step={0.05} unit=" m" onChange={(v) => onPlayer({ ...player, eyeHeight: v })} />
          <Slider label="Field of view" value={fov} min={30} max={150} step={1} unit="°" onChange={setFov} />
          <Slider label="Speed" value={player.speed} min={MIN_SPEED} max={MAX_SPEED} step={0.5} unit=" m/s" onChange={(v) => onPlayer({ ...player, speed: v })} />
          {third && !session.override && (
            <>
              <Slider label="Distance" value={player.third.distance} min={0} max={10} step={0.1} unit=" m" onChange={(v) => onPlayer({ ...player, third: { ...player.third, distance: v } })} />
              <Slider label="Height" value={player.third.height} min={-1} max={4} step={0.1} unit=" m" onChange={(v) => onPlayer({ ...player, third: { ...player.third, height: v } })} />
              <Slider label="Shoulder" value={player.third.shoulder} min={-2} max={2} step={0.1} unit=" m" onChange={(v) => onPlayer({ ...player, third: { ...player.third, shoulder: v } })} />
              <Toggle label="Show the human" on={player.third.avatar} onChange={(on) => onPlayer({ ...player, third: { ...player.third, avatar: on } })} />
            </>
          )}
        </Section>
        <Section title="This walk">
          <Toggle label="Floor-follow (E / Q float, F lands)" on={!session.floating} onChange={(on) => onSession({ floating: !on })} />
          <Toggle label="Crosshair" on={session.options.crosshair} onChange={(on) => setOptions({ crosshair: on })} />
          <label className="walk-field">
            <span>Frame</span>
            <select value={session.options.frame} onChange={(e) => setOptions({ frame: e.target.value as FrameGuide })}>
              {FRAME_GUIDES.map((g) => (
                <option key={g} value={g}>
                  {g === "none" ? "none (the whole view)" : g}
                </option>
              ))}
            </select>
          </label>
          <label className="walk-field">
            <span>Shot size</span>
            <select value={session.options.shotSize} onChange={(e) => setOptions({ shotSize: Number(e.target.value) })}>
              {SHOT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} px
                </option>
              ))}
            </select>
          </label>
          <Toggle label="Notes in shots" on={session.options.shotNotes} onChange={(on) => setOptions({ shotNotes: on })} />
          <Toggle label="Lines in shots" on={session.options.shotLines} onChange={(on) => setOptions({ shotLines: on })} />
        </Section>
        <Section title={`Shots this walk (${strip.length})`}>
          {strip.length === 0 ? (
            <div className="walk-note">None yet: click while walking to take one.</div>
          ) : (
            <div className="walk-shots">
              {strip.map((s) => (
                <div key={s.id} className="walk-shot" title={s.caption ?? s.id}>
                  <img src={s.url} alt={s.id} draggable={false} />
                  <button
                    type="button"
                    title="Delete (a shot can't be undone)"
                    onClick={() => {
                      setRemoved(new Set([...removed, s.id]));
                      onRemoveShot(s.id);
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>
        <div className="walk-menu-actions">
          <button type="button" className="primary" onClick={onContinue}>
            Continue <kbd>Enter</kbd>
          </button>
          <button type="button" title="Close the menu and keep the mouse free (for another window); Enter continues" onClick={onRelease}>
            Release mouse <kbd>Tab</kbd>
          </button>
          <button type="button" onClick={onExit}>
            Exit <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

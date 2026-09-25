import { useEffect, useRef, useState, type PointerEvent } from "react";
import { PX_PER_UNIT, SNAP, type View } from "../shared/scene.types";
import { useScene } from "./useScene";

type Point = { x: number; y: number };
type Draft = { x: number; y: number; width: number; height: number };

const snap = (n: number) => Math.round(n / SNAP) * SNAP;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => `${round2(n)}`;
/** Fixed-width coordinate (e.g. "  12.50", " -3.00") so the info-label never jitters. */
const coord = (n?: number) => (n === undefined ? "–".padStart(7) : n.toFixed(2).padStart(7));

/** Rect spanning `start` to `end` in any drag direction; `square` constrains it to the larger side. */
function draftFrom(start: Point, end: Point, square: boolean): Draft {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  const width = square ? side : Math.abs(dx);
  const height = square ? side : Math.abs(dy);
  return {
    x: dx < 0 ? start.x - width : start.x,
    y: dy < 0 ? start.y - height : start.y,
    width,
    height,
  };
}

/** The editor fills the window; its visible world area follows the window size at 1 u = PX_PER_UNIT px. */
function useWindowView(): View {
  const measure = (): View => ({
    x: 0,
    y: 0,
    width: round2(window.innerWidth / PX_PER_UNIT),
    height: round2(window.innerHeight / PX_PER_UNIT),
  });
  const [view, setView] = useState(measure);
  useEffect(() => {
    const onResize = () => setView(measure());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return view;
}

export function App() {
  const { scene, connected, error, send } = useScene();
  const view = useWindowView();
  const svgRef = useRef<SVGSVGElement>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);

  // Tell the server what's visible so the agent's get_scene knows where to draw.
  useEffect(() => {
    if (connected) send({ type: "set_view", view });
  }, [connected, view, send]);

  const toWorld = (e: PointerEvent, free: boolean): Point => {
    const svg = svgRef.current!;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    return free ? { x: p.x, y: p.y } : { x: snap(p.x), y: snap(p.y) };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toWorld(e, e.altKey);
    setStart(p);
    setDraft({ ...p, width: 0, height: 0 });
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = toWorld(e, e.altKey);
    setCursor(p);
    if (start) setDraft(draftFrom(start, p, e.shiftKey));
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!start) return;
    const d = draftFrom(start, toWorld(e, e.altKey), e.shiftKey);
    if (round2(d.width) > 0 && round2(d.height) > 0) {
      send({
        type: "add_rects",
        rects: [{ x: round2(d.x), y: round2(d.y), width: round2(d.width), height: round2(d.height) }],
      });
    }
    setStart(null);
    setDraft(null);
  };

  return (
    <div className="app">
      <svg
        ref={svgRef}
        className="canvas"
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
      >
        <Grid view={view} />
        {scene?.rects.map((r) => (
          <rect
            key={r.id}
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            fill={`var(--${r.createdBy})`}
            fillOpacity={0.35}
            stroke={`var(--${r.createdBy})`}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          >
            <title>{`${r.id} · ${r.createdBy} · (${fmt(r.x)}, ${fmt(r.y)}) · ${fmt(r.width)} × ${fmt(r.height)} u`}</title>
          </rect>
        ))}
        {draft && (draft.width > 0 || draft.height > 0) && (
          <g pointerEvents="none">
            <rect
              x={draft.x}
              y={draft.y}
              width={draft.width}
              height={draft.height}
              fill="none"
              stroke="var(--draft)"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            <text x={draft.x + draft.width / 2} y={draft.y - 0.3} textAnchor="middle" fontSize={0.6} fill="var(--draft)">
              {fmt(draft.width)} × {fmt(draft.height)} u
            </text>
          </g>
        )}
      </svg>

      <div className="info-label">
        <span className={connected ? "conn" : "conn offline"}>
          <i className="dot" />
          {connected ? "connected" : "offline"}
        </span>
        <span className="coords">
          x {coord(cursor?.x)} · y {coord(cursor?.y)} u
        </span>
      </div>

      <div className="dock">
        {error && <div className="error">{error}</div>}
        <div className="tool-bar">
          <strong>Dungeon Designer</strong>
          <span className="sep" />
          <span className="legend">
            <span><i className="swatch" style={{ background: "var(--human)" }} />human</span>
            <span><i className="swatch" style={{ background: "var(--agent)" }} />agent</span>
          </span>
          <span className="muted">{scene ? `${scene.rects.length} rects` : "—"}</span>
          <span className="sep" />
          <span className="muted">drag to draw · Shift for square · Alt for free</span>
          <button onClick={() => send({ type: "clear" })} disabled={!connected}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

/** Reference grid only: a line every 1 u, stronger every 5 u. Not part of the scene data. */
function Grid({ view }: { view: View }) {
  const lines = [];
  for (let x = Math.ceil(view.x); x <= view.x + view.width; x++) {
    lines.push(<line key={`x${x}`} x1={x} y1={view.y} x2={x} y2={view.y + view.height} className={x % 5 === 0 ? "major" : "minor"} />);
  }
  for (let y = Math.ceil(view.y); y <= view.y + view.height; y++) {
    lines.push(<line key={`y${y}`} x1={view.x} y1={y} x2={view.x + view.width} y2={y} className={y % 5 === 0 ? "major" : "minor"} />);
  }
  return (
    <g className="grid" pointerEvents="none">
      {lines}
    </g>
  );
}

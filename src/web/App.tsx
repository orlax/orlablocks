import { useEffect, useRef, useState } from "react";
import { DEFAULT_VIEW, type View } from "../shared/scene.types";
import type { GroundPoint } from "./camera";
import { useScene } from "./useScene";
import { Viewport, type Tool } from "./Viewport";

/** Fixed-width number (e.g. "  12.50", " -3.00") so the info-label never jitters. */
const coord = (n?: number) => (n === undefined ? "–".padStart(7) : n.toFixed(2).padStart(7));

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "hand", label: "Hand", key: "h" },
  { tool: "room", label: "Room", key: "r" },
  { tool: "volume", label: "Volume", key: "v" },
];

const HINTS: Record<Tool, string> = {
  hand: "click to select · drag to pan · scroll to zoom · A/D or ←/→ to rotate",
  room: "drag on the ground to draw a room · Shift for square · Alt for free · Esc to cancel",
  volume: "drag on the ground to draw a volume · Shift for square · Alt for free · Esc to cancel",
};

export function App() {
  const { scene, history, lastCreated, connected, error, send } = useScene();
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [cursor, setCursor] = useState<GroundPoint | null>(null);
  const [tool, setTool] = useState<Tool>("hand");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pendingDraw = useRef<string | null>(null);

  // Tell the server what's visible so the agent's get_scene knows where to draw.
  useEffect(() => {
    if (connected) send({ type: "set_view", view });
  }, [connected, view, send]);

  // H / R / V pick a tool. Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === "z" || key === "y")) {
        e.preventDefault();
        send({ type: key === "y" || e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") setSelectedId(null);
      const match = TOOLS.find((t) => t.key === key);
      if (match) setTool(match.tool);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send]);

  const boxes = scene?.boxes ?? [];
  const rooms = boxes.filter((b) => b.kind === "room").length;
  const volumes = boxes.length - rooms;
  const selected = boxes.find((b) => b.id === selectedId) ?? null;

  // Select the box we just drew, once the server says which ID it got.
  useEffect(() => {
    if (lastCreated && lastCreated.requestId === pendingDraw.current) {
      pendingDraw.current = null;
      setSelectedId(lastCreated.ids[0] ?? null);
    }
  }, [lastCreated]);

  // Drop the selection when its box goes away (undo, Clear, another tab).
  useEffect(() => {
    if (selectedId && scene && !scene.boxes.some((b) => b.id === selectedId)) setSelectedId(null);
  }, [scene, selectedId]);

  return (
    <div className="app">
      <Viewport
        tool={tool}
        boxes={boxes}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDrawBox={(box) => {
          const requestId = crypto.randomUUID();
          pendingDraw.current = requestId;
          send({ type: "add_boxes", requestId, boxes: [box] });
        }}
        onChangeHeight={(id, height) => send({ type: "update_boxes", changes: [{ id, height }] })}
        onCursor={setCursor}
        onViewChange={setView}
      />

      <div className="info-label">
        <span className={connected ? "conn" : "conn offline"}>
          <i className="dot" />
          {connected ? "connected" : "offline"}
        </span>
        <span className="coords">
          x {coord(cursor?.x)} · z {coord(cursor?.z)} m
        </span>
        <span className="coords">yaw {`${Math.round(view.yaw)}°`.padStart(4)}</span>
      </div>

      <div className="dock">
        {error && <div className="error">{error}</div>}
        <div className="tool-bar">
          <strong>Dungeon Designer</strong>
          <span className="sep" />
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              className={t.tool === tool ? "tool active" : "tool"}
              title={`${t.label} (${t.key.toUpperCase()})`}
              onClick={() => setTool(t.tool)}
            >
              {t.label}
            </button>
          ))}
          <span className="sep" />
          <button
            onClick={() => send({ type: "undo" })}
            disabled={!connected || !history.canUndo}
            title={history.undoLabel ? `Undo: ${history.undoLabel} (${MOD}Z)` : "Nothing to undo"}
          >
            Undo
          </button>
          <button
            onClick={() => send({ type: "redo" })}
            disabled={!connected || !history.canRedo}
            title={history.redoLabel ? `Redo: ${history.redoLabel} (${MOD}⇧Z)` : "Nothing to redo"}
          >
            Redo
          </button>
          <span className="sep" />
          <span className="muted">{scene ? `${rooms} rooms · ${volumes} volumes` : "—"}</span>
          {selected && (
            <span className="selected-info">
              {selected.id} · {selected.width} × {selected.depth} m · h {selected.height} m
            </span>
          )}
          <span className="sep" />
          <span className="muted">{HINTS[tool]}</span>
          <button onClick={() => send({ type: "clear" })} disabled={!connected}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

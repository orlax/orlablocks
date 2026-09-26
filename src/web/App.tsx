import { useEffect, useState } from "react";
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
  hand: "drag to pan · scroll to zoom · A/D or ←/→ to rotate",
  room: "drag on the ground to draw a room · Shift for square · Alt for free · Esc to cancel",
  volume: "drag on the ground to draw a volume · Shift for square · Alt for free · Esc to cancel",
};

export function App() {
  const { scene, history, connected, error, send } = useScene();
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [cursor, setCursor] = useState<GroundPoint | null>(null);
  const [tool, setTool] = useState<Tool>("hand");

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
      const match = TOOLS.find((t) => t.key === key);
      if (match) setTool(match.tool);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send]);

  const boxes = scene?.boxes ?? [];
  const rooms = boxes.filter((b) => b.kind === "room").length;
  const volumes = boxes.length - rooms;

  return (
    <div className="app">
      <Viewport
        tool={tool}
        boxes={boxes}
        onDrawBox={(box) => send({ type: "add_boxes", boxes: [box] })}
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

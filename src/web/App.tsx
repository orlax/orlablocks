import { useEffect, useState } from "react";
import { DEFAULT_VIEW, type View } from "../shared/scene.types";
import type { GroundPoint } from "./camera";
import { useScene } from "./useScene";
import { Viewport } from "./Viewport";

/** Fixed-width number (e.g. "  12.50", " -3.00") so the info-label never jitters. */
const coord = (n?: number) => (n === undefined ? "–".padStart(7) : n.toFixed(2).padStart(7));

export function App() {
  const { scene, connected, error, send } = useScene();
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [cursor, setCursor] = useState<GroundPoint | null>(null);

  // Tell the server what's visible so the agent's get_scene knows where to draw.
  useEffect(() => {
    if (connected) send({ type: "set_view", view });
  }, [connected, view, send]);

  return (
    <div className="app">
      <Viewport rects={scene?.rects ?? []} onCursor={setCursor} onViewChange={setView} />

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
          <button className="tool active" title="Hand tool">
            Hand
          </button>
          <span className="sep" />
          <span className="legend">
            <span><i className="swatch" style={{ background: "var(--human)" }} />human</span>
            <span><i className="swatch" style={{ background: "var(--agent)" }} />agent</span>
          </span>
          <span className="muted">{scene ? `${scene.rects.length} rects` : "—"}</span>
          <span className="sep" />
          <span className="muted">drag to pan · scroll to zoom · A/D or ←/→ to rotate</span>
          <button onClick={() => send({ type: "clear" })} disabled={!connected}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

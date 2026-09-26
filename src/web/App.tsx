import { useEffect, useRef, useState } from "react";
import { DEFAULT_COLOR, DEFAULT_VIEW, type Box, type BoxColor, type BoxKind, type View } from "../shared/scene.types";
import type { GroundPoint } from "./camera";
import { ContextualBar, HINTS, TOOLS, ToolBar } from "./ToolBar";
import { useScene } from "./useScene";
import { Viewport, type Tool } from "./Viewport";

/** Fixed-width number (e.g. "  12.50", " -3.00") so the info-label never jitters. */
const coord = (n?: number) => (n === undefined ? "–".padStart(7) : n.toFixed(2).padStart(7));

/** Keys typed into a text field aren't shortcuts. */
const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && e.target.matches("input, textarea, [contenteditable]");

/** `lobby (box_3) · 6 × 4 × 3 m · y 0 · 0°` */
const describe = (b: Box) =>
  `${b.name ? `${b.name} (${b.id})` : b.id} · ${b.width} × ${b.depth} × ${b.height} m · y ${b.y} · ${b.rotation}°`;

export function App() {
  const { scene, history, connected, error, send } = useScene();
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [cursor, setCursor] = useState<GroundPoint | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  // Holding Space switches to the hand for as long as it's held.
  const [spaceHand, setSpaceHand] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  // The next box's style in the Box tool, remembered while the tab is open.
  const [nextKind, setNextKind] = useState<BoxKind>("room");
  const [nextColor, setNextColor] = useState<BoxColor>(DEFAULT_COLOR);
  // The key handler is installed once; it reads the current selection from here.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const boxesRef = useRef<Box[]>([]);
  boxesRef.current = scene?.boxes ?? [];

  const activeTool: Tool = spaceHand ? "hand" : tool;
  const boxes = scene?.boxes ?? [];
  const selected = boxes.filter((b) => selection.includes(b.id));
  const rooms = boxes.filter((b) => b.kind === "room").length;
  const volumes = boxes.length - rooms;

  // Tell the server what's visible so the agent's get_scene knows where to draw.
  useEffect(() => {
    if (connected) send({ type: "set_view", view });
  }, [connected, view, send]);

  // Tell the server what's selected so the agent knows what "this" means. The last tab to change it wins.
  const selectionKey = selection.join(",");
  useEffect(() => {
    if (connected) send({ type: "set_selection", ids: selectionKey ? selectionKey.split(",") : [] });
  }, [connected, selectionKey, send]);

  // Drop selected boxes that go away (undo, Clear, the agent, another tab).
  useEffect(() => {
    if (!scene) return;
    const ids = new Set(scene.boxes.map((b) => b.id));
    setSelection((sel) => (sel.every((id) => ids.has(id)) ? sel : sel.filter((id) => ids.has(id))));
  }, [scene]);

  // V / H / B pick a tool, Space holds the hand. Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes.
  // Cmd/Ctrl+A selects everything, Delete / Backspace removes the selection, Esc deselects.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === "z" || key === "y")) {
        e.preventDefault();
        send({ type: key === "y" || e.shiftKey ? "redo" : "undo" });
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === "a") {
        e.preventDefault();
        setSelection(boxesRef.current.map((b) => b.id));
        return;
      }
      if (e.key === " ") {
        // Also keeps a focused button from being pressed by Space.
        e.preventDefault();
        if (!e.repeat) setSpaceHand(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") setSelection([]);
      if ((e.key === "Delete" || e.key === "Backspace") && selectionRef.current.length > 0) {
        e.preventDefault();
        send({ type: "remove_nodes", ids: selectionRef.current });
      }
      const match = TOOLS.find((t) => t.key === key);
      if (match) setTool(match.tool);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      e.preventDefault();
      setSpaceHand(false);
    };
    const onBlur = () => setSpaceHand(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [send]);

  const single = selected.length === 1 ? selected[0] : null;
  const sharedColor = selected.length > 0 && selected.every((b) => b.color === selected[0].color) ? selected[0].color : null;

  return (
    <div className="app">
      <Viewport
        tool={activeTool}
        boxes={boxes}
        selection={selection}
        nextKind={nextKind}
        onSelect={setSelection}
        onDrawBox={(box) => send({ type: "add_boxes", boxes: [{ ...box, color: nextColor }] })}
        onUpdate={(changes) => send({ type: "update_nodes", changes })}
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
        <span className="sep" />
        <span className="counts">{scene ? `${rooms} rooms · ${volumes} volumes` : "—"}</span>
        <span className="sep" />
        <span className="hint">{HINTS[activeTool]}</span>
      </div>

      <div className="dock">
        {error && <div className="error">{error}</div>}
        {tool === "box" && (
          <ContextualBar kind={nextKind} onKind={setNextKind} color={nextColor} onColor={setNextColor}>
            next box
          </ContextualBar>
        )}
        {tool === "select" && selected.length > 0 && (
          <ContextualBar
            kind={single?.kind ?? null}
            kindDisabled={!single}
            onKind={(kind) => single && send({ type: "update_nodes", changes: [{ id: single.id, kind }] })}
            color={sharedColor}
            onColor={(color) => send({ type: "update_nodes", changes: selected.map((b) => ({ id: b.id, color })) })}
          >
            {single ? describe(single) : `${selected.length} selected`}
          </ContextualBar>
        )}
        <ToolBar
          tool={activeTool}
          onTool={setTool}
          history={history}
          connected={connected}
          onUndo={() => send({ type: "undo" })}
          onRedo={() => send({ type: "redo" })}
          onClear={() => send({ type: "clear" })}
        />
      </div>
    </div>
  );
}

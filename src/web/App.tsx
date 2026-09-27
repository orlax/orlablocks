import { useEffect, useRef, useState } from "react";
import { DEFAULT_COLOR, DEFAULT_VIEW, type Box, type BoxColor, type BoxKind, type SceneNode, type View } from "../shared/scene.types";
import { boxesUnder, childrenOf, isBox, isGroup } from "../shared/tree";
import type { CameraState, GroundPoint } from "./camera";
import { typingInField } from "./keys";
import { Outliner } from "./Outliner";
import { ProjectPicker } from "./ProjectPicker";
import { ContextualBar, HINTS, TOOLS, ToolBar } from "./ToolBar";
import { useScene } from "./useScene";
import { Viewport, type Tool } from "./Viewport";

/** Fixed-width number (e.g. "  12.50", " -3.00") so the info-label never jitters. */
const coord = (n?: number) => (n === undefined ? "–".padStart(7) : n.toFixed(2).padStart(7));


/** `lobby (group_1)` or just `box_3`. */
const title = (n: SceneNode) => (n.name ? `${n.name} (${n.id})` : n.id);

/** `lobby (box_3) · 6 × 4 × 3 m · y 0 · 0°` */
const describe = (b: Box) => `${title(b)} · ${b.width} × ${b.depth} × ${b.height} m · y ${b.y} · ${b.rotation}°`;

export function App() {
  const { scene, history, projects, open, restore, connected, error, clearError, send } = useScene();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [camera, setCamera] = useState<CameraState | null>(null);
  const [cursor, setCursor] = useState<GroundPoint | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  // Holding Space switches to the hand for as long as it's held.
  const [spaceHand, setSpaceHand] = useState(false);
  // Node IDs (boxes and groups), at the level of `context`.
  const [selection, setSelection] = useState<string[]>([]);
  // The group entered with a double-click (null = the top level).
  const [context, setContext] = useState<string | null>(null);
  // The node under the cursor in the outliner, highlighted in the view.
  const [outlinerHover, setOutlinerHover] = useState<string | null>(null);
  // The next box's style in the Box tool, remembered while the tab is open.
  const [nextKind, setNextKind] = useState<BoxKind>("room");
  const [nextColor, setNextColor] = useState<BoxColor>(DEFAULT_COLOR);
  // After Cmd+G: the grouped IDs and the groups that existed then, so the new group can be selected when it arrives.
  const pendingGroup = useRef<{ ids: string[]; before: Set<string> } | null>(null);

  const nodes = scene?.nodes ?? [];
  // The key handler is installed once; it reads the current state from here.
  const state = useRef({ nodes, selection, context, open, pickerOpen });
  state.current = { nodes, selection, context, open, pickerOpen };

  const activeTool: Tool = spaceHand ? "hand" : tool;
  const boxes = nodes.filter(isBox);
  const selectedNodes = nodes.filter((n) => selection.includes(n.id));
  const selectedBoxes = boxesUnder(nodes, selection);
  const rooms = boxes.filter((b) => b.kind === "room").length;
  const volumes = boxes.length - rooms;
  const groups = nodes.filter(isGroup).length;

  // A scene opened (here, in another tab, or when this tab connected): close the picker, drop the local state that
  // belonged to the old scene, and restore the scene's selection (the Viewport restores its camera). A rename
  // doesn't send `restore`, so it changes nothing here.
  const sceneKey = open ? `${open.project.id}/${open.scene.id}` : "";
  useEffect(() => {
    if (!restore) return;
    setPickerOpen(false);
    setSelection(restore.selection);
    setContext(null);
    setOutlinerHover(null);
    pendingGroup.current = null;
  }, [restore]);

  // The tab's title follows the open scene.
  useEffect(() => {
    document.title = open ? `${open.scene.name} — ${open.project.name}` : "Dungeon Designer";
  }, [open]);

  // Tell the server what's visible so the agent's get_scene knows where to draw, and where the camera is, so the
  // scene reopens there.
  useEffect(() => {
    if (connected && camera) send({ type: "set_view", view, camera });
  }, [connected, view, camera, send]);

  // Tell the server what's selected so the agent knows what "this" means. The last tab to change it wins.
  const selectionKey = selection.join(",");
  useEffect(() => {
    if (connected) send({ type: "set_selection", ids: selectionKey ? selectionKey.split(",") : [] });
  }, [connected, selectionKey, send]);

  // A new scene: drop selected nodes that went away (undo, Clear, the agent, another tab), leave an entered group
  // that went away, and select the group Cmd+G just made.
  useEffect(() => {
    if (!scene) return;
    const ids = new Set(scene.nodes.map((n) => n.id));
    setSelection((sel) => (sel.every((id) => ids.has(id)) ? sel : sel.filter((id) => ids.has(id))));
    setContext((c) => (c !== null && !ids.has(c) ? null : c));
    const pending = pendingGroup.current;
    if (pending) {
      const made = scene.nodes.find(
        (n) => isGroup(n) && !pending.before.has(n.id) && scene.nodes.some((c) => c.parent === n.id && pending.ids.includes(c.id)),
      );
      if (made) {
        pendingGroup.current = null;
        setSelection([made.id]);
      }
    }
  }, [scene]);

  // V / H / B pick a tool, Space holds the hand. Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes.
  // Cmd/Ctrl+A selects everything at the current level, Cmd/Ctrl+G groups the selection, Cmd/Ctrl+Shift+G ungroups
  // it, Delete / Backspace removes it, Esc deselects and leaves an entered group.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (typingInField(e)) return;
      const key = e.key.toLowerCase();
      const { nodes, selection, context, open, pickerOpen } = state.current;
      // Nothing to edit while the picker is up (and while nothing is open, it always is).
      if (!open || pickerOpen) return;
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
      if (mod && (key === "z" || key === "y")) {
        e.preventDefault();
        send({ type: key === "y" || e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (mod && !e.shiftKey && key === "a") {
        e.preventDefault();
        setSelection(childrenOf(nodes, context ?? undefined).map((n) => n.id));
        return;
      }
      if (mod && key === "g") {
        e.preventDefault();
        if (selection.length === 0) return;
        if (!e.shiftKey) {
          pendingGroup.current = { ids: selection, before: new Set(nodes.filter(isGroup).map((n) => n.id)) };
          send({ type: "group_nodes", ids: selection });
          return;
        }
        const groupIds = selection.filter((id) => nodes.some((n) => n.id === id && isGroup(n)));
        if (groupIds.length === 0) return;
        // Their contents take their place in the selection.
        const freed = nodes.filter((n) => n.parent !== undefined && groupIds.includes(n.parent)).map((n) => n.id);
        send({ type: "ungroup", ids: groupIds });
        setSelection([...selection.filter((id) => !groupIds.includes(id)), ...freed]);
        return;
      }
      if (e.key === " ") {
        // Also keeps a focused button from being pressed by Space.
        e.preventDefault();
        if (!e.repeat) setSpaceHand(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        setSelection([]);
        setContext(null);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection.length > 0) {
        e.preventDefault();
        send({ type: "remove_nodes", ids: selection });
      }
      const match = TOOLS.find((t) => t.key === key);
      if (match) setTool(match.tool);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || typingInField(e)) return;
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

  // Kind is for a single box; color applies to every box in the selection (groups included).
  const single = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const singleBox = single && isBox(single) ? single : null;
  const sharedColor =
    selectedBoxes.length > 0 && selectedBoxes.every((b) => b.color === selectedBoxes[0].color) ? selectedBoxes[0].color : null;
  const contextNode = context !== null ? nodes.find((n) => n.id === context) : undefined;
  const selectionInfo = singleBox
    ? describe(singleBox)
    : single
      ? `${title(single)} · ${selectedBoxes.length} boxes`
      : `${selectedNodes.length} selected`;

  return (
    <div className="app">
      <Viewport
        tool={activeTool}
        nodes={nodes}
        selection={selection}
        context={context}
        onContext={setContext}
        outsideHover={outlinerHover}
        nextKind={nextKind}
        onSelect={setSelection}
        onDrawBox={(box) => send({ type: "add_boxes", boxes: [{ ...box, color: nextColor }] })}
        onUpdate={(changes) => send({ type: "update_nodes", changes })}
        onCursor={setCursor}
        onViewChange={(v, c) => {
          setView(v);
          setCamera({ focus: { ...c.focus }, yaw: c.yaw, distance: c.distance });
        }}
        cameraRestore={restore}
      />

      <Outliner
        key={sceneKey}
        nodes={nodes}
        selection={selection}
        onSelect={(ids, ctx) => {
          setSelection(ids);
          setContext(ctx);
        }}
        onHover={setOutlinerHover}
        onRename={(id, name) => send({ type: "update_nodes", changes: [{ id, name }] })}
        onPlace={(ids, parent, before) => send({ type: "place_nodes", ids, parent, before })}
      />

      <div className="info-label">
        <span className={connected ? "conn" : "conn offline"}>
          <i className="dot" />
          {connected ? "connected" : "offline"}
        </span>
        {open && (
          <button
            type="button"
            className="where"
            title="Projects and scenes"
            onClick={() => {
              clearError();
              setPickerOpen(true);
            }}
          >
            {open.project.name} ▸ {open.scene.name}
          </button>
        )}
        <span className="coords">
          x {coord(cursor?.x)} · z {coord(cursor?.z)} m
        </span>
        <span className="coords">yaw {`${Math.round(view.yaw)}°`.padStart(4)}</span>
        <span className="sep" />
        <span className="counts">{scene ? `${rooms} rooms · ${volumes} volumes · ${groups} groups` : "—"}</span>
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
        {tool === "select" && selectedNodes.length > 0 && (
          <ContextualBar
            kind={singleBox?.kind ?? null}
            kindDisabled={!singleBox}
            onKind={(kind) => singleBox && send({ type: "update_nodes", changes: [{ id: singleBox.id, kind }] })}
            color={sharedColor}
            onColor={(color) => send({ type: "update_nodes", changes: selectedBoxes.map((b) => ({ id: b.id, color })) })}
          >
            {contextNode ? `in ${contextNode.name ?? contextNode.id} › ${selectionInfo}` : selectionInfo}
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

      {connected && (open === null || pickerOpen) && (
        <ProjectPicker
          projects={projects}
          open={open ?? null}
          error={error}
          onClose={open ? () => setPickerOpen(false) : undefined}
          send={send}
        />
      )}
    </div>
  );
}

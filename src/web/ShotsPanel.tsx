import { useEffect, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Copy, Download, GripVertical, Pencil, Trash2, X } from "lucide-react";
import { zipSync } from "fflate";
import { MAX_SHOT_CAPTION, type ShotView } from "../shared/scene.types";
import { reportError } from "./errors";
import { useFloating } from "./floating";
import { shotFileName } from "./shots";

/**
 * The Shots panel (plan 09 §4): the open document's shots, newest first, as thumbnails. Click one to go to its view.
 * Each has a caption, Copy image, Save and Delete (two clicks: a shot isn't undoable); the panel has Save all (one
 * zip). Floating like the inspector, bottom right by default.
 */

/** Starts a download of `blob` (or a URL) as `name`. */
function download(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ShotsPanel({
  shots,
  seq,
  sceneName,
  onGoTo,
  onCaption,
  onRemove,
  onNotice,
  onClose,
}: {
  shots: ShotView[];
  /** The document's history step now: a shot from an earlier one shows the level changed since. */
  seq: number;
  /** For the zip's name. */
  sceneName: string;
  onGoTo: (shot: ShotView) => void;
  onCaption: (id: string, caption: string) => void;
  onRemove: (id: string) => void;
  onNotice: (message: string) => void;
  onClose: () => void;
}) {
  const { ref, header, style, collapsed, toggle } = useFloating("dd.shots", ".shots-header");
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  // The shot whose Delete was pressed once: a second press deletes it. Disarmed after a moment.
  const [armed, setArmed] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  const newestFirst = [...shots].reverse();

  const copy = async (shot: ShotView) => {
    try {
      const png = await (await fetch(shot.url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      onNotice(`Copied ${shot.id}`);
    } catch (err) {
      onNotice(`${shot.id} wasn't copied: the browser refused`);
      reportError("editor", err);
    }
  };

  const saveAll = async () => {
    setZipping(true);
    try {
      const files: Record<string, Uint8Array> = {};
      for (const shot of shots) files[shotFileName(shot)] = new Uint8Array(await (await fetch(shot.url)).arrayBuffer());
      // PNGs are compressed already: store them as they are.
      const zip = zipSync(files, { level: 0 });
      const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
      download(url, `${sceneName.replace(/[\\/:*?"<>|]+/g, " ").trim() || "scene"} shots.zip`);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      onNotice("The shots weren't saved");
      reportError("editor", err);
    } finally {
      setZipping(false);
    }
  };

  const commitCaption = () => {
    if (!editing) return;
    const shot = shots.find((s) => s.id === editing.id);
    if (shot && editing.value.trim() !== (shot.caption ?? "")) onCaption(editing.id, editing.value);
    setEditing(null);
  };

  return (
    <div className={collapsed ? "shots-panel collapsed" : "shots-panel"} ref={ref} style={style}>
      <div className="shots-header" {...header} title="Drag to move the Shots panel · double-click to put it back">
        <GripVertical size={13} className="grip" />
        <span className="shots-title">Shots</span>
        <span className="muted">{shots.length}</span>
        {shots.length > 0 && (
          <button type="button" className="panel-action" title="Save all: one zip of every shot" disabled={zipping} onClick={saveAll}>
            <Download size={13} />
          </button>
        )}
        <button type="button" className="panel-action" title={collapsed ? "Show the shots" : "Collapse"} onClick={toggle}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <button type="button" className="panel-action" title="Close (the view bar's shots button opens it again)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {!collapsed && (
        <div className="shots-grid">
          {shots.length === 0 && (
            <div className="outliner-empty">
              None yet: press <b>K</b> or the camera on the view bar to take one.
            </div>
          )}
          {newestFirst.map((shot) => {
            const changed = shot.seq !== seq;
            const when = new Date(shot.createdAt).toLocaleString();
            return (
              <div key={shot.id} className="shot">
                <button
                  type="button"
                  className="shot-image"
                  title={`${shot.caption ? `${shot.caption}\n` : ""}${shot.id} · ${when}${shot.createdBy === "agent" ? " · by the agent" : ""}${changed ? "\nThe level has changed since" : ""}\nClick to go to this view`}
                  onClick={() => onGoTo(shot)}
                >
                  <img src={shot.url} alt={shot.caption ?? shot.id} loading="lazy" draggable={false} />
                  {shot.createdBy === "agent" && (
                    <span className="shot-badge" title="Taken by the agent">
                      <Bot size={11} />
                    </span>
                  )}
                  {changed && <span className="shot-changed" title="The level has changed since" />}
                </button>
                {editing?.id === shot.id ? (
                  <input
                    className="shot-caption-input"
                    autoFocus
                    value={editing.value}
                    maxLength={MAX_SHOT_CAPTION}
                    placeholder="What this shot is about"
                    onChange={(e) => setEditing({ id: shot.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitCaption();
                      if (e.key === "Escape") setEditing(null);
                    }}
                    onBlur={commitCaption}
                  />
                ) : (
                  <div className="shot-caption" title="Double-click to write a caption" onDoubleClick={() => setEditing({ id: shot.id, value: shot.caption ?? "" })}>
                    <span className="shot-id">{shot.id}</span>
                    <span className={shot.caption ? "text" : "text empty"}>{shot.caption ?? "no caption"}</span>
                  </div>
                )}
                <div className="shot-actions">
                  <button type="button" title="Caption" onClick={() => setEditing({ id: shot.id, value: shot.caption ?? "" })}>
                    <Pencil size={12} />
                  </button>
                  <button type="button" title="Copy the image" onClick={() => void copy(shot)}>
                    <Copy size={12} />
                  </button>
                  <button type="button" title="Save the image" onClick={() => download(shot.url, shotFileName(shot))}>
                    <Download size={12} />
                  </button>
                  <button
                    type="button"
                    className={armed === shot.id ? "danger armed" : "danger"}
                    title={armed === shot.id ? "Click again to delete it for good" : "Delete (a shot can't be undone)"}
                    onClick={() => {
                      if (armed !== shot.id) return setArmed(shot.id);
                      setArmed(null);
                      onRemove(shot.id);
                    }}
                  >
                    <Trash2 size={12} />
                    {armed === shot.id && <span>Delete?</span>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A shot's flash over the view: a new element each time (keyed by the caller), fading out by itself. */
export function ShutterFlash() {
  return <div className="shutter-flash" aria-hidden />;
}

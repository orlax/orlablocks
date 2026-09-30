import { Box, FolderOpen, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ClientMessage, ExportStatus, ExportSummary } from "../shared/scene.types";

/**
 * Export (plan 15 §5), from the top bar, in two kinds:
 * - **Unity:** the project's export folder, chosen in the system's folder dialog (the server opens it: a browser can't
 *   give a folder's path), where each scene gets a folder of its own; Export now with how the last one went, and
 *   Export on every step. An Orlablocks Level in Unity syncs the scene's folder.
 * - **3D file:** the scene as one `.glb`, saved where the human says (the browser's save dialog, or a download).
 */
type Kind = "unity" | "file";
const KIND_KEY = "orlablocks.exportKind";

export function ExportDialog({
  status,
  error,
  send,
  onClose,
}: {
  status: ExportStatus;
  /** The server's last error (a folder dialog that didn't open, an export that failed). */
  error: string | null;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>(() => {
    try {
      return localStorage.getItem(KIND_KEY) === "file" ? "file" : "unity";
    } catch {
      return "unity";
    }
  });
  const choose = (k: Kind) => {
    setKind(k);
    try {
      localStorage.setItem(KIND_KEY, k);
    } catch {
      // Remembering the tab is a convenience.
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal export-dialog">
        <div className="modal-header">
          <h2>
            <Upload size={18} /> Export
          </h2>
          <button type="button" className="icon" title="Close (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="export-kinds" role="tablist">
          <button type="button" role="tab" aria-selected={kind === "unity"} className={kind === "unity" ? "on" : ""} onClick={() => choose("unity")}>
            Unity
          </button>
          <button type="button" role="tab" aria-selected={kind === "file"} className={kind === "file" ? "on" : ""} onClick={() => choose("file")}>
            3D file (.glb)
          </button>
        </div>
        {kind === "unity" ? <UnityExport status={status} error={error} send={send} /> : <FileExport scene={status.scene} />}
      </div>
    </div>
  );
}

function UnityExport({ status, error, send }: { status: ExportStatus; error: string | null; send: (msg: ClientMessage) => void }) {
  return (
    <div className="modal-form">
      <p className="muted">
        Every shape as drawn, holes cut, each entity once. Each scene gets a folder of its own in the export folder. In Unity, an Orlablocks
        Level pointed at the scene's folder syncs it. Choose a folder next to the Unity project's Assets, not inside it.
      </p>
      <div className="export-folder">
        <span className={status.dir ? "path" : "path none"} title={status.dir || undefined}>
          {status.dir || "No folder chosen"}
        </span>
        <button type="button" disabled={status.picking} onClick={() => send({ type: "pick_export_folder" })}>
          <FolderOpen size={14} /> {status.picking ? "Choosing…" : "Choose…"}
        </button>
      </div>
      {status.sceneDir && (
        <p className="muted export-path" title={status.sceneDir}>
          This scene goes to {status.sceneDir}
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={status.auto} disabled={!status.dir} onChange={(e) => send({ type: "set_export_auto", auto: e.target.checked })} />
        Export this scene on every step
      </label>
      {error && <p className="error">{error}</p>}
      <p className="muted export-last">{lastText(status)}</p>
      <div className="actions">
        <button type="button" className="primary" disabled={!status.dir || status.running} onClick={() => send({ type: "export_scene" })}>
          {status.running ? "Exporting…" : "Export now"}
        </button>
      </div>
    </div>
  );
}

/** The browser's save dialog (Chrome, Edge), where there is one. */
type SavePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}>;

function FileExport({ scene }: { scene: string }) {
  const [state, setState] = useState<{ busy: boolean; text: string; error?: boolean }>({ busy: false, text: "" });
  const save = async () => {
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    try {
      // The dialog first, while the click still counts as the human's (the browser requires it).
      const handle = picker ? await picker({ suggestedName: `${scene}.glb`, types: [{ description: "glTF binary", accept: { "model/gltf-binary": [".glb"] } }] }) : null;
      setState({ busy: true, text: "Exporting…" });
      const res = await fetch("/api/export.glb", { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      if (handle) {
        const out = await handle.createWritable();
        await out.write(blob);
        await out.close();
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${scene}.glb`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
      setState({ busy: false, text: `Saved ${scene}.glb (${size(blob.size)}).` });
    } catch (err) {
      // Cancelling the save dialog isn't an error.
      if ((err as Error).name === "AbortError") return setState({ busy: false, text: "" });
      setState({ busy: false, text: `The export failed: ${(err as Error).message}`, error: true });
    }
  };
  return (
    <div className="modal-form">
      <p className="muted">
        The scene as one glTF binary, which Blender, Godot and most 3D tools open: every shape as drawn (holes cut), in its groups, each
        entity's meshes shared by its instances, in the palette's colors. Holes, lines and hidden things are left out.
      </p>
      {state.text && <p className={state.error ? "error" : "muted export-last"}>{state.text}</p>}
      <div className="actions">
        <button type="button" className="primary" disabled={state.busy} onClick={() => void save()}>
          <Box size={14} /> {state.busy ? "Exporting…" : "Save .glb…"}
        </button>
      </div>
    </div>
  );
}

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function summaryText(s: ExportSummary): string {
  const shapes = Object.entries(s.nodes)
    .filter(([type]) => type !== "group")
    .reduce((n, [, c]) => n + c, 0);
  const parts = [`${shapes} node${shapes === 1 ? "" : "s"}`, ...(s.items ? [`${s.items} items`] : []), `${s.entities} entit${s.entities === 1 ? "y" : "ies"}`, size(s.bytes), `${s.ms} ms`];
  return parts.join(" · ");
}

function lastText(status: ExportStatus): string {
  if (!status.dir) return "Choose a folder to export to.";
  const last = status.last;
  if (!last) return "Not exported since the server started.";
  const at = new Date(last.at).toLocaleTimeString();
  if (last.error) return `Failed at ${at}: ${last.error}`;
  const s = last.summary!;
  return `Exported at ${at} (step ${s.exportId}): ${summaryText(s)}${s.warnings.length ? `. ${s.warnings.join(" ")}` : ""}`;
}

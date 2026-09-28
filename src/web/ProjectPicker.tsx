import { Copy, FolderPlus, Pencil, Plus, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { DEFAULT_SCENE_NAME, type ClientMessage, type OpenScene, type ProjectSummary } from "../shared/scene.types";
import { TAGLINE, Wordmark } from "../ui/Wordmark";

type Props = {
  projects: ProjectSummary[];
  open: OpenScene | null;
  /** The server's last error (e.g. a name it rejected, or a scene that didn't load). */
  error: string | null;
  /** Missing while nothing is open: there's no scene to go back to, so the picker can't be dismissed. */
  onClose?: () => void;
  send: (msg: ClientMessage) => void;
};

type Renaming = { kind: "project" | "scene"; id: string; value: string };

/**
 * The project picker (plan 04 §5): projects on the left, the selected project's description and scenes on the
 * right. Clicking a scene opens it (the App closes the picker once the server has opened it). Projects rename on
 * double-click, scenes with their pencil button (a click already opens them). With no projects at all it's only
 * the create project form. The wordmark sits above it; with nothing open it's the **welcome** (plan 12 §6): the
 * paper instead of the view, and the wordmark rises in.
 */
export function ProjectPicker({ projects, open, error, onClose, send }: Props) {
  const [selected, setSelected] = useState<string | null>(open?.project.id ?? projects[0]?.id ?? null);
  const [creating, setCreating] = useState(projects.length === 0);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [newScene, setNewScene] = useState<string | null>(null);

  const project = projects.find((p) => p.id === selected) ?? null;
  const [description, setDescription] = useState(project?.description ?? "");
  useEffect(() => setDescription(project?.description ?? ""), [project?.id, project?.description]);

  // A project list that arrives (or changes) under us: keep a valid selection.
  useEffect(() => {
    if (!project && projects.length > 0) setSelected(projects[0].id);
    if (projects.length === 0) setCreating(true);
  }, [project, projects]);

  // Esc closes (renaming and new-scene inputs handle their own Esc first).
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && onClose && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const commitRename = () => {
    if (!renaming || !project) return;
    const name = renaming.value.trim();
    const current = renaming.kind === "project" ? project.name : project.scenes.find((s) => s.id === renaming.id)?.name;
    // An empty name is rejected: the old one stays.
    if (name && name !== current) {
      if (renaming.kind === "project") send({ type: "update_project", project: project.id, name });
      else send({ type: "rename_scene", project: project.id, scene: renaming.id, name });
    }
    setRenaming(null);
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") {
      e.preventDefault();
      setRenaming(null);
    }
  };
  const renameInput = (r: Renaming) => (
    <input
      className="rename"
      autoFocus
      value={r.value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setRenaming({ ...r, value: e.target.value })}
      onKeyDown={onRenameKey}
      onBlur={commitRename}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );

  const commitNewScene = () => {
    const name = newScene?.trim();
    if (project && name) send({ type: "create_scene", project: project.id, name });
    setNewScene(null);
  };

  const isOpen = (projectId: string, sceneId: string) => open?.project.id === projectId && open.scene.id === sceneId;

  return (
    <div className={onClose ? "modal-backdrop" : "modal-backdrop welcome"} onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <Hero animated={!onClose} />
      <div className={creating ? "modal" : "modal project-picker"}>
        <div className="modal-header">
          <h2>{creating ? <><FolderPlus size={18} /> Create a project</> : "Projects"}</h2>
          {onClose && (
            <button type="button" className="icon" title="Close (Esc)" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>

        {creating ? (
          <CreateProjectForm
            onCreate={(p) => send({ type: "create_project", ...p })}
            onCancel={projects.length > 0 ? () => setCreating(false) : undefined}
          />
        ) : (
          <div className="picker-columns">
            <div className="picker-list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`picker-row${p.id === selected ? " selected" : ""}`}
                  onClick={() => setSelected(p.id)}
                  onDoubleClick={() => !p.error && setRenaming({ kind: "project", id: p.id, value: p.name })}
                  title={p.error}
                >
                  {renaming?.kind === "project" && renaming.id === p.id ? (
                    renameInput(renaming)
                  ) : (
                    <>
                      <span className="label">{p.name}</span>
                      {p.error && <TriangleAlert size={13} className="warn" />}
                      {open?.project.id === p.id && <i className="open-dot" title="Open" />}
                    </>
                  )}
                </div>
              ))}
              <button type="button" className="add" onClick={() => setCreating(true)}>
                <Plus size={14} /> New project
              </button>
            </div>

            <div className="picker-detail">
              {project?.error ? (
                <div className="error">{project.error}</div>
              ) : (
                project && (
                  <>
                    <textarea
                      className="description"
                      value={description}
                      placeholder="Description (the agent reads it)"
                      rows={3}
                      maxLength={2000}
                      onChange={(e) => setDescription(e.target.value)}
                      onBlur={() => {
                        if (description.trim() !== project.description) {
                          send({ type: "update_project", project: project.id, description: description.trim() });
                        }
                      }}
                    />
                    <div className="picker-subhead">Scenes</div>
                    <div className="picker-list">
                      {project.scenes.map((s) => (
                        <div
                          key={s.id}
                          className={`picker-row scene${s.error ? " broken" : ""}${isOpen(project.id, s.id) ? " current" : ""}`}
                          title={s.error ?? (isOpen(project.id, s.id) ? "Open now" : "Open")}
                          onClick={() => {
                            if (s.error || renaming) return;
                            if (isOpen(project.id, s.id)) onClose?.();
                            else send({ type: "open_scene", project: project.id, scene: s.id });
                          }}
                        >
                          {renaming?.kind === "scene" && renaming.id === s.id ? (
                            renameInput(renaming)
                          ) : (
                            <>
                              <span className="label">{s.name}</span>
                              {s.error && <TriangleAlert size={13} className="warn" />}
                              {isOpen(project.id, s.id) && <i className="open-dot" />}
                              {!s.error && (
                                <span className="row-actions">
                                  <button
                                    type="button"
                                    className="icon"
                                    title="Rename"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRenaming({ kind: "scene", id: s.id, value: s.name });
                                    }}
                                  >
                                    <Pencil size={13} />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon"
                                    title="Duplicate (opens the copy)"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      send({ type: "duplicate_scene", project: project.id, scene: s.id });
                                    }}
                                  >
                                    <Copy size={13} />
                                  </button>
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                      {newScene !== null ? (
                        <div className="picker-row">
                          <input
                            className="rename"
                            autoFocus
                            value={newScene}
                            placeholder="Scene name"
                            maxLength={80}
                            onChange={(e) => setNewScene(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitNewScene();
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setNewScene(null);
                              }
                            }}
                            onBlur={commitNewScene}
                          />
                        </div>
                      ) : (
                        <button type="button" className="add" onClick={() => setNewScene("")}>
                          <Plus size={14} /> New scene
                        </button>
                      )}
                    </div>
                  </>
                )
              )}
            </div>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

/** Name, description and first scene. Enter or Create submits. */
function Hero({ animated }: { animated: boolean }) {
  return (
    <header className="hero">
      <Wordmark animated={animated} />
      {animated && <p className="tagline">{TAGLINE}</p>}
    </header>
  );
}

/** The welcome before the server connects: the paper and the wordmark, not a blank page. */
export function Welcome() {
  return (
    <div className="modal-backdrop welcome">
      <Hero animated />
      <p className="muted">Connecting to the server…</p>
    </div>
  );
}

function CreateProjectForm({
  onCreate,
  onCancel,
}: {
  onCreate: (project: { name: string; description: string; sceneName: string }) => void;
  /** Missing when there's nothing to go back to (no projects yet). */
  onCancel?: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sceneName, setSceneName] = useState(DEFAULT_SCENE_NAME);
  const ready = name.trim() !== "" && sceneName.trim() !== "";

  return (
    <form
      className="modal-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onCreate({ name: name.trim(), description: description.trim(), sceneName: sceneName.trim() });
      }}
    >
      <p className="muted">A project holds the scenes (levels) of one game. Everything is saved as you work.</p>
      <label>
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Castle" maxLength={80} />
      </label>
      <label>
        Description <span className="muted">(optional, the agent reads it)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What the game is, what this project explores"
          rows={3}
          maxLength={2000}
        />
      </label>
      <label>
        First scene
        <input value={sceneName} onChange={(e) => setSceneName(e.target.value)} maxLength={80} />
      </label>
      <div className="actions">
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Back
          </button>
        )}
        <button type="submit" className="primary" disabled={!ready}>
          Create
        </button>
      </div>
    </form>
  );
}

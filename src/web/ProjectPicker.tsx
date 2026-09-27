import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { DEFAULT_SCENE_NAME } from "../shared/scene.types";

type Props = {
  /** The server's last error (e.g. a name it rejected), shown in the form. */
  error: string | null;
  onCreate: (project: { name: string; description: string; sceneName: string }) => void;
};

/**
 * The project picker (plan 04 §5). For now it's only the create project form, shown while nothing is open. It
 * can't be dismissed: there's no scene to go back to.
 */
export function ProjectPicker({ error, onCreate }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sceneName, setSceneName] = useState(DEFAULT_SCENE_NAME);
  const ready = name.trim() !== "" && sceneName.trim() !== "";

  return (
    <div className="modal-backdrop">
      <form
        className="modal project-picker"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onCreate({ name: name.trim(), description: description.trim(), sceneName: sceneName.trim() });
        }}
      >
        <h2>
          <FolderPlus size={18} /> Create a project
        </h2>
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
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="submit" className="primary" disabled={!ready}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

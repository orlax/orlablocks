import { useEffect, useState } from "react";
import { DEFAULT_SNAP, validSnap, type SnapSettings } from "./snap";

const FIELDS = [
  ["translation", "Grid / move / resize (m)"],
  ["elevation", "Elevation / height / wall (m)"],
  ["rotation", "Rotation (°)"],
  ["arrayDistance", "Array radius / spacing (m)"],
  ["arrayRotation", "Array start angle (°)"],
] as const;
const draftsOf = (settings: SnapSettings) => Object.fromEntries(FIELDS.map(([key]) => [key, String(settings[key])])) as Record<keyof SnapSettings, string>;

export function SnapControl({ settings, onChange }: { settings: SnapSettings; onChange: (value: SnapSettings) => void }) {
  const [drafts, setDrafts] = useState(() => draftsOf(settings));
  const [error, setError] = useState(false);
  useEffect(() => { setDrafts(draftsOf(settings)); setError(false); }, [settings]);
  return (
    <details className="snap-control">
      <summary>Snap</summary>
      <div className="snap-settings">
        {FIELDS.map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              aria-label={label}
              type="number" min="0.01" max="10000" step="0.01"
              value={drafts[key]}
              onChange={e => setDrafts({ ...drafts, [key]: e.currentTarget.value })}
              onBlur={() => {
                const n = Number(drafts[key]);
                if (validSnap(n)) onChange({ ...settings, [key]: n });
                else { setDrafts(draftsOf(settings)); setError(true); }
              }}
              onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
          </label>
        ))}
        {error && <p role="status">Use 0.01–10000 with at most two decimal places. Kept the previous step.</p>}
        <p>Precision: 0.01 m / 0.01°. Ctrl/Cmd: free. Shift keeps each tool’s constraints. Drawing on a surface keeps its exact height. Surface attraction: 0.25 m; array center attraction: 0.75 m.</p>
        <p>Profile fractions: 0.05; uniform scale: 0.05 (Shift: 0.25).</p>
        <button onClick={() => onChange({ ...DEFAULT_SNAP })}>Reset</button>
      </div>
    </details>
  );
}

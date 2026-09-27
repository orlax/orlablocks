import { Component, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy, RotateCcw, TriangleAlert, X } from "lucide-react";
import { clearErrors, reportError, useErrors, type LoggedError } from "./errors";

/**
 * Catches a render crash in its children, logs it and shows a message with a way to try again, instead of going
 * blank. `scope` "view" guards the 3D view (the rest of the editor keeps working); "editor" guards the whole app,
 * and its message keeps the error panel on screen.
 */
export class ErrorBoundary extends Component<{ scope: "view" | "editor"; children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(this.props.scope, error, info.componentStack ?? undefined);
  }

  render() {
    const { error, attempt } = this.state;
    const { scope, children } = this.props;
    // The key remounts the children when trying again.
    if (!error) return <div key={attempt} className={`${scope}-slot`}>{children}</div>;
    return (
      <div className={`crashed ${scope}`}>
        <TriangleAlert size={20} />
        <p>
          {scope === "view" ? "The 3D view" : "The editor"} stopped on an error: <b>{error.message || error.name}</b>
        </p>
        <p className="muted">The scene is safe: it's on the server. The details are in the error panel, top right.</p>
        <button type="button" onClick={() => this.setState({ error: null, attempt: attempt + 1 })}>
          <RotateCcw size={14} /> {scope === "view" ? "Reload the view" : "Try again"}
        </button>
        {scope === "editor" && <ErrorPanel />}
      </div>
    );
  }
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const asText = (e: LoggedError) => `[${time(e.at)}] ${e.source}: ${e.message}${e.count > 1 ? ` (×${e.count})` : ""}${e.detail ? `\n${e.detail}` : ""}`;

/**
 * The error panel, top right: hidden while there are no errors, then a red count that opens the list (newest
 * first). Each entry opens to its stack. Copy puts the whole log on the clipboard, to paste into a bug report or
 * to Claude.
 */
export function ErrorPanel() {
  const errors = useErrors();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  if (errors.length === 0) return null;
  const total = errors.reduce((n, e) => n + e.count, 0);
  return (
    <div className={open ? "error-panel open" : "error-panel"}>
      <button type="button" className="error-panel-toggle" onClick={() => setOpen(!open)} title="Errors in this tab">
        <TriangleAlert size={14} />
        {total} error{total === 1 ? "" : "s"}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <>
          <div className="error-panel-actions">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(errors.map(asText).join("\n\n"))} title="Copy the log">
              <Copy size={13} /> Copy
            </button>
            <button type="button" onClick={clearErrors} title="Clear the log">
              <X size={13} /> Clear
            </button>
          </div>
          <ul className="error-panel-list">
            {[...errors].reverse().map((e) => (
              <li key={e.id}>
                <button type="button" className="error-entry" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                  <span className="when">{time(e.at)}</span>
                  <span className="source">{e.source}</span>
                  <span className="message">{e.message}</span>
                  {e.count > 1 && <span className="count">×{e.count}</span>}
                </button>
                {expanded === e.id && e.detail && <pre className="error-detail">{e.detail}</pre>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { NO_USES, type Library, type Uses } from "../shared/library";
import { setDefinitions } from "../shared/entities";
import {
  DEFAULT_PLAYER,
  type AgentInfo,
  type ClientMessage,
  type EditorRestore,
  type HistorySummary,
  type OpenScene,
  type PlayerCamera,
  type ProjectSummary,
  type RenderJob,
  type RenderResult,
  type Scene,
  type ServerMessage,
  type ShotView,
} from "../shared/scene.types";

const NO_HISTORY: HistorySummary = { canUndo: false, canRedo: false };

/** What renders the agent's render_view in this tab (09.3): set by the app once the view is up. */
export type RenderHandler = (job: RenderJob) => Promise<RenderResult>;

/** Server is the source of truth: we render whatever scene it last sent. */
export function useScene(renderer?: { current: RenderHandler | null }) {
  const [scene, setScene] = useState<Scene | null>(null);
  const [history, setHistory] = useState<HistorySummary>(NO_HISTORY);
  // The open document's history step, and its shots (09.1).
  const [seq, setSeq] = useState(0);
  const [shots, setShots] = useState<ShotView[]>([]);
  // The open project's player camera (09.2).
  const [player, setPlayer] = useState<PlayerCamera>(DEFAULT_PLAYER);
  // The scene the agent was invited to (14.5), or null.
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // undefined until the server says; null = nothing is open.
  const [open, setOpen] = useState<OpenScene | null | undefined>(undefined);
  // The camera and selection to restore: a new object each time a scene opens (or this tab connects).
  const [restore, setRestore] = useState<EditorRestore | null>(null);
  // The open project's library, its own undo state, and where its tags and skills are used.
  const [library, setLibrary] = useState<{ library: Library | null; history: HistorySummary; uses: Uses }>({
    library: null,
    history: NO_HISTORY,
    uses: NO_USES,
  });
  // Bumped when the definitions change, so what depends on them redraws.
  const [definitionsVersion, setDefinitionsVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        reportTab();
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === "scene") {
          setScene(msg.scene);
          setHistory(msg.history);
          setSeq(msg.seq ?? 0);
          setError(null);
        } else if (msg.type === "projects") {
          setProjects(msg.projects);
        } else if (msg.type === "opened") {
          setOpen(msg.open);
          if (msg.restore) setRestore({ ...msg.restore });
          setError(null);
        } else if (msg.type === "entities") {
          // Before the next render, so every instance draws from these.
          setDefinitions(msg.definitions);
          setDefinitionsVersion((v) => v + 1);
        } else if (msg.type === "shots") {
          setShots(msg.shots);
        } else if (msg.type === "player") {
          setPlayer(msg.player);
        } else if (msg.type === "agent") {
          setAgent(msg.agent);
        } else if (msg.type === "render") {
          const answer = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
          const run = renderer?.current;
          if (!run) answer({ type: "rendered", requestId: msg.requestId, error: "The editor isn't ready to render (no scene shown yet)." });
          else
            run(msg.job).then(
              (result) => answer({ type: "rendered", requestId: msg.requestId, result }),
              (err: unknown) => answer({ type: "rendered", requestId: msg.requestId, error: err instanceof Error ? err.message : String(err) }),
            );
        } else if (msg.type === "library") {
          setLibrary({ library: msg.library, history: msg.history, uses: msg.uses });
        } else if (msg.type === "error") {
          setError(msg.message);
        }
      };
    };

    // Whether this tab is on screen and has focus, so the server asks the right tab to render (09.3).
    const reportTab = () => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tab", visible: document.visibilityState === "visible", focused: document.hasFocus() }));
    };
    window.addEventListener("focus", reportTab);
    window.addEventListener("blur", reportTab);
    document.addEventListener("visibilitychange", reportTab);

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
      window.removeEventListener("focus", reportTab);
      window.removeEventListener("blur", reportTab);
      document.removeEventListener("visibilitychange", reportTab);
    };
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { scene, history, seq, shots, player, agent, projects, open, restore, library, definitionsVersion, connected, error, clearError, send };
}

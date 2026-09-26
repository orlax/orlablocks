import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, HistorySummary, Scene, ServerMessage } from "../shared/scene.types";

const NO_HISTORY: HistorySummary = { canUndo: false, canRedo: false };

/** Server is the source of truth: we render whatever scene it last sent. */
export function useScene() {
  const [scene, setScene] = useState<Scene | null>(null);
  const [history, setHistory] = useState<HistorySummary>(NO_HISTORY);
  const [lastCreated, setLastCreated] = useState<{ requestId: string; ids: string[] } | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === "scene") {
          setScene(msg.scene);
          setHistory(msg.history);
          setError(null);
        } else if (msg.type === "created") {
          setLastCreated({ requestId: msg.requestId, ids: msg.ids });
        } else if (msg.type === "error") {
          setError(msg.message);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { scene, history, lastCreated, connected, error, send };
}

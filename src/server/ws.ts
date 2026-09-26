import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { ClientMessageSchema, type ServerMessage } from "../shared/scene.types";
import { SceneError, type SceneStore } from "./scene";

export function attachWebSocket(httpServer: Server, store: SceneStore) {
  const wss = new WebSocketServer({ noServer: true });

  // Vite's HMR socket shares this HTTP server, so only claim our own path.
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws: WebSocket, msg: ServerMessage) => ws.send(JSON.stringify(msg));

  const sceneMessage = (): ServerMessage => ({ type: "scene", scene: store.getScene(), history: store.getHistory() });

  store.onChange(() => {
    const msg = sceneMessage();
    for (const client of wss.clients) send(client, msg);
  });

  wss.on("connection", (ws) => {
    send(ws, sceneMessage());

    ws.on("message", (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", message: "Message is not valid JSON" });
      }
      const parsed = ClientMessageSchema.safeParse(data);
      if (!parsed.success) return send(ws, { type: "error", message: z.prettifyError(parsed.error) });

      try {
        const msg = parsed.data;
        if (msg.type === "add_boxes") {
          const created = store.drawBoxes(msg.boxes, "human");
          // Sent after the scene broadcast, so the editor already has the boxes it's about to select.
          if (msg.requestId) send(ws, { type: "created", requestId: msg.requestId, ids: created.map((b) => b.id) });
        } else if (msg.type === "update_boxes") store.updateBoxes(msg.changes, "human");
        else if (msg.type === "clear") store.clear("human");
        else if (msg.type === "undo") store.undo();
        else if (msg.type === "redo") store.redo();
        else if (msg.type === "set_view") store.setView(msg.view);
      } catch (err) {
        if (!(err instanceof SceneError)) throw err;
        send(ws, { type: "error", message: err.message });
      }
    });
  });
}

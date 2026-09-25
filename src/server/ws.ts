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

  store.onChange((scene) => {
    for (const client of wss.clients) send(client, { type: "scene", scene });
  });

  wss.on("connection", (ws) => {
    send(ws, { type: "scene", scene: store.getScene() });

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
        if (msg.type === "add_rects") store.addRects(msg.rects, "human");
        else if (msg.type === "clear") store.clear();
        else if (msg.type === "set_view") store.setView(msg.view);
      } catch (err) {
        if (!(err instanceof SceneError)) throw err;
        send(ws, { type: "error", message: err.message });
      }
    });
  });
}

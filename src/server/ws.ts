import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { ClientMessageSchema, type ServerMessage } from "../shared/scene.types";
import { SceneError, type SceneStore } from "./scene";

/** The message minus its `type`: the store's input schemas are strict, so the envelope field must go. */
const withoutType = <T extends { type: string }>({ type: _type, ...rest }: T) => rest;

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
        if (msg.type === "add_boxes") store.drawBoxes(msg.boxes, "human");
        else if (msg.type === "update_nodes") store.updateNodes(msg.changes, "human");
        else if (msg.type === "remove_nodes") store.removeNodes(msg.ids, "human");
        else if (msg.type === "set_selection") store.setSelection(msg.ids);
        else if (msg.type === "move_nodes") store.moveNodes(withoutType(msg), "human");
        else if (msg.type === "rotate_nodes") store.rotateNodes(withoutType(msg), "human");
        else if (msg.type === "group_nodes") store.groupNodes(withoutType(msg), "human");
        else if (msg.type === "ungroup") store.ungroup(withoutType(msg), "human");
        else if (msg.type === "place_nodes") store.placeNodes(withoutType(msg), "human");
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

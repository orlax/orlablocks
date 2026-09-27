import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { ClientMessageSchema, type ServerMessage } from "../shared/scene.types";
import { SceneError } from "./scene";
import type { Workspace } from "./workspace";

/** The message minus its `type`: the store's input schemas are strict, so the envelope field must go. */
const withoutType = <T extends { type: string }>({ type: _type, ...rest }: T) => rest;

export function attachWebSocket(httpServer: Server, workspace: Workspace) {
  const { store } = workspace;
  const wss = new WebSocketServer({ noServer: true });

  // Vite's HMR socket shares this HTTP server, so only claim our own path.
  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws: WebSocket, msg: ServerMessage) => ws.send(JSON.stringify(msg));

  const sceneMessage = (): ServerMessage => ({ type: "scene", scene: store.getScene(), history: store.getHistory() });

  const broadcast = (msg: ServerMessage) => {
    for (const client of wss.clients) send(client, msg);
  };
  store.onChange(() => broadcast(sceneMessage()));
  workspace.onOpened((open, restore) => broadcast({ type: "opened", open, ...(restore ? { restore } : {}) }));
  workspace.onProjectsChanged((projects) => broadcast({ type: "projects", projects }));

  wss.on("connection", (ws) => {
    // The scene before `opened`, so the selection it restores is checked against this scene's nodes.
    send(ws, { type: "projects", projects: workspace.projects() });
    send(ws, sceneMessage());
    const restore = workspace.getRestore();
    send(ws, { type: "opened", open: workspace.getOpen(), ...(restore ? { restore } : {}) });

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
        // View and selection reports aren't edits, and the editor sends them even with nothing open.
        if (msg.type === "set_selection") return workspace.setSelection(msg.ids);
        if (msg.type === "set_view") return workspace.setView(msg.view, msg.camera);
        if (msg.type === "create_project") return void workspace.createProject(withoutType(msg));
        if (msg.type === "update_project") return workspace.updateProject(withoutType(msg));
        if (msg.type === "create_scene") return void workspace.createScene(withoutType(msg));
        if (msg.type === "rename_scene") return workspace.renameScene(withoutType(msg));
        if (msg.type === "duplicate_scene") return void workspace.duplicateScene(withoutType(msg));
        if (msg.type === "open_scene") return workspace.openScene(withoutType(msg));
        const scene = workspace.requireScene();
        if (msg.type === "add_boxes") scene.drawBoxes(msg.boxes, "human");
        else if (msg.type === "update_nodes") scene.updateNodes(msg.changes, "human");
        else if (msg.type === "remove_nodes") scene.removeNodes(msg.ids, "human");
        else if (msg.type === "move_nodes") scene.moveNodes(withoutType(msg), "human");
        else if (msg.type === "rotate_nodes") scene.rotateNodes(withoutType(msg), "human");
        else if (msg.type === "group_nodes") scene.groupNodes(withoutType(msg), "human");
        else if (msg.type === "ungroup") scene.ungroup(withoutType(msg), "human");
        else if (msg.type === "place_nodes") scene.placeNodes(withoutType(msg), "human");
        else if (msg.type === "clear") scene.clear("human");
        else if (msg.type === "undo") scene.undo();
        else if (msg.type === "redo") scene.redo();
      } catch (err) {
        if (!(err instanceof SceneError)) throw err;
        send(ws, { type: "error", message: err.message });
      }
    });
  });
}

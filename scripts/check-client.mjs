// What the scripted checks share (plan 14 §14): a project opened over the editor's WebSocket, as the human would,
// a WebSocket to act as the human, and an MCP client to act as the agent, against a spare server:
//
//   PORT=5171 DATA_DIR=<scratch>/data npm run dev
//
// Never 5170: that's the human's server and data folder.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

/** Connects as the human (a WebSocket) and as the agent (MCP), after creating and opening a fresh project. */
export async function connect(port, { project = `check ${Date.now()}`, scene = "main" } = {}) {
  if (port === 5170) throw new Error("Not on 5170: run it against a spare server with its own DATA_DIR");
  const human = await openHuman(port);
  await human.request({ type: "create_project", name: project, sceneName: scene }, (m) => m.type === "opened" && m.open?.project.name === project);
  const client = new Client({ name: "check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  /** Calls a tool; the result's text parsed as JSON when it is, or the text. Throws on a tool error unless `allowError`. */
  const call = async (name, args = {}, { allowError = false } = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (result.isError && !allowError) throw new Error(`${name}: ${text}`);
    let value = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Plain text.
    }
    return result.isError ? { error: text } : value;
  };
  return { human, call, project, close: async () => (human.close(), await client.close()) };
}

/** A WebSocket as the editor: `send`, `request` (send, then wait for a matching message) and every message seen. */
export async function openHuman(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seen = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    seen.push(msg);
    for (const w of [...waiters]) {
      if (msg.type === "error") w.reject(new Error(msg.message));
      else if (w.match(msg)) w.resolve(msg);
      else continue;
      waiters.splice(waiters.indexOf(w), 1);
    }
  });
  await new Promise((resolve, reject) => (ws.on("open", resolve), ws.on("error", reject)));
  const wait = (match, ms = 5000) =>
    new Promise((resolve, reject) => {
      const found = seen.find(match);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the server")), ms);
      waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)), reject: (e) => (clearTimeout(timer), reject(e)) });
    });
  return {
    seen,
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** Sends, then waits for a message `match` accepts (among those that arrive after sending). */
    request: (msg, match, ms) => {
      seen.length = 0;
      ws.send(JSON.stringify(msg));
      return wait(match, ms);
    },
    wait,
    close: () => ws.close(),
  };
}

/** Fails the check with a message unless `ok`. */
export function check(ok, message) {
  if (!ok) throw new Error(`✗ ${message}`);
  console.log(`✓ ${message}`);
}

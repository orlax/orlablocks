// A scripted run of the temple room of plans/thinking-06 (plan 13 §11): the calls an agent makes to build it,
// against a spare server, printing the size in characters of what each call sends and of what comes back. It guards compactness between increments and
// shows each one's effect. It needs a server of its own:
//
//   PORT=5171 DATA_DIR=<scratch>/data npm run dev
//   node scripts/eval-temple.mjs 5171            (compact results, the default)
//   node scripts/eval-temple.mjs 5171 --verbose  (every edit asks for full results: the tools before plan 13)
//
// It creates a project ("temple eval") over the editor's WebSocket, so the data folder must be a scratch one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

const port = Number(process.argv[2] ?? 5171);
const verbose = process.argv.includes("--verbose");
const EDITS = new Set(["draw_shapes", "update_nodes", "move_nodes", "rotate_nodes", "mirror_nodes"]);
if (port === 5170) throw new Error("Not on 5170: run it against a spare server with its own DATA_DIR");
const base = `http://127.0.0.1:${port}`;

// Open a fresh project, as the human would in the editor.
const project = `temple eval ${Date.now()}`;
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const timer = setTimeout(() => reject(new Error("The project didn't open")), 5000);
  ws.on("error", reject);
  ws.on("open", () => ws.send(JSON.stringify({ type: "create_project", name: project, sceneName: "temple" })));
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === "error") reject(new Error(msg.message));
    if (msg.type === "opened" && msg.open?.project.name === project) {
      clearTimeout(timer);
      ws.close();
      resolve();
    }
  });
});

const client = new Client({ name: "eval-temple", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

const sizes = [];
async function call(label, name, args) {
  const sent = verbose && EDITS.has(name) ? { ...args, verbose: true } : args;
  const result = await client.callTool({ name, arguments: sent });
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (result.isError) throw new Error(`${label}: ${text}`);
  sizes.push([label, JSON.stringify(sent).length, text.length]);
  return JSON.parse(text);
}
const idOf = (result, i = 0) => result.created[i].id;

// A spiral, sampled every 10°, as the agent had to script it in thinking-06. Since 13.2 the script sends `spiral`
// instead (--verbose keeps the sampled points, the tools before plan 13).
const sampled = ({ x, z, radius, from, turn, y, rise }) =>
  Array.from({ length: Math.round(turn / 10) + 1 }, (_, i) => {
    const a = ((from + i * 10) * Math.PI) / 180;
    return { x: +(x + radius * Math.cos(a)).toFixed(2), y: +(y + (rise * i * 10) / turn).toFixed(2), z: +(z - radius * Math.sin(a)).toFixed(2) };
  });

// 1. The structure: since 13.3 the group and its door in the same call (--verbose: draw, then group_nodes).
const chamber = verbose ? [] : [{ type: "group", ref: "chamber", name: "chamber" }];
const inChamber = verbose ? {} : { parent: "$chamber" };
const structure = await call("structure", "draw_shapes", {
  shapes: [
    ...chamber,
    { type: "cylinder", kind: "room", x: 0, z: 0, width: 48, depth: 48, height: 36, sides: 16, name: "hall", ...inChamber },
    { kind: "hole", x: 0, z: 23, width: 3, depth: 2, height: 4, name: "door", ...inChamber },
    { kind: "volume", x: 0, z: 0, width: 44, depth: 44, height: 0.2, color: "red", name: "lava", ...inChamber },
    { type: "cylinder", kind: "volume", x: 0, z: 0, width: 6, depth: 6, height: 18, taper: 0.4, name: "spire", ...inChamber },
    { kind: "volume", x: 0, z: 21, width: 6, depth: 4, height: 1, name: "entrance ledge", ...inChamber },
    { kind: "volume", x: 0, z: -19, width: 8, depth: 4, y: 8, height: 1, name: "north landing", ...inChamber },
  ],
});
if (verbose) await call("group", "group_nodes", { ids: structure.created.map((c) => c.id), name: "chamber" });

// 2. An entity: since 13.3 define_entity (--verbose: its shape off to the side, make_entity, remove the instance).
if (verbose) {
  const slabShape = await call("slab shape", "draw_shapes", { shapes: [{ kind: "volume", x: 80, z: 0, width: 2, depth: 2, height: 0.5, name: "ruin slab" }] });
  const slab = await call("make slab", "make_entity", { ids: [idOf(slabShape)], name: "ruin slab" });
  await call("remove slab instance", "remove_nodes", { ids: [slab.instance.id] });
} else {
  await call("define slab", "define_entity", { name: "ruin slab", shapes: [{ kind: "volume", x: 0, z: 0, width: 2, depth: 2, height: 0.5 }] });
}

// 3. The spines and the arrays on them: since 13.3 in one call, the arrays following the spines by ref.
const spine = (sp) => (verbose ? { points: sampled(sp) } : { spiral: sp });
const spineEntries = [
  { type: "line", ref: "wallSpine", ...spine({ x: 0, z: 0, radius: 17, from: 270, turn: 120, y: 0.5, rise: 8 }), dashed: true, name: "wall spine" },
  { type: "line", ref: "spireSpine", ...spine({ x: 0, z: 0, radius: 5.5, from: 90, turn: 180, y: 14, rise: 3.5 }), dashed: true, name: "spire spine" },
];
const arrayEntries = (wall, spire) => [
  { type: "array", entity: "ruin-slab", layout: { type: "path", along: { id: wall }, place: "count", count: 9 }, name: "wall spiral" },
  { type: "array", entity: "ruin-slab", layout: { type: "path", along: { id: spire }, place: "count", count: 7 }, name: "spire spiral" },
  { type: "array", entity: "ruin-slab", layout: { type: "circle", x: 0, z: 0, y: 12.5, radius: 9, count: 8 }, name: "flame ring" },
];
let spines, arrays;
if (verbose) {
  spines = await call("spines", "draw_shapes", { shapes: spineEntries.map(({ ref: _ref, ...e }) => e) });
  arrays = await call("arrays", "draw_shapes", { shapes: arrayEntries(idOf(spines, 0), idOf(spines, 1)) });
} else {
  const both = await call("spines and arrays", "draw_shapes", { shapes: [...spineEntries, ...arrayEntries("$wallSpine", "$spireSpine")] });
  spines = { created: both.created.slice(0, 2) };
  arrays = { created: both.created.slice(2) };
}

// 4. The critical path through the items (13.4 replaces this with `through`).
// Where the items are: from the compact result's item lines, or (verbose) from get_scene, as before plan 13.
const lines = verbose
  ? (await Promise.all(arrays.created.map((a) => call(`items of ${a.id}`, "get_scene", { root: a.id })))).flatMap((o) => o.root.at)
  : arrays.created.flatMap((a) => a.at);
const stops = lines
  .filter((l) => l.startsWith("array_"))
  .map((l) => {
    const [x, y, z] = l.split(" → ")[1].split(" · ")[0].split(", ").map(Number);
    return { x, y: y + 0.5, z };
  });
await call("critical path", "draw_shapes", { shapes: [{ type: "line", points: stops, color: "yellow", arrow: "end", name: "critical path" }] });

// 5. Looking things up.
await call("find items near the door", "find_nodes", { type: "item", near: { x: 0, z: 17, radius: 4 } });
await call("an array's items", "get_scene", { root: idOf(arrays, 2) });
await call("reshape a spine", "update_nodes", { changes: [{ id: idOf(spines, 0), points: sampled({ x: 0, z: 0, radius: 16, from: 270, turn: 120, y: 0.5, rise: 8 }) }] });

await client.close();
const sum = (k) => sizes.reduce((total, row) => total + row[k], 0);
console.log(`${"sent".padStart(7)} ${"back".padStart(7)}`);
for (const [label, sent, back] of sizes) console.log(`${String(sent).padStart(7)} ${String(back).padStart(7)}  ${label}`);
console.log(`${String(sum(1)).padStart(7)} ${String(sum(2)).padStart(7)}  total characters in ${sizes.length} calls (${sum(1) + sum(2)} both ways)`);

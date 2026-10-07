// 16.3 MCP/browser acceptance, exclusively on a spare server with its own DATA_DIR.
// node scripts/check-16.mjs <port> [render] (render needs a browser connected to that server)
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { check, connect } from "./check-client.mjs";
const port = Number(process.argv[2] ?? 5171);
if (port === 5170) throw new Error("Never run terrain checks against the main server");
// Repeat after selecting an input/toggling Show modifiers in the browser: the clean capture must stay identical.
if (process.argv[3] === "capture") {
  const client = new Client({ name: "terrain-capture-parity", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    const result = await client.callTool({ name: "render_view", arguments: { view: "plan", ids: ["terrain_1"], size: 640 } });
    check(!result.isError, "clean capture repeats after changing local overlay state");
    const img = result.content.find((c) => c.type === "image");
    check(!!img && fs.readFileSync("/private/tmp/orlablocks-terrain-16-3-plan.png").equals(Buffer.from(img.data, "base64")), "selection and Show modifiers do not change the canonical capture (byte-identical PNG)");
  } finally { await client.close(); }
  process.exit(0);
}
const session = await connect(port, { project: `Terrain 16.3 check ${Date.now()}` });
const { call, human } = session;
try {
  check((await call("get_guide", { topic: "terrains" })).includes("place_nodes"), "terrain guide explains the existing outliner order operation");
  const shapes = [
    { type: "group", ref: "assembly", name: "Terrain assembly" },
    { type: "group", ref: "sources", name: "Terrain sources", parent: "$assembly" },
    { type: "terrain", ref: "ground", name: "Ground", source: "$sources", parent: "$assembly", x: 0, z: 0, width: 48, depth: 32, resolution: 513 },
    { type: "box", ref: "hill", name: "Hill", kind: "volume", parent: "$sources", x: 0, z: 0, width: 12, depth: 12, height: 8 },
    { type: "freeform", ref: "courtyard", name: "Courtyard", kind: "volume", parent: "$sources", height: 2, points: [{ x: -6, z: -6 }, { x: 6, z: -6 }, { x: 6, z: 6 }, { x: -6, z: 6 }], terrain: { operation: "set", fade: 0 } },
    { type: "ramp", ref: "path", name: "Rising path", parent: "$sources", width: 3, points: [{ x: -16, y: 1, z: 8, out: { x: 4, z: 4 } }, { x: 16, y: 5, z: 8, in: { x: -4, z: 4 } }], terrain: { operation: "raise", fade: 4 } },
    { type: "box", name: "Ordinary prop", kind: "volume", x: -12, z: -8, width: 2, depth: 2, height: 2, color: "red" },
  ];
  const before = await call("get_scene", { full: true });
  const dry = await call("draw_shapes", { shapes, dry_run: true });
  check(dry.refs.ground && dry.dryRun && (await call("get_scene")).nodes.length === before.nodes.length, "batch refs and draw dry runs return terrain without committing");
  const made = await call("draw_shapes", { shapes });
  const { ground, sources, hill, courtyard, path } = made.refs;
  const t = made.created.find((n) => n.id === ground);
  check(t.source === sources && t.cellSpacing.x === 48 / 512 && t.elevation[1] === 5 && t.bounds.height === 5, "compact terrain results report canonical source, spacing, range and bounds");
  check(!JSON.stringify(made).includes("heights"), "ordinary read/edit results never include height arrays");
  const full = await call("get_scene", { full: true });
  check(full.nodes.find((n) => n.id === hill).terrain.operation === "raise" && full.nodes.find((n) => n.id === courtyard).modifierOrder === 2, "read results include default modifier settings and outliner order");
  const found = (await call("find_nodes", { type: "terrain" })).found[0];
  check(found.source === sources && found.resolution === 513 && found.elevation[1] === 5, "find_nodes reports the same compact terrain metadata");
  const fail = await call("draw_shapes", { shapes: [{ type: "terrain", x: 0, z: 0, width: 2, depth: 2, source: sources }] }, { allowError: true });
  check(fail.error.includes("overlaps") && (await call("get_scene", { full: true })).nodes.length === full.nodes.length, "invalid source ownership fails without a partial edit");
  const invalid = await call("update_nodes", { changes: [{ id: hill, height: 9 }, { id: path, step: 0.2 }], dry_run: true }, { allowError: true });
  check(invalid.error.includes("smooth ramps") && (await call("get_scene", { full: true })).nodes.find((n) => n.id === hill).height === 8, "failed dry-run batches leave geometry untouched");
  await call("place_nodes", { ids: [courtyard], parent: sources, before: hill, dry_run: true });
  check((await call("find_nodes", { type: "terrain" })).found[0].elevation[1] === 5, "reorder dry runs preserve canonical terrain");
  await call("place_nodes", { ids: [courtyard], parent: sources, before: hill });
  check((await call("find_nodes", { type: "terrain" })).found[0].elevation[1] === 8, "agent reorder changes evaluated terrain through the shared outliner operation");
  await human.request({ type: "undo" }, (m) => m.type === "scene" && m.scene.nodes.find((n) => n.id === courtyard)?.terrain?.operation === "set");
  check((await call("find_nodes", { type: "terrain" })).found[0].elevation[1] === 5, "human undo restores the operation order");
  await human.request({ type: "update_nodes", changes: [{ id: path, terrain: { operation: "raise", fade: 6 } }] }, (m) => m.type === "scene" && m.scene.nodes.find((n) => n.id === path)?.terrain?.fade === 6);
  check((await call("find_nodes", { type: "ramp" })).found[0].terrain.fade === 6, "human source edits are immediately readable by the agent");
  check((await call("check_scene")).warnings.some((w) => w.includes("do not verify generated terrain")), "deferred terrain-aware checks explicitly disclose their limitation");
  const exportFolder = `/private/tmp/orlablocks-terrain-export-${Date.now()}`;
  fs.mkdirSync(exportFolder, { recursive: true });
  const status = await human.request({ type: "set_export_folder", dir: exportFolder }, (m) => m.type === "export" && m.export?.dir === exportFolder);
  const exported = await call("export_scene");
  const manifest = JSON.parse(fs.readFileSync(`${status.export.sceneDir}/level.json`, "utf8"));
  check(manifest.version === 2 && manifest.nodes.some(n => n.id === ground && n.terrain.resolution === 513) && !manifest.nodes.some(n => [sources, hill, courtyard, path].includes(n.id)), "MCP Unity export writes native canonical terrain and omits inputs");
  const glb = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/api/export.glb`)).arrayBuffer());
  check(glb.readUInt32LE(0) === 0x46546c67, "editor GLB download is a glTF binary");
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  const terrainMesh = gltf.nodes.find(n => n.extras?.orlablocks?.id === ground)?.mesh;
  check(terrainMesh !== undefined && gltf.accessors[gltf.meshes[terrainMesh].primitives[0].attributes.POSITION].count === 513 ** 2, "GLB download includes full canonical terrain mesh");
  check(!gltf.nodes.some(n => [sources, hill, courtyard, path].includes(n.extras?.orlablocks?.id)), "GLB download omits authoring sources");
  fs.writeFileSync(`${exportFolder}/terrain.glb`, glb);
  console.log(`Export fixtures: ${exportFolder}, step ${exported.exportId}`);
  if (process.argv[3] === "render") {
    // The scripted human is not a renderer; leave only the real browser registered.
    human.close();
    const client = new Client({ name: "terrain-capture-check", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      for (const view of ["plan", "sheet", "node"]) {
        const result = await client.callTool({ name: "render_view", arguments: { view, ids: [ground], size: 640, ...(view === "node" ? { save: true } : {}) } });
        check(!result.isError, `${view} render completes through the editor: ${result.isError ? result.content.filter((c) => c.type === "text").map((c) => c.text).join(" ") : "ok"}`);
        const img = result.content.find((c) => c.type === "image");
        check(!!img, `${view} returns generated terrain as an image`);
        fs.writeFileSync(`/private/tmp/orlablocks-terrain-16-3-${view}.png`, Buffer.from(img.data, "base64"));
      }
      check((await call("get_shots")).shots.length > 0, "a clean canonical terrain capture is kept in Shots");
    } finally { await client.close(); }
  }
  console.log(`Passed terrain authoring/export checks on ${port}; ${ground}, ${sources}, ${hill}, ${courtyard}, ${path}`);
} finally { await session.close(); }

// Phase 19.1 protocol checks. Run only on a spare server with a separate DATA_DIR:
// PORT=5171 DATA_DIR=<scratch>/data npm run dev
// node scripts/check-19.mjs 5171
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { check, connect } from "./check-client.mjs";

const port = Number(process.argv[2] ?? 5171);
if (port === 5170) throw new Error("Use an isolated scratch server");
const session = await connect(port, { project: `19.1 ${Date.now()}` });
const { call, human, opened } = session;
const protocol = new Client({ name: "19.1-schema-check", version: "1" });
try {
  await protocol.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  check(protocol.getServerVersion().version === "0.0.46", "public MCP patch version bumped");
  const { tools } = await protocol.listTools();
  const schema = (name) => tools.find((t) => t.name === name).inputSchema;
  check(schema("find_nodes").additionalProperties === false && schema("find_nodes").properties.ids.maxItems === 100, "emitted find_nodes schema is strict with bounded IDs");
  check(schema("get_scene").properties.ids.maxItems === 100, "emitted get_scene IDs are bounded");
  const variants = schema("draw_shapes").properties.shapes.items.anyOf ?? schema("draw_shapes").properties.shapes.items.oneOf;
  const box = variants.find((v) => v.properties?.kind?.default === "volume");
  check(box && !box.required.includes("kind"), "emitted creation schema makes kind optional with volume default");
  check(schema("update_nodes").properties.changes.items.properties.spiral, "emitted update schema exposes spiral");

  await call("define_entity", { name: "test-block", shapes: [{ x: 0, z: 0, width: 1, depth: 1, height: 1 }] });
  const made = await call("draw_shapes", { shapes: [
    { type: "group", ref: "g", name: "assembly" },
    { kind: "room", x: 0, z: 0, width: 20, depth: 20, parent: "$g", ref: "room" },
    { type: "cylinder", x: 30, z: 0, width: 2, depth: 2, ref: "cylinder" },
    { x: 34, z: 0, width: 2, depth: 2, ref: "box" },
    { type: "ramp", ref: "r", width: 1, spiral: { x: 0, z: 0, radius: 8, turn: 180, y: 0, rise: 2 } },
    { type: "array", ref: "a", entity: "test-block", layout: { type: "path", along: { id: "$r" }, place: "count", count: 4 }, skip: [1] },
    { type: "instance", ref: "standing", entity: "test-block", x: 8, z: 0, on: { id: "$r" } },
    { type: "line", ref: "line", spiral: { x: 0, z: 0, radius: 12, turn: 90, y: 1, rise: 2 } },
  ] });
  const r = made.refs;
  check(made.created.find((n) => n.id === r.box).kind === "volume" && made.created.find((n) => n.id === r.cylinder).kind === "volume", "mixed batch defaults box/cylinder creation kinds");
  await call("update_nodes", { changes: [{ id: r.room, name: "room stays room" }] });
  check((await call("get_scene", { ids: [r.room] })).nodes[0].kind === "room", "omitted update kind preserves room");
  // A larger scene guards against falling back to a broad outline; fixtures only via MCP.
  await call("draw_shapes", { shapes: Array.from({ length: 45 }, (_, i) => ({ x: 100 + i * 2, z: 0, width: 1, depth: 1, parent: r.g })) });
  for (const args of [{ parent: r.g }, { ids: [r.box], typo: true }]) {
    const error = await call("find_nodes", args, { allowError: true });
    check(error.error && /under/.test(error.error) && !error.found, "unknown filters reject with actionable guidance and no listing");
  }
  check((await call("find_nodes", { ids: [r.box, r.room], under: r.g, kind: "room" })).found.length === 1, "ID filter intersects containment/kind");
  const requested = [r.cylinder, r.a, r.line, r.box];
  const multi = await call("get_scene", { ids: [...requested, r.box, "missing"] });
  check(JSON.stringify(multi.nodes.map((n) => n.id)) === JSON.stringify(requested) && multi.missing[0] === "missing", "multi-read deduplicates in order and reports missing");
  check(!multi.nodes[1].at, "multi-read array stays compact by default");
  const group = await call("get_scene", { ids: [r.g] });
  check(group.nodes.length === 1 && group.nodes[0].collapsed, "requested group does not expand implicitly");
  check((await call("get_scene", { ids: [r.g], depth: 1 })).nodes.length === 47, "explicit depth expands only requested groups");
  const items = await call("get_scene", { ids: [`${r.a}/0`, `${r.a}/1`, `${r.a}/999`] });
  check(items.nodes[0].type === "instance" && items.missing.length === 2, "array items resolve as instances; skipped/missing items reported");
  check((await call("find_nodes", { type: "item", ids: [`${r.a}/0`, `${r.a}/1`] })).found.length === 1, "find_nodes IDs filter item lookup");
  for (const args of [{ ids: [r.box], root: r.g }, { ids: Array(101).fill(r.box) }, { ids: [] }]) {
    check((await call("get_scene", args, { allowError: true })).error, "invalid multi-read rejects without fallback");
  }
  const oldReads = await Promise.all(requested.map((root) => call("get_scene", { root })));
  const newRead = await call("get_scene", { ids: requested });
  console.log(JSON.stringify({ workflow: "four unrelated nodes (including array)", before: { calls: 4, bytes: oldReads.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0) }, after: { calls: 1, bytes: Buffer.byteLength(JSON.stringify(newRead)) } }));
  const before = (await call("get_scene", { full: true })).nodes;
  const changes = [
    { id: r.r, spiral: { x: 0, z: 0, radius: 10, from: 0, turn: 180, y: 2, rise: 4 } },
    { id: r.line, spiral: { x: 10, z: 0, radius: 12, from: 90, turn: 90, y: 2, rise: 3 } },
  ];
  await call("update_nodes", { changes, dry_run: true });
  check(isDeepStrictEqual((await call("get_scene", { full: true })).nodes, before), "spiral dry run changes nothing");
  await call("update_nodes", { changes });
  const after = (await call("get_scene", { full: true })).nodes;
  const array = after.find((n) => n.id === r.a);
  check(array.layout.along.id === r.r && JSON.stringify(array) !== JSON.stringify(before.find((n) => n.id === r.a)), "spiral edit preserves node/reference IDs and refreshes attached array");
  check(after.find((n) => n.id === r.standing).y > before.find((n) => n.id === r.standing).y, "standing instance refreshes with ramp surface");
  check(after.every((n) => n.spiral === undefined), "only generated points persist");
  await human.request({ type: "undo" }, (m) => m.type === "scene");
  check(isDeepStrictEqual((await call("get_scene", { full: true })).nodes, before), "one undo restores ramp, line and all dependents");
  await human.request({ type: "redo" }, (m) => m.type === "scene");
  check(isDeepStrictEqual((await call("get_scene", { full: true })).nodes, after), "one redo restores spiral edit");
  for (const change of [
    { id: r.box, spiral: changes[0].spiral },
    { ...changes[0], points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }] },
    { id: r.line, spiral: changes[0].spiral, through: { stops: [r.box, r.room] } },
    { ...changes[0], spiral: { ...changes[0].spiral, radius: 0.1 } },
  ]) {
    check((await call("update_nodes", { changes: [{ id: r.box, name: "must not apply" }, change] }, { allowError: true })).error, "invalid spiral batch rejects");
    check(isDeepStrictEqual((await call("get_scene", { full: true })).nodes, after), "failed batch is atomic");
  }
  const copied = await call("transform_nodes", { ids: [r.r, r.a, r.standing], copy: true, move: { dx: 40, dz: 0 } });
  const copiedNodes = (await call("get_scene", { ids: Object.values(copied.copies) })).nodes;
  check(copiedNodes.find((n) => n.id === copied.copies[r.a]).layout.along.id === copied.copies[r.r], "copied spiral assembly follows copied ramp");
  check(copiedNodes.find((n) => n.id === copied.copies[r.standing]).on.id === copied.copies[r.r], "copied standing instance retains remapped support");
  await human.request({ type: "undo" }, (m) => m.type === "scene");
  check(isDeepStrictEqual((await call("get_scene", { full: true })).nodes, after), "undo copy restores original assembly");
  await human.request({ type: "create_scene", project: opened.project.id, name: "reload-check" }, (m) => m.type === "opened" && m.open?.scene.name === "reload-check");
  await human.request({ type: "open_scene", project: opened.project.id, scene: opened.scene.id }, (m) => m.type === "opened" && m.open?.scene.id === opened.scene.id);
  check(isDeepStrictEqual((await call("get_scene", { full: true })).nodes, after), "save/reopen preserves points and dependent references");
} finally {
  await protocol.close();
  await session.close();
}

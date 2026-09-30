// Scripted checks for plan 15's increments (§13), against a spare server:
//
//   PORT=5171 DATA_DIR=<scratch>/data npm run dev
//   node scripts/check-15.mjs 5171            (every increment's checks)
//   node scripts/check-15.mjs 5171 15.2       (one increment's)
//
// Exports go to a fresh folder under the system's temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, connect } from "./check-client.mjs";

const port = Number(process.argv[2] ?? 5171);
const only = process.argv[3];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "orla-check-15-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manifestIn = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "level.json"), "utf8"));

const CHECKS = {
  // The export: its folder, Export now for the agent, what's written, and exporting after every step.
  async "15.2"({ human, call }) {
    const none = await call("export_scene", {}, { allowError: true });
    check(/No Unity export folder/.test(none.error), "with no folder set, the agent is told to ask the human");
    await human.request({ type: "set_export_folder", dir: "relative/unity" }, () => false, 500).then(
      () => check(false, "a relative folder is refused"),
      (e) => check(/absolute/.test(e.message), "a relative folder is refused"),
    );
    const folder = path.join(root, "unity");
    fs.mkdirSync(folder);
    const status = await human.request({ type: "set_export_folder", dir: folder }, (m) => m.type === "export" && m.export?.dir === folder);
    const dir = status.export.sceneDir;
    check(dir === path.join(folder, status.export.scene) && status.export.auto === false && !status.export.last, "the project's folder is set; the scene's is in it, named by its ID; not exported yet");

    await call("define_entity", { name: "ring", shapes: [{ type: "cylinder", kind: "room", x: 0, z: 0, width: 6, depth: 1, height: 6, wall: 0.5 }] });
    await call("draw_shapes", {
      shapes: [
        { type: "group", ref: "hall", name: "hall", description: "the entry hall" },
        { kind: "room", name: "hall", x: 0, z: -6, width: 10, depth: 8, height: 3, parent: "$hall" },
        { kind: "hole", x: 5, z: -6, width: 0.6, depth: 1, height: 2.2, parent: "$hall" },
        { type: "instance", entity: "ring", x: 20, z: 0, rotation: 90, scale: 2 },
        { type: "array", entity: "ring", layout: { type: "circle", x: 0, z: 40, radius: 10, count: 6 } },
        { type: "note", x: 0, z: 0, text: "start here" },
      ],
    });
    const s = await call("export_scene");
    check(s.nodes.box === 2 && s.items === 6 && s.entities === 1 && s.nodes.note === 1, "the agent's export writes the room, the door, the ring's instance, the array's items and the note");
    const m = manifestIn(dir);
    check(m.format === "orlablocks-unity" && m.version === 1 && m.exportId === s.exportId, "level.json is the manifest, at the step exported");
    check(fs.statSync(path.join(dir, m.meshes.file)).size === m.meshes.bytes, "its binary is there, the size it says");
    const inRange = [...m.nodes, ...m.entities.flatMap((e) => e.nodes)].every((r) => [r.body, r.floor].every((g) => g.offset + g.vertices * 32 + g.indices * 4 <= m.meshes.bytes));
    check(inRange, "every mesh range is inside the binary");
    const hall = m.nodes.find((r) => r.name === "hall" && r.type === "group");
    check(hall.description === "the entry hall" && hall.position[2] === 6, "the group keeps its description, with z flipped (south of the origin in orlablocks is north in Unity: z 6)");
    const room = m.nodes.find((r) => r.type === "box" && r.kind === "room");
    check(room.parent === hall.id && room.floor.vertices > 0 && room.collider === "mesh", "the room is in its group, with its floor and a mesh collider");
    const ring = m.nodes.find((r) => r.type === "instance");
    check(ring.euler[1] === -90 && ring.scale === 2, "the instance's turn changes sign, and its scale is kept");

    // Export on every step: a human step exports about a second later.
    await human.request({ type: "set_export_auto", auto: true }, (m) => m.type === "export" && m.export?.auto);
    await sleep(1500);
    const before = manifestIn(dir).exportId;
    human.send({ type: "add_shapes", shapes: [{ kind: "volume", x: 30, z: 30, width: 2, depth: 2, height: 2 }] });
    await sleep(1800);
    const after = manifestIn(dir);
    check(after.exportId > before && after.nodes.some((r) => r.type === "box" && r.kind === "volume"), "with Export on every step, a human step is exported");
    await human.request({ type: "set_export_auto", auto: false }, (m) => m.type === "export" && m.export?.auto === false);

    // The same scene as a 3D file.
    const res = await fetch(`http://127.0.0.1:${port}/api/export.glb`);
    const glb = Buffer.from(await res.arrayBuffer());
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
    check(res.ok && glb.readUInt32LE(0) === 0x46546c67 && json.asset.version === "2.0", "/api/export.glb is a glTF binary");
    const names = json.nodes.map((n) => n.name);
    check(names.includes("hall (group_1)") && !json.nodes.some((n) => n.extras?.orlablocks?.kind === "hole"), "its nodes are named name (id), and the door hole is left out");
  },

  // Speed: a first export and one after a single step, of a scene of a few hundred shapes and items.
  async "15.2-speed"({ human, call }) {
    const folder = path.join(root, "big");
    fs.mkdirSync(folder);
    await human.request({ type: "set_export_folder", dir: folder }, (m) => m.type === "export" && m.export?.dir === folder);
    await call("define_entity", { name: "pillar", shapes: [{ type: "cylinder", kind: "volume", x: 0, z: 0, width: 1, depth: 1, height: 4, sides: 8, bevel: 0.3 }] });
    const shapes = [];
    for (let i = 0; i < 300; i++)
      shapes.push({ kind: i % 3 === 0 ? "room" : "volume", x: (i % 20) * 12, z: Math.floor(i / 20) * 12, width: 8, depth: 6, height: 3, rotation: (i * 7) % 90, ...(i % 3 === 0 ? {} : { taper: 0.2 }) });
    shapes.push({ type: "array", entity: "pillar", layout: { type: "grid", x: 0, y: 0, z: 200, columns: 20, rows: 10, spacing: { x: 3, z: 3 } } });
    await call("draw_shapes", { shapes });
    const first = await call("export_scene");
    await call("draw_shapes", { shapes: [{ kind: "volume", x: -20, z: 0, width: 2, depth: 2, height: 2 }] });
    const second = await call("export_scene");
    console.log(`  first export ${first.ms} ms (${first.size}, ${first.meshes} meshes), after one step ${second.ms} ms`);
    check(second.ms < first.ms, "an export after one step is faster than the first (baked shapes are cached)");
  },
};

try {
  for (const [name, run] of Object.entries(CHECKS)) {
    if (only && !name.startsWith(only)) continue;
    console.log(`— ${name}`);
    const session = await connect(port, { project: `check ${name} ${Date.now()}` });
    try {
      await run(session);
    } finally {
      await session.close();
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

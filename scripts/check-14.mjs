// Scripted checks for plan 14's increments (§14), against a spare server:
//
//   PORT=5171 DATA_DIR=<scratch>/data npm run dev
//   node scripts/check-14.mjs 5171            (every increment's checks)
//   node scripts/check-14.mjs 5171 14.3       (one increment's)
import { check, connect } from "./check-client.mjs";

const port = Number(process.argv[2] ?? 5171);
const only = process.argv[3];

const CHECKS = {
  // The agent sees where the human's pointer rests.
  async "14.1"({ human, call }) {
    const view = { focus: { x: 0, z: 0 }, yaw: 45, bounds: { x: -30, z: -20, width: 60, depth: 40 }, pointer: { x: 3, y: 2, z: -4, id: "box_1" } };
    human.send({ type: "set_view", view, camera: { focus: { x: 0, z: 0 }, yaw: 45, distance: 75 } });
    await new Promise((r) => setTimeout(r, 200));
    const scene = await call("get_scene");
    check(scene.view.pointer?.id === "box_1" && scene.view.pointer.y === 2, "get_scene's view says where the pointer rests");
  },

  // Leaner results and validation: a dry run changes nothing, notes come short, facing works.
  async "14.2"({ call }) {
    const dry = await call("draw_shapes", { dry_run: true, shapes: [{ kind: "room", x: 0, z: 0, width: 8, depth: 6 }] });
    check(dry.dryRun && dry.created[0].id === "box_1", "a dry run says what it would draw");
    const after = await call("get_scene");
    check(after.nodes.length === 0, "and draws nothing");
    const bad = await call("draw_shapes", { dry_run: true, shapes: [{ type: "ramp", ref: "coil", spiral: { x: 0, z: 0, radius: 0.5, turn: 180, y: 0, rise: 1 }, width: 2 }] }, { allowError: true });
    check(/ref "coil"/.test(bad.error) && /needs at least 1 m/.test(bad.error), "a failing entry is named by its ref, and the ramp error gives the radius it needs");
    const text = "x".repeat(300);
    await call("draw_shapes", { shapes: [{ type: "note", x: 1, z: 1, text }, { type: "line", ref: "route", points: [{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -10 }] }] });
    const scene = await call("get_scene", { depth: 1 });
    check(scene.nodes.length === 2, "the scene has the note and the line");
    const full = await call("get_scene", { notes: "full" });
    check(full.nodes.find((n) => n.type === "note").text.length === 300, "notes: full has the whole text");
    await call("define_entity", { name: "ring", shapes: [{ type: "cylinder", kind: "volume", x: 0, z: 0, width: 4, depth: 0.5, height: 4 }] });
    const ring = await call("draw_shapes", { shapes: [{ type: "instance", entity: "ring", x: 3, z: 0, rotation: { along: "line_1" } }] });
    check(ring.created[0].rotation === 90, "a ring faces along the route (north)");
    const arr = await call("draw_shapes", { shapes: [{ type: "array", entity: "ring", layout: { type: "circle", x: 0, z: 0, radius: 10, count: 12 } }] });
    check(typeof arr.created[0].at === "string" && arr.created[0].tops !== undefined, "an array's result gives its tops, not its item lines");
    const withItems = await call("update_nodes", { items: true, changes: [{ id: arr.created[0].id, layout: { radius: 12 } }] });
    check(Array.isArray(withItems.updated[0].at) && withItems.updated[0].at.length === 12, "items: true lists them");
  },
};

for (const [name, run] of Object.entries(CHECKS)) {
  if (only && name !== only) continue;
  console.log(`— ${name}`);
  const session = await connect(port, { project: `check ${name} ${Date.now()}` });
  try {
    await run(session);
  } finally {
    await session.close();
  }
}

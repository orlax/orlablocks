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

  // Uniform scale: the human's sketch made again at scale in one call; the human's scale over the WebSocket.
  async "14.3"({ human, call }) {
    await call("define_entity", { name: "peak", shapes: [{ type: "cylinder", kind: "volume", x: 0, z: 0, width: 4, depth: 4, height: 6, sides: 7, taper: 0.8 }] });
    const sketch = await call("draw_shapes", {
      shapes: [
        { type: "group", ref: "s", name: "sketch" },
        { kind: "room", x: 0, z: 0, width: 4, depth: 3, height: 1, parent: "$s" },
        { type: "instance", ref: "p", entity: "peak", x: 3, z: 0, parent: "$s" },
        { type: "line", through: { stops: ["$p", "box_1"] }, parent: "$s" },
      ],
    });
    const group = sketch.refs.s;
    const made = await call("transform_nodes", { ids: [group], copy: true, scale: 4.5, mirror: "x", to: { x: 100, z: 0 } });
    check(made.copies && made.copies.box_1 && made.copies.instance_1, "the copy says which copy is which");
    const scene = await call("get_scene", { full: true });
    const room = scene.nodes.find((n) => n.id === made.copies.box_1);
    const peak = scene.nodes.find((n) => n.id === made.copies.instance_1);
    check(room.width === 18 && room.height === 4.5 && room.wall === 0.9, "the room grew 4.5×, its walls too");
    check(peak.scale === 4.5 && peak.x < 100, "the peak grew through its scale, and the mirror put it west of the pivot");
    const line = scene.nodes.find((n) => n.id === made.copies.line_1);
    check(line.through.stops[0] === made.copies.instance_1, "the copied route goes through the copies");
    human.send({ type: "transform_nodes", ids: [made.copies.box_1], scale: 0.5 });
    await new Promise((r) => setTimeout(r, 200));
    const after = await call("find_nodes", { name: "" });
    const halved = (await call("get_scene", { full: true })).nodes.find((n) => n.id === made.copies.box_1);
    check(halved.width === 9 && halved.wall === 0.45 && after.found.length > 0, "the human's Scale… halves it, walls too");
  },

  // Free tilt: a group of peaks leaning together, and back; a tilted free-form and array.
  async "14.4"({ call }) {
    await call("define_entity", { name: "peak", shapes: [{ type: "cylinder", kind: "volume", x: 0, z: 0, width: 4, depth: 4, height: 8, taper: 0.9 }] });
    const drawn = await call("draw_shapes", {
      shapes: [
        { type: "group", ref: "g", name: "peaks" },
        { type: "instance", entity: "peak", x: 0, z: 0, parent: "$g" },
        { type: "instance", entity: "peak", x: 6, z: 0, parent: "$g" },
        { type: "freeform", kind: "volume", points: [{ x: -4, z: -2 }, { x: 10, z: -2 }, { x: 3, z: 4 }], height: 1, parent: "$g" },
        { type: "array", entity: "peak", layout: { type: "circle", x: 20, y: 0, z: 0, radius: 6, count: 6 }, parent: "$g" },
      ],
    });
    const tilted = await call("rotate_nodes", { ids: [drawn.refs.g], axis: "z", degrees: 20 });
    const scene = await call("get_scene", { full: true });
    const peaks = scene.nodes.filter((n) => n.type === "instance");
    // + around z leans the tops west: what's east of the pivot rises, so the eastern peak ends higher.
    check(peaks.every((p) => p.roll === 20) && peaks[1].y > peaks[0].y, "the peaks lean together (roll 20), the eastern one higher");
    check(scene.nodes.find((n) => n.type === "freeform").roll === 20 && scene.nodes.find((n) => n.type === "array").roll === 20, "the free-form and the array lean with them");
    await call("rotate_nodes", { ids: [drawn.refs.g], axis: "z", degrees: -20, pivot: tilted.pivot });
    const back = await call("get_scene", { full: true });
    check(back.nodes.filter((n) => n.type === "instance").every((p) => !p.roll && Math.abs(p.y) < 0.02), "and back upright");
  },

  // Work with agent: the agent keeps its scene while the human works in another.
  async "14.5"({ human, call, opened }) {
    const agentScene = opened.scene.id;
    await human.request({ type: "invite_agent" }, (m) => m.type === "agent" && m.agent);
    await human.request({ type: "create_scene", project: opened.project.id, name: "race human" }, (m) => m.type === "opened" && m.open?.scene.name === "race human");
    const agentMsg = await human.wait((m) => m.type === "agent" && m.agent?.apart === true);
    check(agentMsg.agent.name !== "race human", "the chip says the agent works apart, in its own scene");
    await call("draw_shapes", { shapes: [{ kind: "room", x: 0, z: 0, width: 10, depth: 8, name: "agent hall" }] });
    const mine = await call("get_scene");
    check(mine.scene.id === agentScene && /This scene is yours/.test(mine.agent), "the agent reads its own scene, told the human is elsewhere");
    human.send({ type: "add_shapes", shapes: [{ kind: "volume", x: 5, z: 5, width: 2, depth: 2, name: "human block" }] });
    await human.wait((m) => m.type === "scene" && m.scene.nodes.some((n) => n.name === "human block"));
    const still = await call("get_scene");
    check(still.nodes.length === 1 && still.nodes[0].name === "agent hall", "the human's edits land in their scene, not the agent's");
    // A render of the agent's scene goes to the human's tab (showing another scene) with the agent's nodes in the job.
    human.send({ type: "tab", visible: true, focused: true });
    await new Promise((r) => setTimeout(r, 100));
    const rendering = call("render_view", { view: "plan" });
    const asked = await human.wait((m) => m.type === "render");
    check(asked.job.nodes?.some((n) => n.name === "agent hall") && !asked.job.nodes.some((n) => n.name === "human block"), "render_view sends the agent's scene to a tab that shows another");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    human.send({ type: "rendered", requestId: asked.requestId, result: { image: png, width: 1, height: 1, text: "plan" } });
    await rendering;
    await human.request({ type: "open_scene", project: opened.project.id, scene: agentScene }, (m) => m.type === "scene" && m.scene.nodes.some((n) => n.name === "agent hall"));
    check(true, "opening the agent's scene shows its work");
    await human.request({ type: "stop_agent" }, (m) => m.type === "agent" && m.agent === null);
    const told = await call("get_scene", {}, { allowError: true });
    check(/stopped working with you/.test(told.error ?? ""), "the agent is told once that the invitation ended");
  },

  // What the human changed: a hint in get_scene, then the net diff in get_changes.
  async "14.6"({ human, call }) {
    const drawn = await call("draw_shapes", { shapes: [{ type: "freeform", kind: "volume", name: "valley peak", height: 200, points: [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 20, z: 30 }] }] });
    const id = drawn.created[0].id;
    human.send({ type: "update_nodes", changes: [{ id, height: 143, points: [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 25, z: 30 }, { x: 10, z: 20 }] }] });
    await human.wait((m) => m.type === "scene" && m.scene.nodes.some((n) => n.id === id && n.height === 143));
    human.send({ type: "update_library", upsert: [{ kind: "tag", name: "boundary", description: "seals the level" }] });
    await new Promise((r) => setTimeout(r, 200));
    const scene = await call("get_scene");
    check(/1 human step since your last/.test(scene.changes ?? ""), "get_scene says the human made a step since the agent's last");
    const changes = await call("get_changes");
    const peak = changes.diff.changed.find((c) => c.id === id);
    check(peak.fields.height === "200 → 143" && /3 → 4/.test(peak.fields.points), "get_changes gives the height and the points that changed");
    check((changes.elsewhere ?? []).some((e) => /library/.test(e)), "and the human's library edit");
  },

  // Sealing: a ring of peaks that leaks above where they overlap, found in text and in a slice.
  async "14.7"({ human, call }) {
    await call("define_entity", { name: "peak", shapes: [{ type: "cylinder", kind: "volume", x: 0, z: 0, width: 18, depth: 18, height: 40, taper: 1 }] });
    await call("draw_shapes", { shapes: [{ type: "array", entity: "peak", layout: { type: "circle", x: 0, y: 0, z: 0, radius: 20, count: 8 } }] });
    const low = await call("check_enclosure", { from: { x: 0, y: 1, z: 0 }, band: [0, 4], cell: 1 });
    check(low.sealed === true, "sealed below 4 m, where the peaks overlap");
    const high = await call("check_enclosure", { from: { x: 0, y: 1, z: 0 }, band: [0, 30], cell: 1 });
    check(high.sealed === false && high.escapes.length >= 2 && /array_1\/\d/.test(high.escapes[0].between[0] ?? ""), "leaking higher up, between two of the ring's items");
    human.send({ type: "tab", visible: true, focused: true });
    await new Promise((r) => setTimeout(r, 100));
    const rendering = call("render_view", { view: "plan", slice: [2, 20], gap: 10 });
    const asked = await human.wait((m) => m.type === "render");
    check(asked.job.sections?.length === 2 && asked.job.sections[0].gaps.length === 0 && asked.job.sections[1].gaps.length === 8, "a slice render's job has the sections, gaps only at 20 m");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    human.send({ type: "rendered", requestId: asked.requestId, result: { image: png, width: 1, height: 1, text: "slice" } });
    await rendering;
  },

  // Measuring a flight path, and the lint pass.
  async "14.8"({ call }) {
    await call("define_entity", { name: "ring", shapes: [{ type: "cylinder", kind: "room", x: 0, z: 0, width: 6, depth: 1, height: 6, wall: 0.5 }] });
    const drawn = await call("draw_shapes", {
      shapes: [
        { kind: "volume", name: "peak", x: 60, z: 4, width: 4, depth: 4, height: 60 },
        { type: "line", ref: "route", points: [{ x: 0, y: 20, z: 0 }, { x: 100, y: 20, z: 0 }, { x: 140, y: 60, z: 0 }] },
        { type: "instance", entity: "ring", x: 30, y: 122, z: 0, name: "typo ring" },
        { type: "note", x: 0, z: 0, text: "rings between array_7/3 and box_1" },
      ],
    });
    const m = await call("measure_path", { id: drawn.refs.route, speed: 16, climb_rate: 6, probe: 5 });
    check(Math.round(m.length) === 157 && Math.round(m.time * 10) === 98, "the route's length and time at 16 m/s");
    check(m.overClimbRate.length === 1 && m.clearance.against === "box_1" && m.clearance.tightest < 3, "its climb over 6 m/s, and its tightest clearance against the peak");
    const lint = await call("check_scene");
    const ids = lint.findings.map((f) => `${f.check}:${f.id}`);
    check(ids.includes("floating:instance_1") && ids.includes("stale_notes:note_1"), "the lint finds the ring at y 122 and the note naming array_7");
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

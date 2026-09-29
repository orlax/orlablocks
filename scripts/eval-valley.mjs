// A scripted run of the valley of plan 14 §1 (the flight level of thinking-07): the calls an agent makes with the
// phase-14 tools, against a spare server, printing each call's size in characters sent and received, as
// eval-temple.mjs does for plan 13. The human's parts (a sketch, a reshaped mountain) go over the editor's WebSocket.
//
//   PORT=5171 DATA_DIR=<scratch>/data npm run dev
//   node scripts/eval-valley.mjs 5171
import { connect } from "./check-client.mjs";

const port = Number(process.argv[2] ?? 5171);
const { human, call: rawCall, close } = await connect(port, { project: `valley eval ${Date.now()}`, scene: "valley agent" });
const sizes = [];
const call = async (label, name, args) => {
  const result = await rawCall(name, args);
  sizes.push([label, JSON.stringify(args).length, JSON.stringify(result).length]);
  return result;
};

// The human's sketch at 1:10: a ring of peaks round a valley, a ridge, and a route with a ring on it.
human.send({
  type: "add_shapes",
  shapes: [{ type: "group", ref: "s", name: "sketch" }, ...Array.from({ length: 10 }, (_, n) => {
    const a = (n / 10) * 2 * Math.PI;
    return { type: "cylinder", kind: "volume", x: Math.round(Math.cos(a) * 60) / 10, z: Math.round(Math.sin(a) * 60) / 10, width: 2.4, depth: 2.4, height: 12, taper: 0.9, parent: "$s" };
  }), { type: "line", points: [{ x: -4, y: 2, z: 0 }, { x: 0, y: 3, z: 2 }, { x: 4, y: 2, z: 0 }], parent: "$s", name: "route" }],
});
await human.wait((m) => m.type === "scene" && m.scene.nodes.some((n) => n.name === "sketch"));

const scene = await call("read the scene", "get_scene", {});
const sketch = scene.nodes.find((n) => n.name === "sketch").id;
await call("the ring entity", "define_entity", { name: "race ring", shapes: [{ type: "cylinder", kind: "room", x: 0, z: 0, width: 6, depth: 0.6, height: 6, wall: 0.5 }] });
// The sketch made again at 4.5× in one call (before 14: re-derived point by point).
const made = await call("the sketch at scale", "transform_nodes", { ids: [sketch], copy: true, scale: 4.5, to: { x: 200, z: 0 } });
const route = made.copies[scene.nodes.find((n) => n.name === "route")?.id ?? "line_1"];
// Rings along the route, facing along it (before 14: an atan2 per ring).
await call("rings on the route", "draw_shapes", {
  shapes: [-12, 0, 12].map((x) => ({ type: "instance", entity: "race-ring", x: 200 + x, y: 10, z: x === 0 ? 7 : 3, rotation: { along: route } })),
});
// Sealing: where does the air get out below the ceiling?
const leak = await call("is it sealed", "check_enclosure", { from: { x: 200, y: 5, z: 0 }, band: [0, 40], cell: 2 });
console.log(leak.sealed ? "sealed" : leak.escapes.map((g) => `gap ${g.width} m at ${g.at.x}, ${g.at.z}, y ${g.y.join("–")} between ${g.between.join(", ")}`).join("\n"));
await call("the route's numbers", "measure_path", { id: route, speed: 16, climb_rate: 6, probe: 5 });
await call("lint", "check_scene", {});
// The human reshapes a peak between turns; the agent's next read says so, and get_changes says what.
const peak = Object.values(made.copies).find((id) => id.startsWith("cylinder_"));
human.send({ type: "update_nodes", changes: [{ id: peak, height: 40 }] });
await human.wait((m) => m.type === "scene" && m.scene.nodes.some((n) => n.id === peak && n.height === 40));
await call("read again", "get_scene", {});
await call("what changed", "get_changes", {});
await close();

const width = Math.max(...sizes.map(([l]) => l.length));
for (const [label, sent, got] of sizes) console.log(`${String(sent).padStart(7)} ${String(got).padStart(7)}  ${label.padEnd(width)}`);
const [sent, got] = sizes.reduce(([a, b], [, s, g]) => [a + s, b + g], [0, 0]);
console.log(`${String(sent).padStart(7)} ${String(got).padStart(7)}  total characters in ${sizes.length} calls (${sent + got} both ways)`);

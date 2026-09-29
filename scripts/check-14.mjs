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

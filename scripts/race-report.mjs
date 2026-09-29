// The design race of plan 14 (14.10): the human and the agent each build from the same brief, in two scenes of one
// project (the agent's invited with Work with agent). This reads each scene's history and says how long each took,
// how many steps each made, and who made them. Read-only; run it on the data folder after the race:
//
//   node scripts/race-report.mjs <data folder> <project> <scene> [<scene> ...]
//
// e.g. node scripts/race-report.mjs ./data valley valley-human valley-agent
import fs from "node:fs";
import path from "node:path";

const [dataDir, project, ...scenes] = process.argv.slice(2);
if (!dataDir || !project || scenes.length === 0) {
  console.error("usage: node scripts/race-report.mjs <data folder> <project> <scene> [<scene> ...]");
  process.exit(1);
}
const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
for (const scene of scenes) {
  const dir = path.join(dataDir, "projects", project, "scenes", scene);
  const lines = fs.existsSync(path.join(dir, "history.jsonl"))
    ? fs.readFileSync(path.join(dir, "history.jsonl"), "utf8").trimEnd().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const file = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8"));
  const steps = lines.filter((l) => l.type === "commit");
  const by = (actor) => steps.filter((l) => l.actor === actor).length;
  const times = lines.map((l) => l.at).filter(Number.isFinite);
  const [first, last] = [Math.min(...times), Math.max(...times)];
  console.log(`${file.name} (${scene})`);
  if (lines.length === 0) {
    console.log("  no steps yet\n");
    continue;
  }
  console.log(`  ${new Date(first).toISOString().slice(11, 19)} to ${new Date(last).toISOString().slice(11, 19)} UTC: ${clock(last - first)}`);
  console.log(`  ${steps.length} steps (human ${by("human")}, agent ${by("agent")}), ${lines.length - steps.length} undo or redo`);
  console.log(`  ${file.nodes.length} nodes now`);
  // The longest pause between two steps: where one side stopped to think (or to wait).
  let pause = { ms: 0, at: 0 };
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > pause.ms) pause = { ms: times[i] - times[i - 1], at: times[i - 1] };
  if (pause.ms > 0) console.log(`  longest pause ${clock(pause.ms)} after ${new Date(pause.at).toISOString().slice(11, 19)}\n`);
}

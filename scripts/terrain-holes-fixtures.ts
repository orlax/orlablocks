/** Phase 20 exports for the real Unity importer; no scene storage is opened. */
import path from "node:path";
import fs from "node:fs";
import { createSceneStore } from "../src/server/scene";
import { exportScene } from "../src/server/export";
import { EMPTY_LIBRARY } from "../src/shared/library";
const root = process.argv[2];
if (!root || !path.resolve(root).startsWith("/private/tmp/")) throw new Error("Use /private/tmp scratch exports");
fs.mkdirSync(root, { recursive: true });
const store = createSceneStore();
store.drawShapes([
  { type: "group", ref: "sources", name: "Sources" },
  { type: "terrain", source: "$sources", x: 10, z: 7, y: -2, width: 32, depth: 16, resolution: 129, color: "green" },
  { type: "box", kind: "volume", parent: "$sources", x: 5, z: 3, y: -1, width: 8, depth: 6, height: 4 },
], "human");
let seq = 0;
const save = (name: string) => exportScene({ dir: path.join(root, name), seq: ++seq, project: { id: "terrain-check-20", name: "Scratch", description: "" }, scene: { id: "s", name: "Terrain holes" }, nodes: store.getScene().nodes, library: EMPTY_LIBRARY });
await save("none");
store.drawShapes([
  { type: "box", kind: "hole", parent: "group_1", x: 5, z: 3, y: 2, width: 4, depth: 2, height: 2 },
  { type: "cylinder", kind: "hole", parent: "group_1", x: 20, z: 10, y: -3, width: 3, depth: 3, height: 2 },
], "human");
await save("holes");
store.updateNodes([{ id: "box_2", x: 7 }], "human"); await save("moved");
store.updateNodes([{ id: "box_2", x: 10, z: 7, y: -10, width: 100, depth: 100, height: 30 }], "human"); await save("all");
console.log(root);

/** Isolated Unity acceptance exports; no workspace data is opened. */
import fs from "node:fs";
import path from "node:path";
import { createSceneStore } from "../src/server/scene";
import { exportScene } from "../src/server/export";
import { EMPTY_LIBRARY } from "../src/shared/library";
const root = process.argv[2];
if (!root || !path.resolve(root).startsWith("/private/tmp/")) throw new Error("Use a /private/tmp scratch folder");
fs.mkdirSync(root, { recursive: true });
const store = createSceneStore();
store.drawShapes([
  { type: "box", kind: "volume", x: 5, z: 3, y: -1, width: 8, depth: 6, height: 4, terrain: { operation: "raise", fade: 2 } },
  { type: "cylinder", kind: "volume", x: 16, z: 11, y: 0, width: 7, depth: 5, height: 7, bevel: 0.6 },
  { type: "box", kind: "volume", x: 22, z: 1, y: -6, width: 4, depth: 4, height: 1, terrain: { operation: "lower", fade: 2 } },
  { type: "box", kind: "volume", x: 50, z: 0, width: 2, depth: 2 },
], "human");
let seq = 0;
async function save(name: string, noCollisions = false, red = false) {
  await exportScene({ dir: path.join(root, name), project: { id: "terrain-check-16-4", name: "Scratch", description: "" }, scene: { id: "s", name: "Terrain acceptance" }, seq: ++seq, nodes: store.getScene().nodes.map(n => n.type === "terrain" ? { ...n, ...(noCollisions ? { tags: ["no-collisions"] } : {}), ...(red ? { color: "red" } : {}) } : n), library: EMPTY_LIBRARY });
}
await save("ordinary");
store.drawShapes([{ type: "group", ref: "sources" }, { type: "terrain", source: "$sources", x: 10, z: 7, width: 32, depth: 16, y: -2, resolution: 129 }], "human");
store.placeNodes({ ids: ["box_1", "cylinder_1", "box_2"], parent: "group_1", before: null }, "human");
await save("first");
store.updateNodes([{ id: "box_1", height: 6 }], "human");
await save("changed");
store.drawShapes([{ type: "box", kind: "volume", x: 60, z: 0, width: 2, depth: 2 }], "human");
await save("unchanged");
await save("no-collisions", true);
await save("color", false, true);
store.removeNodes(["terrain_1"], "human");
await save("deleted");
console.log(root);

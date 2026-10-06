/** Reproducible 16.1 export fixture; writes only to the supplied scratch export directory. */
import fs from "node:fs";
import { createSceneStore } from "../src/server/scene";
import { exportScene } from "../src/server/export";
import { EMPTY_LIBRARY } from "../src/shared/library";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: node --import tsx scripts/terrain-fixture.ts <scratch-export-dir>");
fs.mkdirSync(dir, { recursive: true });
const store = createSceneStore();
store.drawShapes([
  { type: "group", ref: "sources", name: "Terrain sources" },
  { type: "terrain", name: "Acceptance terrain", x: 10, z: 7, width: 32, depth: 16, y: -2, source: "$sources", resolution: 129 },
  { type: "box", kind: "volume", name: "Plateau", parent: "$sources", x: 5, z: 3, width: 8, depth: 6, y: -1, height: 4, terrain: { operation: "raise", fade: 2 } },
  { type: "cylinder", kind: "volume", name: "Hill", parent: "$sources", x: 16, z: 11, width: 7, depth: 5, y: 0, height: 7, bevel: 0.6, terrain: { operation: "raise", fade: 3 } },
], "agent");
const common = { project: { id: "terrain-check", name: "Terrain check", description: "16.1 acceptance" }, scene: { id: "terrain", name: "Terrain" }, library: EMPTY_LIBRARY };
await exportScene({ ...common, dir: `${dir}/first`, seq: 1, nodes: store.getScene().nodes });
store.updateNodes([{ id: "box_1", height: 6 }], "agent");
await exportScene({ ...common, dir: `${dir}/second`, seq: 2, nodes: store.getScene().nodes });
console.log(`Terrain fixtures exported to ${dir}`);

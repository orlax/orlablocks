/** Export from an ephemeral store only; never opens configured scene data. */
import fs from "node:fs";
import path from "node:path";
import { createSceneStore } from "../src/server/scene";
import { exportScene } from "../src/server/export";
import { loadManifold } from "../src/server/manifold";
import { setDefinitions } from "../src/shared/entities";
import { EMPTY_LIBRARY } from "../src/shared/library";
import type { Instance } from "../src/shared/scene.types";
const root = process.argv[2];
if (!root || !path.resolve(root).startsWith("/private/tmp/")) throw new Error("Scratch export required");
await loadManifold();
fs.mkdirSync(root, { recursive: true });
setDefinitions({ frame: [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 0.1, depth: 1, height: 1, rotation: 0, color: "yellow", createdBy: "human" }] });
const store = createSceneStore();
store.drawShapes([
  { type: "cylinder", ref: "tower", kind: "room", floor: false, x: 0, z: 0, width: 14, depth: 14, height: 8, wall: 0.4 },
  ...Array.from({ length: 9 }, (_, i) => ({ type: "instance" as const, entity: "frame", wallAttachment: { id: "$tower", side: "inner" as const, angle: i * 40, elevation: 3, offset: 0.02, facingOffset: 0 } })),
], "agent");
store.updateNodes([{ id: "cylinder_1", x: -2, y: 1, z: 3, width: 18, depth: 18, rotation: 25, wall: 0.7 }], "agent");
await exportScene({ dir: root, seq: 2, project: { id: "mount19", name: "Wall mounts", description: "" }, scene: { id: "s", name: "Rotunda" }, nodes: store.getScene().nodes, library: { ...EMPTY_LIBRARY, entities: [{ id: "frame", name: "Wall frame", tags: [] }] } });
// The regular files are authored by exportScene; expected poses are independent input to Unity checks.
fs.writeFileSync(path.join(root, "poses.json"), JSON.stringify({ poses: store.getScene().nodes.filter((n): n is Instance => n.type === "instance").map((n) => ({ id: n.id, x: n.x, y: n.y, z: -n.z, yaw: -n.rotation })) }));
console.log(root);

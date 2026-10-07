// Headless, deterministic terrain measurements; never opens a data folder.
// node --expose-gc --import tsx scripts/benchmark-terrain.ts
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createSceneStore } from "../src/server/scene";
import { evaluateTerrain, rayTerrainFirst, previewTerrain } from "../src/shared/terrain";
import { buildExport } from "../src/server/export";
import { EMPTY_LIBRARY } from "../src/shared/library";
import type { ShapeInput, Terrain } from "../src/shared/scene.types";
const timed = <T>(run: () => T) => { const start = performance.now(); const result = run(); return { ms: Math.round((performance.now() - start) * 10) / 10, result }; };
console.log(JSON.stringify({ machine: `${os.platform()} ${os.arch()}, ${os.cpus()[0].model}, ${os.cpus().length} logical CPUs`, node: process.version, memoryGiB: Math.round(os.totalmem() / 2 ** 30), scene: "256 × 192 m, 20/100 mixed box/cylinder/free-form/ramp inputs, 12–20 m footprints, 6 m fades" }));
for (const count of [20, 100]) for (const resolution of [129, 257, 513, 1025] as const) {
  const store = createSceneStore();
  const inputs: ShapeInput[] = [{ type: "group", ref: "inputs" }, { type: "terrain", source: "$inputs", x: 0, z: 0, width: 256, depth: 192, resolution }];
  for (let i = 0; i < count; i++) {
    const x = (i % 10 - 4.5) * 22, z = (Math.floor(i / 10) - 4.5) * 16, height = 3 + i % 9;
    const terrain = { operation: (i % 7 === 0 ? "set" : "raise") as "set" | "raise", fade: 6 };
    const common = { parent: "$inputs", terrain };
    if (i % 4 === 0) inputs.push({ ...common, type: "box", kind: "volume", x, z, width: 16, depth: 12, height });
    else if (i % 4 === 1) inputs.push({ ...common, type: "cylinder", kind: "volume", x, z, width: 20, depth: 16, height, bevel: 0.5 });
    else if (i % 4 === 2) inputs.push({ ...common, type: "freeform", kind: "volume", height, points: [{ x: x - 8, z: z - 6 }, { x: x + 8, z: z - 6 }, { x: x + 8, z }, { x, z }, { x, z: z + 6 }, { x: x - 8, z: z + 6 }] });
    else inputs.push({ ...common, type: "ramp", width: 4, points: [{ x: x - 8, y: 1, z: z - 4, out: { x: 4, z: 6 } }, { x: x + 8, y: height, z: z + 4, in: { x: -4, z: 2 } }] });
  }
  store.drawShapes(inputs, "human");
  const nodes = store.getScene().nodes, t = nodes.find((n): n is Terrain => n.type === "terrain")!;
  global.gc?.(); const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const cold = timed(() => evaluateTerrain(t, nodes));
  const retainedMiB = Math.round((process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before) / 2 ** 20);
  const cached = timed(() => evaluateTerrain(t, nodes));
  const color = timed(() => evaluateTerrain({ ...t, color: "blue" }, nodes));
  const drag: number[] = [];
  for (let step = 1; step <= 5; step++) drag.push(timed(() => evaluateTerrain(t, nodes.map((n) => n.id === "box_1" ? { ...n, x: step } : n))).ms);
  const preview = timed(() => evaluateTerrain(previewTerrain(t, true), nodes));
  const pick = timed(() => rayTerrainFirst({ origin: { x: -160, y: 50, z: -100 }, dir: { x: 1, y: -0.25, z: 0.4 } }, t, cold.result));
  const geometryMiB = Math.round((cold.result.mesh.positions.length * 8 + cold.result.mesh.indices.length * 8 + cold.result.heights.byteLength) / 2 ** 20 * 10) / 10;
  const exported = timed(() => buildExport({ nodes, project: { id: "bench", name: "Bench", description: "" }, scene: { id: "terrain", name: "Terrain" }, seq: 1, library: EMPTY_LIBRARY }));
  console.log(JSON.stringify({ count, resolution, rebuildMs: cold.ms, cacheMs: cached.ms, colorMs: color.ms, dragMs: Math.round(drag.reduce((a, b) => a + b) / drag.length), allocatedMiB: retainedMiB, previewMs: preview.ms, pickMs: pick.ms, geometryMiB, rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20), exportMs: exported.ms, payloadMiB: Math.round(exported.result.binary.length / 2 ** 20 * 10) / 10 }));
}

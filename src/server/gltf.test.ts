import * as THREE from "three";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setDefinitions } from "../shared/entities";
import { EMPTY_LIBRARY } from "../shared/library";
import { hitMesh } from "../shared/mesh";
import type { Box, Group, Instance, SceneNode } from "../shared/scene.types";
import { buildExport } from "./export";
import { glbFromExport } from "./gltf";
import { loadManifold } from "./manifold";

beforeAll(() => loadManifold());

const common = { color: "blue", createdBy: "human" } as const;
const box = (id: string, patch: Partial<Box> = {}): Box => ({ ...common, id, type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 2, depth: 1, height: 3, rotation: 0, ...patch });
const group = (id: string): Group => ({ id, type: "group", createdBy: "human", name: "hall", description: "the entry hall" });
const inst = (id: string, patch: Partial<Instance> = {}): Instance => ({ id, type: "instance", entity: "pillar", x: 0, y: 0, z: 0, rotation: 0, createdBy: "human", ...patch });

/** The glb's JSON and binary chunks. */
function parse(glb: Buffer) {
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  expect(glb.readUInt32LE(8)).toBe(glb.length);
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
  const bin = glb.subarray(20 + jsonLength + 8);
  return { json, bin };
}

/** Every mesh's positions in the world, by node name (its transforms and its parents' applied). */
function worldPoints(json: any, bin: Buffer) {
  const out = new Map<string, number[][]>();
  const walk = (i: number, parent: THREE.Matrix4) => {
    const n = json.nodes[i];
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
      new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
      new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
    );
    const world = parent.clone().multiply(local);
    if (n.mesh !== undefined) {
      const a = json.accessors[json.meshes[n.mesh].primitives[0].attributes.POSITION];
      const v = json.bufferViews[a.bufferView];
      const f = new Float32Array(bin.buffer.slice(bin.byteOffset + v.byteOffset, bin.byteOffset + v.byteOffset + v.byteLength));
      const pts: number[][] = [];
      for (let k = 0; k < f.length; k += 3) pts.push(new THREE.Vector3(f[k], f[k + 1], f[k + 2]).applyMatrix4(world).toArray());
      out.set(n.name, pts);
    }
    (n.children ?? []).forEach((c: number) => walk(c, world));
  };
  json.scenes[0].nodes.forEach((i: number) => walk(i, new THREE.Matrix4()));
  return out;
}

describe("the .glb", () => {
  beforeEach(() => setDefinitions({ pillar: [box("box_1", { width: 1, depth: 1, height: 4 })] }));

  it("puts every shape where it is in orlablocks (glTF's frame is the same), in its groups, with instances sharing meshes", () => {
    const turned = box("box_2", { parent: "group_1", x: 4, y: 1, z: -6, rotation: 30, pitch: 15, roll: -10, taper: 0.3 });
    const nodes: SceneNode[] = [
      group("group_1"),
      turned,
      box("hole_1", { kind: "hole", parent: "group_1", x: 4, z: -6, width: 0.5, height: 1 }),
      inst("instance_1", { x: 10, rotation: 90 }),
      inst("instance_2", { x: 20, scale: 2 }),
    ];
    const { manifest, binary } = buildExport({ project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "Valley" }, seq: 1, nodes, library: EMPTY_LIBRARY });
    const { json, bin } = parse(glbFromExport(manifest, binary));
    const names = json.nodes.map((n: any) => n.name);
    expect(names).toContain("hall (group_1)");
    expect(names).not.toContain("hole_1");
    expect(json.nodes.find((n: any) => n.name === "hall (group_1)").extras.orlablocks).toMatchObject({ id: "group_1", type: "group", description: "the entry hall" });
    // The box's corners are where orlablocks has them (the hole cuts its middle, so the corners all survive).
    const pts = worldPoints(json, bin);
    const boxPoints = pts.get("box_2")!;
    const m = hitMesh(turned)!;
    const corners: number[][] = [];
    for (let i = 0; i < m.positions.length; i += 3) corners.push([m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
    expect(corners.every((c) => boxPoints.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < 1e-3))).toBe(true);
    // Both pillars' shapes are one mesh, placed twice.
    const pillars = json.nodes.filter((n: any) => n.name === "box_1");
    expect(pillars).toHaveLength(2);
    expect(pillars[0].mesh).toBe(pillars[1].mesh);
    expect(json.materials.map((mt: any) => mt.name)).toContain("orla-blue");
  });

  it("scales and turns an instance as in orlablocks", () => {
    const placed = inst("instance_1", { x: 5, z: 2, rotation: 90, scale: 2 });
    const { manifest, binary } = buildExport({ project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "S" }, seq: 1, nodes: [placed], library: EMPTY_LIBRARY });
    const { json, bin } = parse(glbFromExport(manifest, binary));
    const got = worldPoints(json, bin).get("box_1")!;
    // A 1 × 1 × 4 pillar at 2× is 2 × 2 × 8, around (5, 2).
    const xs = got.map((p) => p[0]);
    const ys = got.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(4);
    expect(Math.max(...xs)).toBeCloseTo(6);
    expect(Math.max(...ys)).toBeCloseTo(8);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setDefinitions } from "../shared/entities";
import { EMPTY_LIBRARY, type Library } from "../shared/library";
import { hitMesh, signedVolume } from "../shared/mesh";
import { apply, mul, rotX, rotY, rotZ } from "../shared/rotation3";
import type { ArrayNode, Box, Freeform, Group, Instance, Ramp, SceneNode } from "../shared/scene.types";
import { buildExport, exportScene, type Manifest, type MeshRange, type NodeRecord } from "./export";
import { loadManifold } from "./manifold";

beforeAll(() => loadManifold());

const common = { color: "almost-white", createdBy: "human" } as const;
const box = (id: string, patch: Partial<Box> = {}): Box => ({ ...common, id, type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 2, depth: 1, height: 3, rotation: 0, ...patch });
const group = (id: string, patch: Partial<Group> = {}): Group => ({ id, type: "group", createdBy: "human", ...patch });
const inst = (id: string, patch: Partial<Instance> = {}): Instance => ({ id, type: "instance", entity: "pillar", x: 0, y: 0, z: 0, rotation: 0, createdBy: "human", ...patch });
const LIBRARY: Library = { ...EMPTY_LIBRARY, entities: [{ id: "pillar", name: "Pillar", description: "holds the roof", tags: [] }] };
const PILLAR: SceneNode[] = [box("box_1", { width: 1, depth: 1, height: 4 })];

const build = (nodes: SceneNode[]) => buildExport({ project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "S" }, seq: 7, nodes, library: LIBRARY });

/** A mesh's positions and indices from the binary. */
function read(binary: Buffer, r: MeshRange) {
  const f = (at: number, n: number) => Array.from(new Float32Array(binary.buffer.slice(binary.byteOffset + at, binary.byteOffset + at + n * 4)));
  const positions = f(r.offset, r.vertices * 3);
  const normals = f(r.offset + r.vertices * 12, r.vertices * 3);
  const at = r.offset + r.vertices * 32;
  const indices = Array.from(new Uint32Array(binary.buffer.slice(binary.byteOffset + at, binary.byteOffset + at + r.indices * 4)));
  return { positions, normals, indices };
}

/** Unity's Quaternion.Euler(x, y, z) as a matrix: z, then x, then y about the world axes (Ry · Rx · Rz). */
const unityRotation = ([x, y, z]: number[]) => mul(rotY(y), mul(rotX(x), rotZ(z)));

/** A record's mesh in Unity's world (its parent at the origin). */
function unityWorld(binary: Buffer, r: NodeRecord) {
  const { positions } = read(binary, r.body);
  const m = unityRotation(r.euler);
  const out: number[][] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const w = apply(m, { x: positions[i], y: positions[i + 1], z: positions[i + 2] });
    out.push([w.x + r.position[0], w.y + r.position[1], w.z + r.position[2]]);
  }
  return out;
}

/** Every point of `a` has one of `b` within 1 mm, and the other way. */
function sameCloud(a: number[][], b: number[][]) {
  const near = (p: number[], q: number[][]) => q.some((o) => Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]) < 1e-3);
  expect(a.every((p) => near(p, b))).toBe(true);
  expect(b.every((p) => near(p, a))).toBe(true);
}

/** The shape's world corners (orlablocks' frame) with z flipped: where they should be in Unity. */
const flipped = (shape: Box | Freeform) => {
  const m = hitMesh(shape)!;
  const out: number[][] = [];
  for (let i = 0; i < m.positions.length; i += 3) out.push([m.positions[i], m.positions[i + 1], -m.positions[i + 2]]);
  return out;
};

describe("the Unity export", () => {
  beforeEach(() => setDefinitions({ pillar: PILLAR }));

  it("puts a turned, tilted box where it is, with z flipped, and its faces still facing out", () => {
    const b = box("box_1", { x: 4, y: 1, z: -6, rotation: 30, pitch: 15, roll: -10, taper: 0.3 });
    const { manifest, binary } = build([b]);
    const r = manifest.nodes[0];
    expect(r.euler).toEqual([-15, -30, -10]);
    sameCloud(unityWorld(binary, r), flipped(b));
    const { positions, indices } = read(binary, r.body);
    expect(signedVolume(positions, indices)).toBeGreaterThan(0);
    // Tapered: a mesh collider, not a box.
    expect(r.collider).toBe("mesh");
  });

  it("gives a free-form and a ramp their bounds' bottom center as pivot", () => {
    const f: Freeform = { ...common, id: "freeform_1", type: "freeform", kind: "volume", y: 2, height: 1, points: [{ x: 10, z: 10 }, { x: 14, z: 10 }, { x: 14, z: 12 }, { x: 10, z: 12 }] };
    const ramp: Ramp = { ...common, id: "ramp_1", type: "ramp", kind: "volume", width: 2, base: "solid", points: [{ x: 0, y: 0, z: 0 }, { x: 6, y: 2, z: 0 }] };
    const { manifest, binary } = build([f, ramp]);
    const [rf, rr] = manifest.nodes;
    expect(rf.position).toEqual([12, 2, -11]);
    sameCloud(unityWorld(binary, rf), flipped(f));
    expect(rr.position[0]).toBeCloseTo(3);
    expect(rr.position[2]).toBeCloseTo(0);
    expect(rr.euler).toEqual([0, 0, 0]);
  });

  it("places children relative to their group's bottom center, and fits plain box volumes with box colliders", () => {
    const { manifest } = build([group("group_1", { description: "the hall" }), box("box_2", { parent: "group_1", x: 10, z: 4 }), box("box_3", { parent: "group_1", x: 14, z: 4, y: 1 })]);
    const [g, a, b] = manifest.nodes;
    expect(g).toMatchObject({ id: "group_1", position: [12, 0, -4], description: "the hall" });
    expect(a).toMatchObject({ parent: "group_1", position: [-2, 0, 0], collider: "box", boxCenter: [0, 1.5, 0], boxSize: [2, 3, 1] });
    expect(b.position).toEqual([2, 1, 0]);
  });

  it("writes each entity once, instances and items with their transforms, and a variant where a hole cuts one", () => {
    const array: ArrayNode = { id: "array_1", type: "array", entities: [{ entity: "pillar" }], layout: { type: "path", points: [{ x: 20, y: 0, z: 0 }, { x: 26, y: 0, z: 0 }], place: "count", count: 3 }, createdBy: "human" };
    const nodes: SceneNode[] = [
      group("g"),
      box("hole_1", { kind: "hole", parent: "g", x: 0, z: 0, width: 3, depth: 0.4, height: 1 }),
      inst("instance_1", { rotation: 90, scale: 2 }),
      inst("instance_2", { x: 8 }),
      array,
    ];
    const { manifest } = build(nodes);
    expect(manifest.entities.map((e) => [e.id, e.name, e.nodes.length])).toEqual([["pillar", "Pillar", 1]]);
    const byId = (id: string) => manifest.nodes.find((r) => r.id === id)!;
    expect(byId("instance_1")).toMatchObject({ entity: "pillar", euler: [0, -90, 0], scale: 2 });
    expect(byId("instance_1").cuts.map((c) => c.shape)).toEqual(["box_1"]);
    expect(byId("instance_2").cuts).toEqual([]);
    expect(byId("hole_1")).toMatchObject({ collider: "none", kind: "hole" });
    const items = manifest.nodes.filter((r) => r.type === "item");
    expect(items.map((i) => [i.id, i.parent])).toEqual([["array_1/0", "array_1"], ["array_1/1", "array_1"], ["array_1/2", "array_1"]]);
    // The array's pivot is its bounds' bottom center (x 20..26): its items sit around it.
    expect(items.map((i) => i.position[0])).toEqual([-3, 0, 3]);
  });

  it("has every field on every record, and hashes what the meshes are made of, not names", () => {
    const one = build([box("box_1")]).manifest;
    const keys = Object.keys(one.nodes[0]).sort();
    const again = build([group("group_1"), { ...PILLAR[0], id: "box_2", name: "renamed", parent: "group_1" }, inst("instance_1")]).manifest;
    for (const r of [...again.nodes, ...again.entities.flatMap((e) => e.nodes)]) expect(Object.keys(r).sort()).toEqual(keys);
    expect(build([box("box_1", { name: "a name" })]).manifest.nodes[0].hash).toBe(one.nodes[0].hash);
    expect(build([box("box_1", { height: 4 })]).manifest.nodes[0].hash).not.toBe(one.nodes[0].hash);
    expect(JSON.parse(JSON.stringify(one))).toEqual(one);
  });

  it("exports a missing entity's instances as red blocks, with a warning", () => {
    const warnings: string[] = [];
    const { manifest } = buildExport({ project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "S" }, seq: 1, nodes: [inst("instance_1", { entity: "gone" })], library: LIBRARY }, warnings);
    expect(manifest.entities[0]).toMatchObject({ id: "gone", name: "missing entity gone" });
    expect(manifest.entities[0].nodes[0]).toMatchObject({ color: "red", collider: "box" });
    expect(warnings).toEqual(["The entity gone is missing: its instances are red blocks."]);
  });
});

describe("writing an export", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "orla-export-"));
    setDefinitions({ pillar: PILLAR });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (nodes: SceneNode[], dir = path.join(root, "valley")) =>
    exportScene({ dir, project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "S" }, seq: 3, nodes, library: LIBRARY });

  it("writes the manifest and its binary, keeps the previous binary and deletes older ones", async () => {
    const first = await run([box("box_1")]);
    expect(first).toMatchObject({ exportId: 3, nodes: { box: 1 }, meshes: 1, warnings: [] });
    const dir = path.join(root, "valley");
    const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, "level.json"), "utf8")) as Manifest;
    const bins = () => fs.readdirSync(dir).filter((f) => f.endsWith(".bin")).sort();
    const a = manifest().meshes.file;
    await run([box("box_1", { height: 5 })]);
    const b = manifest().meshes.file;
    await run([box("box_1", { height: 6 })]);
    const c = manifest().meshes.file;
    expect(bins()).toEqual([b, c].sort());
    expect(bins()).not.toContain(a);
    expect(fs.statSync(path.join(dir, c)).size).toBe(manifest().meshes.bytes);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a relative folder or one whose parent is missing", async () => {
    await expect(run([], "relative/valley")).rejects.toThrow("absolute");
    await expect(run([], path.join(root, "no", "valley"))).rejects.toThrow("Neither");
  });
});

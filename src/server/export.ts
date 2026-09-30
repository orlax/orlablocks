import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { arrayItems } from "../shared/arrays";
import { bakeShape, type Baked, type DrawMesh } from "../shared/bake";
import { bakeScene, type SceneBake } from "../shared/bakeScene";
import { definitionOf, itemInstance } from "../shared/entities";
import { isFootprinted, isSolid, isTilted, polyline, shapeFrame } from "../shared/geometry";
import { entityMeta, NO_COLLISIONS, type Library } from "../shared/library";
import { apply, orientationYXZ, type Vec3 } from "../shared/rotation3";
import { PALETTE, type Box, type ExportSummary, type Instance, type SceneNode, type Solid } from "../shared/scene.types";
import { isShape, tagsOf } from "../shared/tree";
import { loadManifold, onCutError } from "./manifold";

/**
 * The export for Unity (plan 15 §3–§5): a scene as `level.json` (the manifest) and `meshes-<hash>.bin`, in the
 * scene's export folder, in Unity's frame. orlablocks is right-handed and Unity left-handed, both y up: z flips (so
 * north, -z, becomes Unity's forward), triangles are wound the other way, and an orientation Ry(yaw) · Rx(pitch) ·
 * Rz(roll) becomes Unity's euler (-pitch, -yaw, roll), which Unity applies in the same order. The C# only copies the
 * numbers.
 */

export const EXPORT_FORMAT = "orlablocks-unity";
export const EXPORT_VERSION = 1;

type V3 = [number, number, number];

/** Where a mesh is in the binary: its byte offset, then positions, normals, UVs and indices (see `MeshWriter`). */
export type MeshRange = { offset: number; vertices: number; indices: number };
const NO_MESH: MeshRange = { offset: 0, vertices: 0, indices: 0 };

/** A shape of an instance's entity cut differently in this instance (a variant): its own meshes. */
export type CutRecord = { shape: string; body: MeshRange; floor: MeshRange; hash: string };

/** One node, every field present (Unity's JsonUtility reads plain records). Positions are local to the parent's. */
export type NodeRecord = {
  id: string;
  type: "group" | "box" | "cylinder" | "freeform" | "ramp" | "instance" | "array" | "item" | "note" | "line";
  kind: string;
  parent: string;
  name: string;
  description: string;
  tags: string[];
  color: string;
  position: V3;
  euler: V3;
  scale: number;
  hidden: boolean;
  hash: string;
  /** A hash of the whole record (15.4): a sync leaves a node whose rev it has already alone. */
  rev: string;
  body: MeshRange;
  floor: MeshRange;
  collider: "box" | "mesh" | "none";
  /** An instance or item in something carrying #no-collisions: Unity turns its entity's colliders off, for this one only. */
  noColliders: boolean;
  boxCenter: V3;
  boxSize: V3;
  entity: string;
  cuts: CutRecord[];
  text: string;
  label: string;
  status: string;
  points: number[];
  thickness: number;
  dashed: boolean;
  arrow: string;
};

export type EntityRecord = { id: string; name: string; description: string; tags: string[]; hash: string; nodes: NodeRecord[] };

export type Manifest = {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportId: number;
  exportedAt: string;
  project: { id: string; name: string; description: string };
  scene: { id: string; name: string };
  meshes: { file: string; bytes: number; hash: string };
  palette: { key: string; color: string }[];
  floorShade: number;
  tags: { name: string; description: string }[];
  skills: { name: string; description: string }[];
  entities: EntityRecord[];
  nodes: NodeRecord[];
};

/** Room floors are this shade of the room's color, as in the editor (`ShapeMesh.tsx`). */
const FLOOR_SHADE = 0.94;

/** A point or direction in Unity's frame. */
export const toUnity = (p: Vec3): V3 => [p.x, p.y, -p.z + 0];

/** An orientation Ry(yaw) · Rx(pitch) · Rz(roll), as Unity's euler angles (degrees). */
export const toUnityEuler = (yaw: number, pitch: number, roll: number): V3 => [-pitch + 0, -yaw + 0, roll + 0];

/**
 * The binary: meshes one after another, each its positions (float32 × 3), normals (float32 × 3), UVs (float32 × 2)
 * and indices (uint32), little-endian, in Unity's frame. Vertices shared by a face's neighbors (same position,
 * normal and UV) are welded. The same mesh twice is written once.
 */
class MeshWriter {
  chunks: Buffer[] = [];
  bytes = 0;
  count = 0;
  private seen = new Map<string, { range: MeshRange; hash: string }>();

  /** `m` (in a node's own frame) moved by `-shift`, in Unity's frame. */
  add(m: DrawMesh | null, shift: Vec3 = { x: 0, y: 0, z: 0 }): { range: MeshRange; hash: string } {
    if (!m || m.positions.length === 0) return { range: NO_MESH, hash: "" };
    const n = m.positions.length / 3;
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const remap = new Int32Array(n);
    const index = new Map<string, number>();
    const f = new Float32Array(8);
    for (let i = 0; i < n; i++) {
      f[0] = m.positions[i * 3] - shift.x;
      f[1] = m.positions[i * 3 + 1] - shift.y;
      f[2] = -(m.positions[i * 3 + 2] - shift.z);
      f[3] = m.normals[i * 3];
      f[4] = m.normals[i * 3 + 1];
      f[5] = -m.normals[i * 3 + 2];
      f[6] = m.uvs[i * 2];
      f[7] = m.uvs[i * 2 + 1];
      const key = Array.from(f).join(",");
      let k = index.get(key);
      if (k === undefined) {
        k = pos.length / 3;
        index.set(key, k);
        pos.push(f[0], f[1], f[2]);
        nrm.push(f[3], f[4], f[5]);
        uv.push(f[6], f[7]);
      }
      remap[i] = k;
    }
    // Unity's frame is mirrored: each triangle the other way round, so it still faces out.
    const idx = new Uint32Array(n);
    for (let t = 0; t < n; t += 3) {
      idx[t] = remap[t];
      idx[t + 1] = remap[t + 2];
      idx[t + 2] = remap[t + 1];
    }
    const vertices = pos.length / 3;
    const buf = Buffer.concat([
      Buffer.from(new Float32Array(pos).buffer),
      Buffer.from(new Float32Array(nrm).buffer),
      Buffer.from(new Float32Array(uv).buffer),
      Buffer.from(idx.buffer),
    ]);
    const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
    const known = this.seen.get(hash);
    if (known) return known;
    const out = { range: { offset: this.bytes, vertices, indices: idx.length }, hash };
    this.chunks.push(buf);
    this.bytes += buf.length;
    this.count += 1;
    this.seen.set(hash, out);
    return out;
  }
}

/** Where a shape's own frame sits (three.js coordinates): world = at + R · (local - shift), R = Ry(yaw) · Rx(pitch) · Rz(roll). */
type Placement = { at: Vec3; yaw: number; pitch: number; roll: number; shift: Vec3 };

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/** The x/z middle and lowest y of meshes' positions. */
function bottomCenter(meshes: (DrawMesh | null)[]): Vec3 {
  let [minX, maxX, minY, minZ, maxZ] = [Infinity, -Infinity, Infinity, Infinity, -Infinity];
  for (const m of meshes) {
    if (!m) continue;
    for (let i = 0; i < m.positions.length; i += 3) {
      minX = Math.min(minX, m.positions[i]);
      maxX = Math.max(maxX, m.positions[i]);
      minY = Math.min(minY, m.positions[i + 1]);
      minZ = Math.min(minZ, m.positions[i + 2]);
      maxZ = Math.max(maxZ, m.positions[i + 2]);
    }
  }
  return minX === Infinity ? ZERO : { x: (minX + maxX) / 2, y: minY, z: (minZ + maxZ) / 2 };
}

/**
 * A shape's GameObject's place (plan 15 §4): a box's, cylinder's or tilted free-form's is its frame at its bottom
 * (the tilt about its center folded into one position and rotation, as `shapeMatrix` draws it); an untilted
 * free-form's or a ramp's (their meshes are in world coordinates) is its bounds' bottom center.
 */
export function placementOf(shape: Solid, baked: Baked): Placement {
  if (shape.type === "ramp") {
    const c = bottomCenter([baked.body]);
    return { at: c, yaw: 0, pitch: 0, roll: 0, shift: c };
  }
  const frame = shapeFrame(shape);
  const [pitch, roll] = [shape.pitch ?? 0, shape.roll ?? 0];
  const r = orientationYXZ(frame.rotation, pitch, roll);
  const down = apply(r, { x: 0, y: -shape.height / 2, z: 0 });
  const origin = { x: frame.x + down.x, y: shape.y + shape.height / 2 + down.y, z: frame.z + down.z };
  if (isFootprinted(shape) || isTilted(shape)) return { at: origin, yaw: frame.rotation, pitch, roll, shift: ZERO };
  // An untilted free-form's frame is the world's at its elevation: its pivot moves to its middle.
  const c = bottomCenter([baked.body, baked.floor]);
  const shift = { x: c.x, y: 0, z: c.z };
  return { at: { x: origin.x + shift.x, y: origin.y, z: origin.z + shift.z }, yaw: 0, pitch: 0, roll: 0, shift };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** An empty record: every field at its "doesn't apply" value. */
const blank = (id: string, type: NodeRecord["type"], parent: string): NodeRecord => ({
  id,
  type,
  kind: "",
  parent,
  name: "",
  description: "",
  tags: [],
  color: "",
  position: [0, 0, 0],
  euler: [0, 0, 0],
  scale: 1,
  hidden: false,
  hash: "",
  rev: "",
  body: NO_MESH,
  floor: NO_MESH,
  collider: "none",
  noColliders: false,
  boxCenter: [0, 0, 0],
  boxSize: [0, 0, 0],
  entity: "",
  cuts: [],
  text: "",
  label: "",
  status: "",
  points: [],
  thickness: 0,
  dashed: false,
  arrow: "",
});

/** A box volume with nothing that bends its sides or cuts it: a BoxCollider fits it exactly. */
const boxFits = (s: Box, cut: boolean) => s.kind === "volume" && !s.taper && !s.bevel && !cut;

/** The missing entity's stand-in, as the editor shows it: a 1 m red block (the instance's scale sizes it). */
const MISSING: SceneNode[] = [{ id: "missing", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 1, height: 1, rotation: 0, color: "red", createdBy: "human" }];

type Context = {
  meshes: MeshWriter;
  library: Library;
  warnings: string[];
};

/**
 * Records for a list of nodes (a scene's, or an entity's definition), parents first. `baked` holds their shapes'
 * meshes; `pivot` is each node's place in three.js coordinates, and a record's position is its pivot minus its
 * parent's (groups and arrays aren't turned, so that's all there is to it).
 */
/**
 * Records for a list of nodes (a scene's, or an entity's definition), parents first. `quiet`: everything in it
 * carries #no-collisions (an entity tagged with it).
 */
function records(nodes: SceneNode[], baked: Map<string, Baked>, cutIds: Set<string>, ctx: Context, bake: SceneBake | null, quiet = false): NodeRecord[] {
  const byParent = new Map<string, SceneNode[]>();
  for (const n of nodes) {
    const k = n.parent ?? "";
    byParent.set(k, [...(byParent.get(k) ?? []), n]);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** Whether the node, or anything it's in, carries #no-collisions: no collider in Unity. */
  const noCollisions = (n: SceneNode): boolean => {
    if (quiet) return true;
    for (let at: SceneNode | undefined = n; at; at = at.parent !== undefined ? byId.get(at.parent) : undefined)
      if (tagsOf(at)?.includes(NO_COLLISIONS)) return true;
    return false;
  };
  const pivots = new Map<string, Vec3>();
  const pivotOf = (n: SceneNode): Vec3 => {
    const hit = pivots.get(n.id);
    if (hit) return hit;
    let p: Vec3 = ZERO;
    // A group or array sits at its parent's origin (15.4): a pivot from its bounds would move whenever one member
    // did, and with it every other member's local position, so one edit would change them all.
    if (n.type === "group" || n.type === "array") p = parentPivot(n);
    else if (n.type === "instance" || n.type === "note") p = { x: n.x, y: n.y, z: n.z };
    else if (n.type === "line") p = n.points[0] ?? ZERO;
    else if (isSolid(n)) p = placementOf(n, baked.get(n.id) ?? { body: null, floor: null }).at;
    pivots.set(n.id, p);
    return p;
  };
  function parentPivot(n: SceneNode): Vec3 {
    const parent = n.parent !== undefined ? byId.get(n.parent) : undefined;
    return parent ? pivotOf(parent) : ZERO;
  }

  const out: NodeRecord[] = [];
  const visit = (n: SceneNode) => {
    out.push(record(n, sub(pivotOf(n), parentPivot(n))));
    if (n.type === "array")
      for (const item of arrayItems(n)) {
        const inst = itemInstance(n, item);
        out.push({ ...instanceRecord(inst, sub({ x: inst.x, y: inst.y, z: inst.z }, pivotOf(n)), noCollisions(n)), type: "item", parent: n.id, hidden: false });
      }
    for (const c of byParent.get(n.id) ?? []) visit(c);
  };

  const instanceRecord = (inst: Instance, local: Vec3, quietHere: boolean): NodeRecord => {
    const r = blank(inst.id, "instance", inst.parent ?? "");
    const cuts: CutRecord[] = [];
    const variant = bake?.variants.get(inst.id);
    if (variant) {
      const own = bake!.entities.get(inst.entity);
      const def = definitionOf(inst.entity) ?? [];
      for (const [shapeId, v] of variant) {
        const shape = def.find((d) => d.id === shapeId);
        if (!shape || !isShape(shape) || !isSolid(shape)) continue;
        // The same shift as the entity's own shape, so the cut mesh sits where the prefab's child is.
        const { shift } = placementOf(shape, own?.get(shapeId) ?? v);
        const body = ctx.meshes.add(v.body, shift);
        const floor = ctx.meshes.add(v.floor, shift);
        cuts.push({ shape: shapeId, body: body.range, floor: floor.range, hash: `${body.hash}${floor.hash}` });
      }
    }
    return {
      ...r,
      name: inst.name ?? "",
      position: toUnity(local),
      euler: toUnityEuler(inst.rotation, inst.pitch ?? 0, inst.roll ?? 0),
      scale: inst.scale ?? 1,
      hidden: !!inst.hidden,
      entity: inst.entity,
      noColliders: quietHere,
      cuts,
      hash: cuts.map((c) => c.hash).join(""),
    };
  };

  const record = (n: SceneNode, local: Vec3): NodeRecord => {
    const base = { ...blank(n.id, n.type as NodeRecord["type"], n.parent ?? ""), name: n.name ?? "", hidden: !!n.hidden, tags: tagsOf(n) ?? [] };
    if (n.type === "group") return { ...base, description: n.description ?? "", position: toUnity(local) };
    if (n.type === "array") return { ...base, position: toUnity(local) };
    if (n.type === "instance") return instanceRecord(n, local, noCollisions(n));
    if (n.type === "note") return { ...base, position: toUnity(local), color: n.color, text: n.text, label: n.label ?? "", status: n.status };
    if (n.type === "line") {
      const first = n.points[0] ?? ZERO;
      const points = polyline(n).flatMap((p) => toUnity(sub(p, first)));
      return { ...base, position: toUnity(local), color: n.color, points, thickness: n.thickness, dashed: n.dashed, arrow: n.arrow };
    }
    if (!isSolid(n)) return base;
    const b = baked.get(n.id) ?? { body: null, floor: null };
    const pl = placementOf(n, b);
    const body = ctx.meshes.add(b.body, pl.shift);
    const floor = ctx.meshes.add(b.floor, pl.shift);
    const cut = cutIds.has(n.id);
    const hole = n.kind === "hole";
    const silent = noCollisions(n);
    const box = !hole && !silent && n.type === "box" && boxFits(n, cut) ? n : null;
    return {
      ...base,
      kind: n.kind,
      color: n.color,
      position: toUnity(local),
      euler: toUnityEuler(pl.yaw, pl.pitch, pl.roll),
      body: body.range,
      floor: floor.range,
      hash: `${body.hash}${floor.hash}`,
      collider: hole || silent ? "none" : box ? "box" : "mesh",
      boxCenter: box ? [0, box.height / 2, 0] : [0, 0, 0],
      boxSize: box ? [box.width, box.height, box.depth] : [0, 0, 0],
    };
  };
  for (const n of byParent.get("") ?? []) visit(n);
  for (const r of out) r.rev = hash16(JSON.stringify({ ...r, rev: "" }));
  return out;
}

const hash16 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export type ExportInput = {
  dir: string;
  project: { id: string; name: string; description: string };
  scene: { id: string; name: string };
  seq: number;
  nodes: SceneNode[];
  library: Library;
};

/** The manifest and binary for a scene (nothing written). Needs the boolean library loaded, or holes stay uncut. */
export function buildExport(input: Omit<ExportInput, "dir">, warnings: string[] = []): { manifest: Manifest; binary: Buffer; meshes: number } {
  const bake = bakeScene(input.nodes);
  const ctx: Context = { meshes: new MeshWriter(), library: input.library, warnings };
  const nodes = records(input.nodes, bake.shapes, bake.cut, ctx, bake);

  const used = [...new Set(nodes.filter((r) => r.type === "instance" || r.type === "item").map((r) => r.entity))];
  const entities = used.map((id): EntityRecord => {
    const meta = entityMeta(input.library, id);
    const def = definitionOf(id);
    if (!def) {
      warnings.push(`The entity ${id} is missing: its instances are red blocks.`);
      const recs = records(MISSING, new Map([["missing", bakeShape(MISSING[0] as Box)]]), new Set(), ctx, null);
      return { id, name: `missing entity ${id}`, description: "", tags: [], hash: hash16(JSON.stringify(recs)), nodes: recs };
    }
    const recs = records(def, bake.entities.get(id) ?? new Map(), bake.entityCut.get(id) ?? new Set(), ctx, null, !!meta?.tags?.includes(NO_COLLISIONS));
    return { id, name: meta?.name ?? id, description: meta?.description ?? "", tags: meta?.tags ?? [], hash: hash16(JSON.stringify(recs)), nodes: recs };
  });

  const binary = Buffer.concat(ctx.meshes.chunks);
  const binHash = crypto.createHash("sha1").update(binary).digest("hex").slice(0, 12);
  const manifest: Manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportId: input.seq,
    exportedAt: new Date().toISOString(),
    project: input.project,
    scene: input.scene,
    meshes: { file: `meshes-${binHash}.bin`, bytes: binary.length, hash: binHash },
    palette: Object.entries(PALETTE).map(([key, color]) => ({ key, color })),
    floorShade: FLOOR_SHADE,
    tags: input.library.tags.map((t) => ({ name: t.name, description: t.description ?? "" })),
    skills: input.library.skills.map((s) => ({ name: s.name, description: s.description })),
    entities,
    nodes,
  };
  return { manifest, binary, meshes: ctx.meshes.count };
}

/** Why `dir` can't be an export folder, or null: it must be absolute, and it or its parent must exist. */
export function exportDirProblem(dir: string): string | null {
  if (!path.isAbsolute(dir)) return `The export folder must be an absolute path (${dir} isn't).`;
  if (fs.existsSync(dir)) return fs.statSync(dir).isDirectory() ? null : `${dir} is a file, not a folder.`;
  const parent = path.dirname(dir);
  return fs.existsSync(parent) && fs.statSync(parent).isDirectory() ? null : `Neither ${dir} nor its parent folder exists.`;
}

/** The binary the manifest in `dir` points at now, if there's a manifest that reads. */
function currentBinary(dir: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "level.json"), "utf8")) as Partial<Manifest>;
    return m.meshes?.file ?? null;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Exports a scene to its folder: the binary first (named by its hash), then `level.json` through a rename, so a
 * reader never sees a manifest pointing at a half-written binary. The binary the previous manifest pointed at is
 * kept (a reader may still be on it) and older ones are deleted.
 */
export async function exportScene(input: ExportInput): Promise<ExportSummary> {
  const started = performance.now();
  const problem = exportDirProblem(input.dir);
  if (problem) throw new Error(problem);
  await loadManifold();
  const warnings: string[] = [];
  onCutError((e) => {
    const line = `A hole's cut failed, so a shape is exported uncut: ${e instanceof Error ? e.message : String(e)}`;
    if (!warnings.includes(line)) warnings.push(line);
  });
  let built: ReturnType<typeof buildExport>;
  try {
    built = buildExport(input, warnings);
  } finally {
    onCutError(() => {});
  }
  const { manifest, binary } = built;
  if (!fs.existsSync(input.dir)) fs.mkdirSync(input.dir);
  const previous = currentBinary(input.dir);
  const binFile = path.join(input.dir, manifest.meshes.file);
  if (!fs.existsSync(binFile)) writeAtomic(binFile, binary);
  writeAtomic(path.join(input.dir, "level.json"), JSON.stringify(manifest));
  for (const f of fs.readdirSync(input.dir))
    if (/^meshes-[0-9a-f]+\.bin$/.test(f) && f !== manifest.meshes.file && f !== previous) fs.rmSync(path.join(input.dir, f), { force: true });

  const nodes: Record<string, number> = {};
  for (const r of manifest.nodes) if (r.type !== "item") nodes[r.type] = (nodes[r.type] ?? 0) + 1;
  return {
    dir: input.dir,
    exportId: manifest.exportId,
    nodes,
    items: manifest.nodes.filter((r) => r.type === "item").length,
    entities: manifest.entities.length,
    meshes: built.meshes,
    bytes: binary.length,
    ms: Math.round(performance.now() - started),
    warnings,
  };
}

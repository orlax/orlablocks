import * as THREE from "three";
import type { Manifest, MeshRange, NodeRecord } from "./export";

/**
 * A scene as one glTF binary (`.glb`, 15.2), for Blender or any other 3D tool: written from the Unity export (the
 * same bake, records and meshes) turned back into orlablocks' frame, which is glTF's too (right-handed, y up; north is
 * -z). Every node keeps its place in the tree, named `name (id)`, with its ID, type, tags and description as extras.
 * Each entity's meshes are shared by its instances (glTF instancing). Materials are the palette's colors, matte.
 * Holes, lines and hidden nodes are left out (a glTF has no hidden nodes); notes are empties with their text.
 */

type Json = Record<string, unknown>;

/** sRGB to linear, as three.js reads a hex color. */
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: string) => [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));

export function glbFromExport(m: Manifest, bin: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let length = 0;
  const bufferViews: Json[] = [];
  const accessors: Json[] = [];
  const meshes: Json[] = [];
  const materials: Json[] = [];
  const nodes: Json[] = [];

  const view = (data: Buffer, target: number) => {
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length, target });
    chunks.push(data);
    length += data.length;
    // Every view starts 4-byte aligned (the data is floats and uint32s, so it always is).
    return bufferViews.length - 1;
  };
  const accessor = (a: Json) => (accessors.push(a), accessors.length - 1);

  /** A mesh range back in orlablocks' frame (z flipped back, triangles wound back), as glTF accessors. Once per range. */
  const ranges = new Map<number, Json>();
  const primitiveOf = (r: MeshRange): Json | null => {
    if (r.vertices === 0) return null;
    const hit = ranges.get(r.offset);
    if (hit) return hit;
    const at = (o: number, n: number) => new Float32Array(bin.buffer.slice(bin.byteOffset + o, bin.byteOffset + o + n * 4));
    const pos = at(r.offset, r.vertices * 3);
    const nrm = at(r.offset + r.vertices * 12, r.vertices * 3);
    const uv = at(r.offset + r.vertices * 24, r.vertices * 2);
    const ix = r.offset + r.vertices * 32;
    const idx = new Uint32Array(bin.buffer.slice(bin.byteOffset + ix, bin.byteOffset + ix + r.indices * 4));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < r.vertices; i++) {
      pos[i * 3 + 2] = -pos[i * 3 + 2];
      nrm[i * 3 + 2] = -nrm[i * 3 + 2];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], pos[i * 3 + k]);
        max[k] = Math.max(max[k], pos[i * 3 + k]);
      }
    }
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    const float = (data: Float32Array, type: string) =>
      accessor({ bufferView: view(Buffer.from(data.buffer), 34962), componentType: 5126, count: r.vertices, type });
    const primitive = {
      attributes: {
        POSITION: accessor({ bufferView: view(Buffer.from(pos.buffer), 34962), componentType: 5126, count: r.vertices, type: "VEC3", min, max }),
        NORMAL: float(nrm, "VEC3"),
        TEXCOORD_0: float(uv, "VEC2"),
      },
      indices: accessor({ bufferView: view(Buffer.from(idx.buffer), 34963), componentType: 5125, count: r.indices, type: "SCALAR" }),
    };
    ranges.set(r.offset, primitive);
    return primitive;
  };

  /** The palette's materials: a body and a (slightly darker) floor per color, made on first use. */
  const palette = new Map(m.palette.map((p) => [p.key, p.color]));
  const materialIds = new Map<string, number>();
  const material = (color: string, floor: boolean) => {
    const k = `${color}:${floor}`;
    let id = materialIds.get(k);
    if (id === undefined) {
      const c = rgb(palette.get(color) ?? "#ededed").map((v) => (floor ? v * m.floorShade : v));
      materials.push({ name: `orla-${color}${floor ? "-floor" : ""}`, pbrMetallicRoughness: { baseColorFactor: [...c, 1], metallicFactor: 0, roughnessFactor: 1 } });
      id = materials.length - 1;
      materialIds.set(k, id);
    }
    return id;
  };

  const meshIds = new Map<string, number>();
  const mesh = (name: string, body: MeshRange, floor: MeshRange, color: string): number | undefined => {
    const k = `${body.offset}:${body.vertices}|${floor.offset}:${floor.vertices}|${color}`;
    const known = meshIds.get(k);
    if (known !== undefined) return known;
    const primitives = [
      ...[primitiveOf(body)].filter((p): p is Json => !!p).map((p) => ({ ...p, material: material(color, false) })),
      ...[primitiveOf(floor)].filter((p): p is Json => !!p).map((p) => ({ ...p, material: material(color, true) })),
    ];
    if (primitives.length === 0) return undefined;
    meshes.push({ name, primitives });
    meshIds.set(k, meshes.length - 1);
    return meshes.length - 1;
  };

  const deg = Math.PI / 180;
  /** A record's local transform, back in orlablocks' frame: Unity's euler (-pitch, -yaw, roll) undone. */
  const transform = (r: NodeRecord): Json => {
    const [x, y, z] = r.position;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-r.euler[0] * deg, -r.euler[1] * deg, r.euler[2] * deg, "YXZ"));
    return {
      ...(x || y || z ? { translation: [x, y, -z + 0] } : {}),
      ...(q.w < 1 - 1e-12 ? { rotation: [q.x, q.y, q.z, q.w] } : {}),
      ...(r.scale !== 1 ? { scale: [r.scale, r.scale, r.scale] } : {}),
    };
  };
  const skipped = (r: NodeRecord) => r.hidden || r.kind === "hole" || r.type === "line";
  const childrenOf = (records: NodeRecord[]) => {
    const out = new Map<string, NodeRecord[]>();
    for (const r of records) out.set(r.parent, [...(out.get(r.parent) ?? []), r]);
    return out;
  };
  const entities = new Map(m.entities.map((e) => [e.id, { entity: e, children: childrenOf(e.nodes) }]));

  /** A record as a node (and what's under it); `override` is an instance's cut meshes by its entity's shape ID. */
  const node = (r: NodeRecord, children: Map<string, NodeRecord[]>, override?: Map<string, NodeRecord["cuts"][number]>): number => {
    const cut = override?.get(r.id);
    const meshId = r.body.vertices || r.floor.vertices ? mesh(r.name || r.id, cut?.body ?? r.body, cut?.floor ?? r.floor, r.color) : undefined;
    let kids: number[] = (children.get(r.id) ?? []).filter((c) => !skipped(c)).map((c) => node(c, children, override));
    if (r.type === "instance" || r.type === "item") {
      const e = entities.get(r.entity);
      const cuts = new Map(r.cuts.map((c) => [c.shape, c]));
      if (e) kids = [...kids, ...(e.children.get("") ?? []).filter((c) => !skipped(c)).map((c) => node(c, e.children, cuts))];
    }
    const extras = {
      orlablocks: {
        id: r.id,
        type: r.type,
        ...(r.kind ? { kind: r.kind } : {}),
        ...(r.tags.length ? { tags: r.tags } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.entity ? { entity: r.entity } : {}),
        ...(r.type === "note" ? { text: r.text, status: r.status } : {}),
      },
    };
    nodes.push({
      name: r.name ? `${r.name} (${r.id})` : r.id,
      ...transform(r),
      ...(meshId !== undefined ? { mesh: meshId } : {}),
      ...(kids.length ? { children: kids } : {}),
      extras,
    });
    return nodes.length - 1;
  };

  const sceneChildren = childrenOf(m.nodes);
  const top = (sceneChildren.get("") ?? []).filter((r) => !skipped(r)).map((r) => node(r, sceneChildren));
  nodes.push({ name: m.scene.name, children: top, extras: { orlablocks: { project: m.project.name, scene: m.scene.id, exportId: m.exportId } } });
  const root = nodes.length - 1;

  const binary = Buffer.concat(chunks);
  const gltf = {
    asset: { version: "2.0", generator: "orlablocks" },
    scene: 0,
    scenes: [{ name: m.scene.name, nodes: [root] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };
  const pad = (b: Buffer, fill: number) => (b.length % 4 === 0 ? b : Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]));
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const data = pad(binary, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + data.length, 8);
  const chunk = (b: Buffer, type: number) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(b.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, b]);
  };
  return Buffer.concat([header, chunk(json, 0x4e4f534a), chunk(data, 0x004e4942)]);
}

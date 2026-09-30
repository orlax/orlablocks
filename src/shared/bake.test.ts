import Module from "manifold-3d";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bakeShape, uvOffset, type DrawMesh } from "./bake";
import { bakeScene } from "./bakeScene";
import { cutParts, setManifold } from "./csg";
import { expandInstance, setDefinitions } from "./entities";
import { toWorld3 } from "./geometry";
import { signedVolume, type Mesh } from "./mesh";
import { apply, orientationYXZ } from "./rotation3";
import type { Box, ClosedShape, Cylinder, Freeform, Group, Instance, Ramp, SceneNode, Solid } from "./scene.types";

beforeAll(async () => {
  const m = await Module();
  m.setup();
  setManifold(m);
});

const common = { color: "almost-white", createdBy: "human" } as const;
const box = (id: string, patch: Partial<Box> = {}): Box => ({ ...common, id, type: "box", kind: "room", x: 0, z: 0, y: 0, width: 10, depth: 8, height: 3, rotation: 0, ...patch });
const cylinder: Cylinder = { ...common, id: "cylinder_1", type: "cylinder", kind: "volume", x: 3, z: -2, y: 1, width: 4, depth: 4, height: 6, rotation: 20, taper: 0.4, bevel: 0.3, pitch: 12, roll: -8 };
const freeform: Freeform = {
  ...common,
  id: "freeform_1",
  type: "freeform",
  kind: "room",
  y: 0.5,
  height: 4,
  points: [{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 8, z: 3 }, { x: 4, z: 6, in: { x: 1.5, z: 0 }, out: { x: -1.5, z: 0 } }, { x: 0, z: 3 }],
};
const ramp: Ramp = { ...common, id: "ramp_1", type: "ramp", kind: "volume", width: 2, step: 0.25, base: "solid", points: [{ x: 0, y: 0, z: 0 }, { x: 6, y: 2, z: 0 }, { x: 6, y: 3, z: 5 }] };
const door = box("door", { kind: "hole", parent: "g", x: 5, width: 0.6, depth: 1, height: 2.2 });

/** What the editor drew before 15.1 (`useShapeGeometry`'s steps inline), to check the bake against. */
function reference(shape: Solid, cuts?: ClosedShape[]) {
  const parts = cutParts(shape, cuts);
  const [ox, oz] = uvOffset(shape);
  const oy = shape.type === "ramp" ? 0 : shape.y;
  const draw = (mesh: Mesh | null, crease: boolean) => {
    if (!mesh) return null;
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
    indexed.setIndex(mesh.indices);
    const g = indexed.toNonIndexed();
    g.computeVertexNormals();
    const pos = g.getAttribute("position");
    const nrm = g.getAttribute("normal");
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = [pos.getX(i) + ox, pos.getY(i) + oy, pos.getZ(i) + oz];
      const [nx, ny, nz] = [Math.abs(nrm.getX(i)), Math.abs(nrm.getY(i)), Math.abs(nrm.getZ(i))];
      const [u, v] = ny >= nx && ny >= nz ? [x, z] : nx >= nz ? [z, y] : [x, y];
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
    }
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const out = crease ? toCreasedNormals(g, (30 * Math.PI) / 180) : g;
    return { positions: Array.from(out.getAttribute("position").array), normals: Array.from(out.getAttribute("normal").array), uvs: Array.from(out.getAttribute("uv").array) };
  };
  return { body: draw(parts.body, true), floor: draw(parts.floor, false) };
}

const plain = (m: DrawMesh | null) => m && { positions: Array.from(m.positions), normals: Array.from(m.normals), uvs: Array.from(m.uvs) };
const volume = (m: DrawMesh | null) => (m ? signedVolume(Array.from(m.positions), Array.from({ length: m.positions.length / 3 }, (_, i) => i)) : 0);

describe("the bake", () => {
  it("is what the editor drew before, for every kind of shape", () => {
    for (const shape of [box("room"), box("rotated", { rotation: 30, kind: "volume", taper: 0.5 }), cylinder, freeform, ramp]) {
      const baked = bakeShape(shape);
      const ref = reference(shape);
      expect(plain(baked.body)).toEqual(ref.body);
      expect(plain(baked.floor)).toEqual(ref.floor);
    }
  });

  it("cuts a door out of a room's walls, not its floor, and is cached per shape and cuts", () => {
    const room = box("room", { parent: "g" });
    const uncut = bakeShape(room);
    const cut = bakeShape(room, [door]);
    expect(plain(cut.body)).toEqual(reference(room, [door]).body);
    // The door (1 deep along the east wall) takes 1 × the wall (0.2) × 2.2 out of it.
    expect(volume(uncut.body) - volume(cut.body)).toBeCloseTo(1 * 0.2 * 2.2, 3);
    expect(plain(cut.floor)).toEqual(plain(uncut.floor));
    expect(bakeShape(room, [door])).toBe(cut);
    expect(bakeShape(room)).not.toBe(cut);
  });
});

/** A 2 × 2 × 4 pillar volume and a 1 m cube beside it, around the pivot. */
const PILLARS: SceneNode[] = [box("box_1", { kind: "volume", width: 2, depth: 2, height: 4 }), box("box_2", { kind: "volume", x: 3, width: 1, depth: 1, height: 1 })];
const inst = (id: string, fields: Partial<Instance> = {}): Instance => ({ id, type: "instance", entity: "pillars", x: 0, y: 0, z: 0, rotation: 0, createdBy: "human", ...fields });
const group = (id: string): Group => ({ id, type: "group", createdBy: "human" });

describe("baking a scene", () => {
  beforeEach(() => setDefinitions({ pillars: PILLARS }));

  it("bakes an entity once around its pivot, and its instance's transform puts it where the instance's own shapes are", () => {
    const placed = inst("instance_1", { x: 10, y: 2, z: -4, rotation: 30, pitch: 10, roll: -5, scale: 2 });
    const bake = bakeScene([placed]);
    expect([...bake.entities.keys()]).toEqual(["pillars"]);
    expect(bake.variants.size).toBe(0);
    const def = PILLARS[0] as Box;
    const local = bake.entities.get("pillars")!.get("box_1")!.body!;
    const expanded = expandInstance(placed).find((n) => n.id === "instance_1/box_1") as Box;
    const theirs = bakeShape(expanded).body!;
    // Definition frame → the entity's space → the world, by the instance's pivot, orientation and scale.
    const r = orientationYXZ(30, 10, -5);
    const world = (m: DrawMesh, f: (p: { x: number; y: number; z: number }) => { x: number; y: number; z: number }) => {
      const out: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < m.positions.length; i += 3) out.push(f({ x: m.positions[i], y: m.positions[i + 1], z: m.positions[i + 2] }));
      return out;
    };
    const mine = world(local, (p) => {
      const e = apply(r, toWorld3(def, p));
      return { x: 10 + 2 * e.x, y: 2 + 2 * e.y, z: -4 + 2 * e.z };
    });
    const theirs3 = world(theirs, (p) => toWorld3(expanded, p));
    // A tilted instance's shapes are rounded to 0.01 m and 0.01° (`tiltShape`), so they're within a couple of cm.
    expect(mine).toHaveLength(theirs3.length);
    mine.forEach((p, i) => expect(Math.hypot(p.x - theirs3[i].x, p.y - theirs3[i].y, p.z - theirs3[i].z)).toBeLessThan(0.02));
  });

  it("gives an instance a variant only for the shape a scene hole cuts", () => {
    // A hole in a group cuts the top-level instances beside the group; it crosses the first instance's pillar only.
    const hole = box("hole_1", { kind: "hole", parent: "g", x: 0, z: 0, width: 4, depth: 0.5, height: 1 });
    const bake = bakeScene([group("g"), hole, inst("instance_1"), inst("instance_2", { x: 20 })]);
    expect([...bake.variants.keys()]).toEqual(["instance_1"]);
    const variant = bake.variants.get("instance_1")!;
    expect([...variant.keys()]).toEqual(["box_1"]);
    const whole = bake.entities.get("pillars")!.get("box_1")!.body;
    // 2 wide × 0.5 deep × 1 high comes out of the pillar.
    expect(volume(whole) - volume(variant.get("box_1")!.body)).toBeCloseTo(2 * 0.5 * 1, 3);
    // The hole itself is baked uncut, for Unity's gizmo; a hidden hole cuts nothing.
    expect(volume(bake.shapes.get("hole_1")!.body)).toBeCloseTo(4 * 0.5 * 1, 3);
    expect(bakeScene([group("g"), { ...hole, hidden: true }, inst("instance_1")]).variants.size).toBe(0);
  });
});

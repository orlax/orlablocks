import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { beforeAll, describe, expect, it } from "vitest";
import { setDefinitions } from "../shared/entities";
import { EMPTY_LIBRARY } from "../shared/library";
import type { SceneNode } from "../shared/scene.types";
import { buildExport } from "./export";
import { glbFromExport } from "./gltf";
import { loadManifold } from "./manifold";

beforeAll(() => loadManifold());

describe("the .glb, read by three.js's glTF loader", () => {
  it("loads, with its tree, meshes and materials", async () => {
    setDefinitions({ pillar: [{ id: "box_1", type: "box", kind: "volume", x: 0, z: 0, y: 0, width: 1, depth: 1, height: 4, rotation: 0, color: "gray", createdBy: "human" }] });
    const nodes: SceneNode[] = [
      { id: "group_1", type: "group", name: "hall", createdBy: "human" },
      { id: "box_2", type: "box", kind: "room", parent: "group_1", x: 0, z: 0, y: 0, width: 10, depth: 8, height: 3, rotation: 0, color: "blue", createdBy: "human" },
      { id: "instance_1", type: "instance", entity: "pillar", x: 3, y: 0, z: 2, rotation: 0, createdBy: "human" },
    ];
    const { manifest, binary } = buildExport({ project: { id: "p", name: "P", description: "" }, scene: { id: "s", name: "Valley" }, seq: 1, nodes, library: EMPTY_LIBRARY });
    const glb = glbFromExport(manifest, binary);
    const ab = new Uint8Array(glb).buffer;
    const gltf = await new GLTFLoader().parseAsync(ab, "");
    const names: string[] = [];
    gltf.scene.traverse((o) => names.push(o.name));
    expect(names).toEqual(expect.arrayContaining(["Valley", "hall_(group_1)", "box_2", "instance_1", "box_1"]));
    // A room is its walls and its floor: two primitives, which three.js loads as two meshes with two materials.
    const room = gltf.scene.getObjectByName("box_2")!;
    const materials = room.children.map((c) => ((c as unknown as { material: { name: string } }).material.name));
    expect(materials).toEqual(["orla-blue", "orla-blue-floor"]);
  });
});

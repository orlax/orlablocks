import { describe, expect, it } from "vitest";
import type { OpenScene } from "../shared/scene.types";
import { countsText } from "../shared/tree";
import { describeScene, findNodes, FULL_SCENE_MAX, MAX_MATCHES } from "./outline";
import { createSceneStore, SceneError } from "./scene";

const open: OpenScene = { project: { id: "castle", name: "Castle", description: "a test" }, scene: { id: "keep", name: "Keep" } };

/**
 * A castle big enough for the outline: a `lobby` (described), an `east wing` holding a `tower` group, and loose
 * pillars at the top level, padded past FULL_SCENE_MAX with a row of lamps in the east wing.
 */
function castle() {
  const store = createSceneStore();
  const [hall, door] = store.drawShapes(
    [
      { kind: "room", x: 0, z: 0, width: 10, depth: 8, name: "hall" },
      { kind: "hole", x: 0, z: 4, width: 1, depth: 0.4, height: 2.2, name: "front door" },
    ],
    "human",
  );
  const lobby = store.groupNodes({ ids: [hall.id, door.id], name: "lobby", description: "entry hall, safe zone" }, "human");
  const [wing, towerRoom, window] = store.drawShapes(
    [
      { kind: "room", x: 20, z: 0, width: 12, depth: 8, name: "gallery" },
      { type: "cylinder", kind: "room", x: 30, z: -6, width: 6, depth: 6, height: 9, name: "tower room" },
      { type: "cylinder", kind: "hole", x: 30, z: -9, width: 1, depth: 1, height: 1, y: 6, pitch: 90, name: "entry_window" },
    ],
    "human",
  );
  const tower = store.groupNodes({ ids: [towerRoom.id, window.id], name: "tower" }, "human");
  const east = store.groupNodes({ ids: [wing.id, tower.id], name: "east wing" }, "human");
  const [lamp] = store.drawShapes([{ kind: "volume", x: 16, z: 2, width: 0.3, depth: 0.3, height: 2, name: "lamp", parent: east.id }], "human");
  store.duplicateNodes({ ids: [lamp.id], dx: 0.5, count: FULL_SCENE_MAX }, "human");
  const pillars = store.drawShapes(
    [
      { kind: "volume", x: -10, z: -10, width: 1, depth: 1, height: 4, name: "pillar" },
      { kind: "volume", x: -10, z: 10, width: 1, depth: 1, height: 4, name: "pillar" },
    ],
    "human",
  );
  return { store, lobby, east, tower, window, pillars, hall };
}

describe("the outline", () => {
  it("lists the top level by default: groups with bounds, contains and collapsed, shapes in full", () => {
    const { store, lobby, east, pillars } = castle();
    const out = describeScene(open, store.getScene());
    expect(out.detail).toBe("outline, 1 level");
    expect(out.nodes.map((n) => n.id)).toEqual([lobby.id, east.id, ...pillars.map((p) => p.id)]);
    const lobbyLine = out.nodes.find((n) => n.id === lobby.id)!;
    expect(lobbyLine).toMatchObject({ name: "lobby", description: "entry hall, safe zone", contains: "1 room · 1 hole", collapsed: true });
    expect(lobbyLine.bounds).toEqual({ x: 0, z: 0.1, y: 0, width: 10, depth: 8.2, height: 3 });
    const eastLine = out.nodes.find((n) => n.id === east.id)!;
    expect(eastLine.contains).toBe(`2 rooms · ${FULL_SCENE_MAX + 1} volumes · 1 hole · 1 group`);
    // Nothing inside a group is listed at depth 1.
    expect(out.nodes.every((n) => n.parent === undefined)).toBe(true);
    expect(out.counts).toBe(countsText(store.getScene().nodes));
    expect(out).toMatchObject({ project: open.project, scene: open.scene, compass: { north: "-z" } });
  });

  it("opens a group with root, and more levels with depth", () => {
    const { store, east, tower } = castle();
    const inEast = describeScene(open, store.getScene(), { root: east.id });
    expect(inEast.root).toMatchObject({ id: east.id, name: "east wing", path: "" });
    expect(inEast.nodes.every((n) => n.parent === east.id)).toBe(true);
    expect(inEast.nodes.find((n) => n.id === tower.id)).toMatchObject({ collapsed: true, contains: "1 room · 1 hole" });

    const deeper = describeScene(open, store.getScene(), { root: east.id, depth: 2 });
    expect(deeper.nodes.some((n) => n.parent === tower.id)).toBe(true);
    expect(deeper.nodes.find((n) => n.id === tower.id)).not.toHaveProperty("collapsed");
  });

  it("lists everything with full, and comes back in full for a small scene", () => {
    const { store } = castle();
    const all = describeScene(open, store.getScene(), { full: true });
    expect(all.detail).toBe("full");
    expect(all.nodes).toHaveLength(store.getScene().nodes.length);

    const small = createSceneStore();
    small.drawShapes([{ kind: "room", x: 0, z: 0, width: 4, depth: 4 }], "human");
    const g = small.groupNodes({ ids: ["box_1"] }, "human");
    const out = describeScene(open, small.getScene());
    expect(out.detail).toBe("full");
    expect(out.nodes.map((n) => n.id)).toEqual([g.id, "box_1"]);
    expect(out).not.toHaveProperty("hint");
  });

  it("always includes the selection, in full, with its path", () => {
    const { store, window, pillars } = castle();
    store.setSelection([window.id]);
    const out = describeScene(open, store.getScene());
    expect(out.selected).toHaveLength(1);
    expect(out.selected![0]).toMatchObject({ id: window.id, name: "entry_window", pitch: 90, path: "east wing › tower" });
    // A tilted shape reports where it really is.
    expect(out.selected![0].bounds).toBeDefined();
    // Nothing extra when the outline already lists the selection.
    store.setSelection([pillars[0].id]);
    expect(describeScene(open, store.getScene())).not.toHaveProperty("selected");
  });

  it("returns just a shape given as the root, and refuses an unknown root", () => {
    const { store, hall } = castle();
    const out = describeScene(open, store.getScene(), { root: hall.id });
    expect(out.root).toMatchObject({ id: hall.id, name: "hall", path: "lobby" });
    expect(out.nodes).toEqual([]);
    expect(() => describeScene(open, store.getScene(), { root: "group_99" })).toThrow(SceneError);
  });

  it("is much smaller than the full scene", () => {
    const { store } = castle();
    const outline = JSON.stringify(describeScene(open, store.getScene())).length;
    const full = JSON.stringify(describeScene(open, store.getScene(), { full: true })).length;
    expect(outline).toBeLessThan(full / 4);
  });
});

describe("find_nodes", () => {
  it("finds a node by part of its name, any case, with its path", () => {
    const { store, window, east } = castle();
    const { found } = findNodes(store.getScene().nodes, { name: "ENTRY" });
    expect(found).toEqual([
      expect.objectContaining({ id: window.id, type: "cylinder", kind: "hole", name: "entry_window", path: "east wing › tower" }),
    ]);
    expect(found[0].bounds).toBeDefined();
    expect(findNodes(store.getScene().nodes, { name: "tower", type: "group" }).found.map((f) => f.id)).toEqual(["group_2"]);
    expect(east.id).toBe("group_3");
  });

  it("filters by kind, by group and by place", () => {
    const { store, lobby, pillars } = castle();
    const nodes = store.getScene().nodes;
    expect(findNodes(nodes, { kind: "hole" }).found.map((f) => f.name)).toEqual(["front door", "entry_window"]);
    expect(findNodes(nodes, { under: lobby.id }).found.map((f) => f.name)).toEqual(["hall", "front door"]);
    // Bounds within the radius count, not just centers: the hall's edge is 5 m from its center.
    expect(findNodes(nodes, { near: { x: 7, z: 0, radius: 2.5 }, type: "box" }).found.map((f) => f.name)).toEqual(["hall"]);
    expect(findNodes(nodes, { near: { x: -10, z: -10, radius: 1 } }).found.map((f) => f.id)).toEqual([pillars[0].id]);
  });

  it("caps the list and says how many more there are", () => {
    const store = createSceneStore();
    const [lamp] = store.drawShapes([{ kind: "volume", x: 0, z: 0, width: 0.3, depth: 0.3, name: "lamp" }], "human");
    store.duplicateNodes({ ids: [lamp.id], dx: 0.5, count: MAX_MATCHES / 2 }, "human");
    store.duplicateNodes({ ids: [lamp.id], dz: 0.5, count: MAX_MATCHES / 2 + 4 }, "human");
    const result = findNodes(store.getScene().nodes, { name: "lamp" });
    expect(result.found).toHaveLength(MAX_MATCHES);
    expect(result.more).toMatch(/^5 more/);
  });

  it("refuses an unknown group or a shape as `under`", () => {
    const { store, hall } = castle();
    expect(() => findNodes(store.getScene().nodes, { under: "group_99" })).toThrow(/no node/);
    expect(() => findNodes(store.getScene().nodes, { under: hall.id })).toThrow(/not a group/);
  });
});

describe("group descriptions", () => {
  it("are set, trimmed and removed with update_nodes, as undoable steps", () => {
    const { store, lobby } = castle();
    store.updateNodes([{ id: lobby.id, description: "  the way in  " }], "agent");
    expect(store.getScene().nodes.find((n) => n.id === lobby.id)).toMatchObject({ description: "the way in" });
    expect(store.getHistory().undoLabel).toBe(`Agent: describe ${lobby.id}`);
    store.updateNodes([{ id: lobby.id, description: null }], "agent");
    expect(store.getScene().nodes.find((n) => n.id === lobby.id)).not.toHaveProperty("description");
    store.undo();
    expect(store.getScene().nodes.find((n) => n.id === lobby.id)).toMatchObject({ description: "the way in" });
  });

  it("are for groups only", () => {
    const { store, hall } = castle();
    expect(() => store.updateNodes([{ id: hall.id, description: "a hall" }], "agent")).toThrow(/only a group has a description/);
  });
});

describe("countsText", () => {
  it("leaves out what there's none of, and says empty for nothing", () => {
    expect(countsText([])).toBe("empty");
    const store = createSceneStore();
    store.drawShapes(
      [
        { kind: "room", x: 0, z: 0, width: 4, depth: 4 },
        { kind: "room", x: 5, z: 0, width: 4, depth: 4 },
        { type: "line", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] },
      ],
      "human",
    );
    expect(countsText(store.getScene().nodes)).toBe("2 rooms · 1 line");
  });
});

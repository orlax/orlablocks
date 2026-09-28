import { describe, expect, it } from "vitest";
import { resolveRef } from "../shared/library";
import type { Note, OpenScene } from "../shared/scene.types";
import { countsText } from "../shared/tree";
import { noteRect, NOTE_PX } from "../web/pick";
import { createLibraryStore } from "./library";
import { describeScene, findNodes, FULL_SCENE_MAX } from "./outline";
import { createSceneStore } from "./scene";
import { countUses } from "./workspace";

const open: OpenScene = { project: { id: "castle", name: "Castle", description: "" }, scene: { id: "keep", name: "Keep" } };
const note = (store: ReturnType<typeof createSceneStore>, id: string) => store.getScene().nodes.find((n) => n.id === id) as Note;

describe("notes in the store", () => {
  it("draws a note with note_N IDs and defaults: yellow, open, on the ground, no label", () => {
    const store = createSceneStore();
    const [a, b] = store.drawShapes(
      [
        { type: "note", x: 3, z: -2, text: "  we need a @telekinesis challenge here  " },
        { type: "note", x: 0, z: 0, y: 4.5, text: "?", label: " tk ", color: "red", status: "done" },
      ],
      "human",
    );
    expect(a).toEqual({ id: "note_1", type: "note", x: 3, y: 0, z: -2, text: "we need a @telekinesis challenge here", color: "yellow", status: "open", createdBy: "human" });
    expect(b).toMatchObject({ id: "note_2", y: 4.5, label: "tk", color: "red", status: "done" });
    expect(() => store.drawShapes([{ type: "note", x: 0, z: 0, text: "x", label: "TOOLONG" }], "agent")).toThrow(/label/);
  });

  it("changes text, label and status as undoable steps, and refuses fields it doesn't have", () => {
    const store = createSceneStore();
    const [n, box, line] = store.drawShapes(
      [
        { type: "note", x: 0, z: 0, text: "slow down here", label: "SL" },
        { kind: "volume", x: 4, z: 0, width: 1, depth: 1 },
        { type: "line", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] },
      ],
      "human",
    );
    store.updateNodes([{ id: n.id, status: "done" }], "agent");
    expect(store.getHistory().undoLabel).toBe(`Agent: change status of ${n.id}`);
    store.updateNodes([{ id: n.id, label: null, text: "handled: a narrow bridge" }], "agent");
    expect(note(store, n.id)).toMatchObject({ text: "handled: a narrow bridge", status: "done" });
    expect(note(store, n.id)).not.toHaveProperty("label");
    store.undo();
    expect(note(store, n.id)).toMatchObject({ text: "slow down here", label: "SL" });
    expect(() => store.updateNodes([{ id: n.id, width: 3 }], "agent")).toThrow(/is a note, with no width/);
    expect(() => store.updateNodes([{ id: n.id, tags: [] }], "agent")).toThrow(/is a note, with no tags/);
    expect(() => store.updateNodes([{ id: box.id, text: "hi" }], "agent")).toThrow(/only a note has text/);
    expect(() => store.updateNodes([{ id: line.id, status: "done" }], "agent")).toThrow(/only a note has status/);
  });

  it("moves, turns, mirrors and copies with its group", () => {
    const store = createSceneStore();
    const [room, n] = store.drawShapes(
      [
        { kind: "room", x: 0, z: 0, width: 10, depth: 10 },
        { type: "note", x: 4, z: 0, text: "door here" },
      ],
      "human",
    );
    const g = store.groupNodes({ ids: [room.id, n.id] }, "human");
    store.moveNodes({ ids: [g.id], dx: 10, dy: 3, dz: 0 }, "human");
    expect(note(store, n.id)).toMatchObject({ x: 14, y: 3, z: 0 });
    store.rotateNodes({ ids: [g.id], degrees: 90, pivot: { x: 10, z: 0 } }, "human");
    expect(note(store, n.id)).toMatchObject({ x: 10, z: -4 });
    store.mirrorNodes({ ids: [g.id], axis: "z" }, "human");
    expect(note(store, n.id)).toMatchObject({ x: 10, z: 4 });
    store.mirrorNodes({ ids: [g.id], axis: "z" }, "human");
    expect(note(store, n.id)).toMatchObject({ x: 10, z: -4 });
    const [copy] = store.duplicateNodes({ ids: [g.id], dx: 20 }, "human");
    const copied = store.getScene().nodes.find((c) => c.type === "note" && c.parent === copy.id) as Note;
    expect(copied).toMatchObject({ x: 30, z: -4, text: "door here" });
  });

  it("pastes, and counts only open notes", () => {
    const store = createSceneStore();
    store.drawShapes(
      [
        { type: "note", x: 0, z: 0, text: "a" },
        { type: "note", x: 1, z: 0, text: "b", status: "done" },
        { kind: "room", x: 0, z: 0, width: 4, depth: 4 },
      ],
      "human",
    );
    expect(countsText(store.getScene().nodes)).toBe("1 room · 1 note");
    store.pasteNodes({ nodes: [note(store, "note_1")], focus: { x: 10, z: 10 }, parent: null }, "human");
    expect(store.getScene().nodes.filter((n) => n.type === "note")).toHaveLength(3);
  });
});

describe("notes for the agent", () => {
  /** A castle past the small-scene size, with a note deep inside, a done one, and a library. */
  function castle() {
    const lib = createLibraryStore();
    lib.edit({ upsert: [{ kind: "tag", name: "light", description: "small enough to lift" }, { kind: "skill", name: "telekinesis", description: "moves #light things", tags: ["light"] }] }, "human");
    const store = createSceneStore({ resolveTag: (name) => resolveRef(lib.get(), "tag", name)?.name });
    const [yard] = store.drawShapes([{ kind: "room", x: 0, z: 0, width: 20, depth: 20, name: "courtyard" }], "human");
    const inner = store.groupNodes({ ids: [yard.id], name: "courtyard" }, "human");
    const [todo, handled] = store.drawShapes(
      [
        { type: "note", x: 2, z: 2, text: "we need a @telekinesis challenge here", label: "TK", parent: inner.id },
        { type: "note", x: 3, z: 2, text: "lights go here", status: "done", parent: inner.id },
      ],
      "human",
    );
    const outer = store.groupNodes({ ids: [inner.id], name: "west wing" }, "human");
    const [pillar] = store.drawShapes([{ kind: "volume", x: 40, z: 0, width: 1, depth: 1 }], "human");
    store.duplicateNodes({ ids: [pillar.id], dx: 2, count: FULL_SCENE_MAX }, "human");
    return { lib, store, todo, handled, outer };
  }

  it("lists every open note in the outline, at any depth, with its path, and explains its references", () => {
    const { lib, store, todo, outer } = castle();
    const out = describeScene(open, store.getScene(), {}, { library: lib.get() });
    expect(out.nodes.find((n) => n.id === outer.id)).toMatchObject({ collapsed: true, contains: "1 room · 1 note · 1 group" });
    expect(out.notes).toEqual([expect.objectContaining({ id: todo.id, label: "TK", path: "west wing › courtyard" })]);
    expect(out.glossary?.skills?.telekinesis).toEqual({ description: "moves #light things", tags: ["light"] });
    // Opened far enough to list it, it isn't repeated.
    const deep = describeScene(open, store.getScene(), { root: outer.id, depth: 2 }, { library: lib.get() });
    expect(deep.nodes.some((n) => n.id === todo.id)).toBe(true);
    expect(deep).not.toHaveProperty("notes");
  });

  it("finds notes by status and by their text", () => {
    const { lib, store, todo, handled } = castle();
    const nodes = store.getScene().nodes;
    expect(findNodes(nodes, { type: "note", status: "done" }, lib.get()).found).toEqual([
      expect.objectContaining({ id: handled.id, text: "lights go here", status: "done" }),
    ]);
    expect(findNodes(nodes, { name: "TELEKINESIS" }, lib.get()).found.map((f) => f.id)).toEqual([todo.id]);
  });

  it("counts a skill named in a note as a use", () => {
    const { lib, store } = castle();
    expect(countUses(lib.get(), store.getScene().nodes).skills.get("telekinesis")).toBe(1);
  });
});

describe("a note's pin on screen", () => {
  it("is a pole with a flag to its right, or a round head", () => {
    const flag = noteRect({ sx: 100, sy: 200 }, true);
    expect(flag.x1).toBeGreaterThanOrEqual(100 + NOTE_PX.flagW);
    expect(flag.y0).toBeLessThan(200 - NOTE_PX.pole);
    expect(flag.y1).toBeGreaterThan(200);
    const pin = noteRect({ sx: 100, sy: 200 }, false);
    expect(pin.x1).toBeLessThan(flag.x1);
  });
});

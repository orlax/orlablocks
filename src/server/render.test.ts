import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VIEW, RenderRequestSchema, type RenderJob, type SceneNode, type ShotRecord } from "../shared/scene.types";
import { createRenderBroker, NO_EDITOR, prepareRender, type RenderTab } from "./render";
import { SceneError } from "./scene";

afterEach(() => vi.useRealTimers());

const result = { image: "iVBORw0K", width: 10, height: 10, text: "ok" };
/** A tab that remembers what it was asked. */
const tab = () => {
  const asked: { requestId: number; job: RenderJob }[] = [];
  const t: RenderTab & { asked: typeof asked } = { asked, send: (requestId, job) => asked.push({ requestId, job }) };
  return t;
};
const job = RenderRequestSchema.parse({}) as RenderJob;

describe("the render broker", () => {
  it("fails at once with no editor connected", async () => {
    await expect(createRenderBroker().request(job)).rejects.toThrow(NO_EDITOR);
  });

  it("asks the tab on screen that had focus last, and resolves with its answer", async () => {
    const broker = createRenderBroker();
    const a = tab();
    const b = tab();
    const c = tab();
    broker.add(a);
    broker.add(b);
    broker.add(c);
    broker.report(a, { visible: true, focused: true });
    broker.report(c, { visible: false, focused: true });
    // c had focus last but is in the background: a is asked.
    const done = broker.request(job);
    expect(a.asked).toHaveLength(1);
    expect(c.asked).toHaveLength(0);
    broker.answer(a, a.asked[0].requestId, { result });
    await expect(done).resolves.toEqual(result);
    // Nobody on screen: the last one focused anyway.
    broker.report(a, { visible: false, focused: false });
    broker.report(b, { visible: false, focused: false });
    expect(broker.pick()).toBe(c);
  });

  it("passes the editor's error on, ignores answers from others, and fails when the tab leaves", async () => {
    const broker = createRenderBroker();
    const a = tab();
    const b = tab();
    broker.add(a);
    broker.add(b);
    const first = broker.request(job);
    const asked = b.asked[0] ?? a.asked[0];
    const who = b.asked.length > 0 ? b : a;
    const other = who === a ? b : a;
    broker.answer(other, asked.requestId, { result });
    broker.answer(who, asked.requestId, { error: "WebGL is gone" });
    await expect(first).rejects.toThrow(/The render failed: WebGL is gone/);
    const second = broker.request(job);
    broker.remove(who);
    await expect(second).rejects.toThrow(/closed before the render finished/);
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const broker = createRenderBroker(1000);
    const a = tab();
    broker.add(a);
    const late = broker.request(job);
    vi.advanceTimersByTime(1001);
    await expect(late).rejects.toThrow(/didn't answer in 1 s/);
    // A late answer is dropped.
    broker.answer(a, a.asked[0].requestId, { result });
  });
});

describe("preparing a render", () => {
  const nodes = [
    { id: "box_1", type: "box", kind: "room", x: 0, z: 0, y: 0, width: 4, depth: 4, height: 3, rotation: 0, color: "stone", createdBy: "human" },
    { id: "line_1", type: "line", points: [], color: "red", thickness: 3, createdBy: "agent" },
  ] as unknown as SceneNode[];
  const shot = { id: "shot_2", createdBy: "human", createdAt: "", seq: 3, width: 800, height: 450, camera: { kind: "editor", focus: { x: 0, z: 0 }, yaw: 45, distance: 30 } } as ShotRecord;
  const doc = { nodes, view: DEFAULT_VIEW, shot: (id: string) => (id === "shot_2" ? shot : undefined) };
  const prep = (input: object) => prepareRender(RenderRequestSchema.parse(input), doc);

  it("defaults to a sheet and passes a good request through", () => {
    expect(prep({})).toMatchObject({ view: "sheet" });
    expect(prep({ view: "node", ids: ["box_1"] })).toMatchObject({ view: "node", ids: ["box_1"] });
    expect(prep({ view: "walk", path: "line_1" })).toMatchObject({ path: "line_1" });
  });

  it("says what's missing or wrong", () => {
    expect(() => prep({ ids: ["box_9"] })).toThrow(/no node box_9/);
    expect(() => prep({ view: "node" })).toThrow(/needs ids/);
    expect(() => prep({ view: "eye" })).toThrow(/needs from/);
    expect(() => prep({ view: "eye", from: "human" })).toThrow(/isn't walking/);
    expect(() => prep({ view: "eye", from: { x: 0, z: 0 }, at: "box_9" })).toThrow(/at: no node box_9/);
    expect(() => prep({ view: "walk" })).toThrow(/needs a path/);
    expect(() => prep({ view: "walk", path: "box_1" })).toThrow(/a walk follows a line or a ramp/);
    expect(() => prep({ view: "shot" })).toThrow(/needs shot/);
    expect(() => prep({ view: "shot", shot: "shot_9" })).toThrow(/no shot shot_9/);
    expect(() => prep({ view: "sheet", save: true })).toThrow(/only a node, eye or shot view/);
    expect(() => prep({ view: "node" })).toThrow(SceneError);
  });

  it("fills in where the human walks and a shot's camera", () => {
    const walking = { preset: "first" as const, eye: { x: 1, y: 1.65, z: 2 }, yaw: 90, pitch: 0, fov: 90 };
    expect(prepareRender(RenderRequestSchema.parse({ view: "eye", from: "human" }), { ...doc, view: { ...DEFAULT_VIEW, walking } }).human).toEqual(walking);
    expect(prep({ view: "shot", shot: "shot_2", save: true }).shotCamera).toEqual({ camera: shot.camera, width: 800, height: 450 });
  });
});

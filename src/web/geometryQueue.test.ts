import { afterEach, expect, it, vi } from "vitest";
import type { GeometryJob, GeometryReply, GeometryRequest } from "./geometryWork";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("deduplicates work, drops stale previews and sends the latest edit ahead of queued batches", async () => {
  const posted: GeometryRequest[] = [];
  let instance: TestWorker;
  class TestWorker {
    onmessage?: (event: { data: GeometryReply }) => void;
    postMessage(request: GeometryRequest) { posted.push(request); }
    constructor() { instance = this; }
  }
  vi.stubGlobal("Worker", TestWorker);
  const { requestGeometry, hasGeometryWork } = await import("./geometryQueue");
  const job: GeometryJob = { kind: "batch", shapes: [] };
  const stale = vi.fn(), batch = vi.fn(), edit = vi.fn(), copy = vi.fn();
  const drop = requestGeometry("old", job, true, stale);
  await Promise.resolve();
  requestGeometry("batch", job, false, batch);
  const obsolete = requestGeometry("obsolete", job, true, stale);
  requestGeometry("latest", job, true, edit);
  requestGeometry("latest", job, true, copy);
  drop();
  obsolete();
  const reply = (i: number) => instance.onmessage?.({ data: { id: posted[i].id, result: { body: null, floor: null, edges: null } } });
  reply(0);
  await Promise.resolve();
  expect(stale).not.toHaveBeenCalled();
  reply(1);
  await Promise.resolve();
  expect(edit).toHaveBeenCalledTimes(1);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(batch).not.toHaveBeenCalled();
  reply(2);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(hasGeometryWork()).toBe(false);
});

it("releases running and queued work for exact fallback if the worker transport fails", async () => {
  let fail: ((event: { message: string }) => void) | undefined;
  const terminate = vi.fn();
  class FailingWorker {
    set onerror(listener: (event: { message: string }) => void) { fail = listener; }
    postMessage() {}
    terminate = terminate;
  }
  vi.stubGlobal("Worker", FailingWorker);
  const { requestGeometry, supportsGeometryWorker, hasGeometryWork } = await import("./geometryQueue");
  const job: GeometryJob = { kind: "batch", shapes: [] };
  const running = vi.fn(), queued = vi.fn();
  requestGeometry("running", job, false, running);
  requestGeometry("queued", job, false, queued);
  await Promise.resolve();
  fail?.({ message: "Worker transport failed" });
  expect(terminate).toHaveBeenCalledOnce();
  expect(running).toHaveBeenCalledWith(null);
  expect(queued).toHaveBeenCalledWith(null);
  expect(hasGeometryWork()).toBe(false);
  expect(supportsGeometryWorker()).toBe(false);
});

it("runs a shape burst on at most two workers and keeps background batches on the primary", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const lanes: TestWorker[] = [];
  class TestWorker {
    posted: GeometryRequest[] = [];
    terminated = false;
    onmessage?: (event: { data: GeometryReply }) => void;
    postMessage(request: GeometryRequest) { this.posted.push(request); }
    constructor() { lanes.push(this); }
    terminate() { this.terminated = true; }
    reply() {
      this.onmessage?.({ data: { id: this.posted.at(-1)!.id, result: { body: null, floor: null, edges: null } } });
    }
  }
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
  const { requestGeometry, hasGeometryWork } = await import("./geometryQueue");
  const batch: GeometryJob = { kind: "batch", shapes: [] };
  const shape: GeometryJob = { kind: "shape", shape: { id: "box", type: "box", kind: "volume", x: 0, y: 0, z: 0, height: 1, width: 1, depth: 1, rotation: 0, color: "gray", createdBy: "human" } };
  const listeners = Array.from({ length: 4 }, () => vi.fn());
  const merged = vi.fn();
  requestGeometry("background", batch, false, merged);
  const unsubscribe = listeners.map((listener, i) => requestGeometry(`cut-${i}`, shape, true, listener));
  await Promise.resolve();
  expect(lanes.map((lane) => lane.posted.map((entry) => entry.job.kind))).toEqual([["shape"], ["shape"]]);
  unsubscribe[1]();
  lanes[1].reply();
  await Promise.resolve();
  expect(listeners[0]).not.toHaveBeenCalled();
  expect(listeners[1]).not.toHaveBeenCalled();
  lanes[1].reply();
  await Promise.resolve();
  lanes[0].reply();
  await Promise.resolve();
  expect(lanes[0].posted.at(-1)?.job.kind).toBe("batch");
  expect(lanes[1].posted.every((entry) => entry.job.kind === "shape")).toBe(true);
  lanes[1].reply();
  lanes[0].reply();
  await Promise.resolve();
  expect(listeners.map((listener) => listener.mock.calls.length)).toEqual([1, 0, 1, 1]);
  expect(merged).toHaveBeenCalledOnce();
  expect(hasGeometryWork()).toBe(false);
  vi.advanceTimersByTime(30_000);
  expect(lanes.map((lane) => lane.terminated)).toEqual([false, true]);
});

it("reuses a committed exact mesh without queueing work and caps retained results", async () => {
  const { cachedGeometry, rememberGeometry, requestGeometry, hasGeometryWork } = await import("./geometryQueue");
  const geometry = { body: null, floor: null, edges: new Float32Array([1, 2, 3, 4, 5, 6]) };
  rememberGeometry("exact", geometry);
  const reply = vi.fn();
  requestGeometry("exact", { kind: "batch", shapes: [] }, false, reply);
  expect(reply).toHaveBeenCalledWith(geometry);
  expect(hasGeometryWork()).toBe(false);
  for (let i = 0; i < 512; i++) rememberGeometry(`recent-${i}`, geometry);
  expect(cachedGeometry("exact")).toBeUndefined();
  expect(cachedGeometry("recent-511")).toBe(geometry);
});

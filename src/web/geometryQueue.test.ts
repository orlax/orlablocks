import { afterEach, expect, it, vi } from "vitest";
import type { GeometryJob, GeometryReply, GeometryRequest } from "./geometryWork";

afterEach(() => {
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
  requestGeometry("batch", job, false, batch);
  const obsolete = requestGeometry("obsolete", job, true, stale);
  requestGeometry("latest", job, true, edit);
  requestGeometry("latest", job, true, copy);
  drop();
  obsolete();
  const reply = (i: number) => instance.onmessage?.({ data: { id: posted[i].id, result: { body: null, floor: null, edges: null } } });
  reply(0);
  expect(stale).not.toHaveBeenCalled();
  reply(1);
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
  fail?.({ message: "Worker transport failed" });
  expect(terminate).toHaveBeenCalledOnce();
  expect(running).toHaveBeenCalledWith(null);
  expect(queued).toHaveBeenCalledWith(null);
  expect(hasGeometryWork()).toBe(false);
  expect(supportsGeometryWorker()).toBe(false);
});

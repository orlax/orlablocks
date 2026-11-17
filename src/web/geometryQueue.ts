import { geometryArrays, type GeometryJob, type GeometryReply, type GeometryRequest, type PreparedGeometry } from "./geometryWork";
import { reportError } from "./errors";

type Reply = (geometry: PreparedGeometry | null) => void;
type Work = GeometryRequest & { key: string; listeners: Set<Reply>; priority: boolean; running?: true };
type Lane = { worker: Worker; active?: Work; timeout?: ReturnType<typeof setTimeout> };

const MAX_CACHE_BYTES = 96 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 512;
const TIMEOUT_MS = 20_000;
const RETIRE_AFTER_MS = 30_000;
const PARALLEL_QUEUE_THRESHOLD = 3;
const cache = new Map<string, { data: PreparedGeometry; bytes: number }>();
let cacheBytes = 0;
const jobs = new Map<string, Work>();
const subscribers = new Set<() => void>();
let serial = 0;
const lanes: Lane[] = [];
let broken = false;
let dispatchScheduled = false;
let retireTimer: ReturnType<typeof setTimeout> | undefined;

export const supportsGeometryWorker = () => !broken && typeof Worker !== "undefined";
export function hasGeometryWork() {
  for (const job of jobs.values()) if (job.listeners.size) return true;
  return false;
}
export function subscribeGeometryWork(listener: () => void) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
function notify() {
  for (const listener of subscribers) listener();
}

export function cachedGeometry(key: string): PreparedGeometry | undefined {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  cache.set(key, entry);
  return entry.data;
}

/** Share the bounded result cache between worker replies and committed exact synchronous meshes. */
export function rememberGeometry(key: string, data: PreparedGeometry) {
  if (cache.has(key)) return;
  const bytes = geometryArrays(data).reduce((sum, array) => sum + array.byteLength, 0);
  if (bytes > MAX_CACHE_BYTES) return;
  cache.set(key, { data, bytes });
  cacheBytes += bytes;
  while (cacheBytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value!;
    cacheBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
}

function failWorkers(error: unknown) {
  broken = true;
  clearTimeout(retireTimer);
  for (const lane of lanes.splice(0)) {
    clearTimeout(lane.timeout);
    lane.worker.terminate();
  }
  const outstanding = [...jobs.values()];
  jobs.clear();
  reportError("view", error);
  for (const job of outstanding) for (const listener of job.listeners) listener(null);
  notify();
}

function makeLane(): Lane {
  const worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module" });
  const lane: Lane = { worker };
  lanes.push(lane);
  worker.onerror = (event) => {
    if (lanes.includes(lane)) failWorkers(new Error(event.message || "The geometry worker stopped"));
  };
  worker.onmessageerror = () => {
    if (lanes.includes(lane)) failWorkers(new Error("The geometry worker reply could not be read"));
  };
  worker.onmessage = ({ data }: MessageEvent<GeometryReply>) => {
    const finished = lane.active;
    if (!lanes.includes(lane) || !finished || finished.id !== data.id) return;
    clearTimeout(lane.timeout);
    lane.active = undefined;
    jobs.delete(finished.key);
    // Superseded work can finish, but only currently subscribed signatures may update the view.
    if (finished.listeners.size) {
      if ("error" in data) reportError("view", new Error(data.error));
      else rememberGeometry(finished.key, data.result);
      for (const listener of finished.listeners) listener("result" in data ? data.result : null);
    }
    notify();
    scheduleDispatch();
  };
  return lane;
}

function start(lane: Lane, work: Work) {
  work.running = true;
  lane.active = work;
  lane.timeout = setTimeout(() => failWorkers(new Error("The geometry worker timed out")), TIMEOUT_MS);
  lane.worker.postMessage({ id: work.id, job: work.job } satisfies GeometryRequest);
}

function dispatch() {
  dispatchScheduled = false;
  if (broken) return;
  try {
    const shapes: Work[] = [];
    let batch: Work | undefined;
    for (const job of jobs.values()) {
      if (job.running) continue;
      if (job.priority) {
        shapes.push(job);
        if (shapes.length > PARALLEL_QUEUE_THRESHOLD) break;
      } else batch ??= job;
    }
    let primary = lanes[0];
    if (!primary && (shapes.length || batch)) primary = makeLane();
    if (primary && !primary.active) {
      const first = shapes.shift() ?? batch;
      if (first) start(primary, first);
    }
    let extra = lanes[1];
    if (!extra && shapes.length >= PARALLEL_QUEUE_THRESHOLD && (globalThis.navigator?.hardwareConcurrency ?? 1) >= 4) {
      extra = makeLane();
    }
    if (extra && !extra.active && shapes.length) start(extra, shapes[0]);
    // Keep a second Manifold runtime warm over a burst of edits, then release its memory.
    if (extra?.active && retireTimer !== undefined) {
      clearTimeout(retireTimer);
      retireTimer = undefined;
    } else if (extra && !extra.active && retireTimer === undefined) {
      const idle = extra;
      retireTimer = setTimeout(() => {
        retireTimer = undefined;
        if (lanes[1] !== idle || idle.active) return;
        lanes.pop();
        idle.worker.terminate();
      }, RETIRE_AFTER_MS);
    }
  } catch (error) {
    failWorkers(error);
  }
}

function scheduleDispatch() {
  if (dispatchScheduled || broken) return;
  dispatchScheduled = true;
  // Register a commit's requests before choosing which runnable work to dispatch.
  queueMicrotask(dispatch);
}

/** A mounted requester owns its pending key. Effect cleanup removes obsolete previews before they reach the worker. */
export function requestGeometry(key: string, job: GeometryJob, priority: boolean, listener: Reply): () => void {
  const cached = cachedGeometry(key);
  if (cached || !supportsGeometryWorker()) {
    listener(cached ?? null);
    return () => {};
  }
  let work = jobs.get(key);
  if (!work) {
    work = { id: ++serial, key, job, priority, listeners: new Set() };
    jobs.set(key, work);
  }
  work.listeners.add(listener);
  notify();
  scheduleDispatch();
  return () => {
    work.listeners.delete(listener);
    if (!work.running && !work.listeners.size && jobs.get(key) === work) jobs.delete(key);
    notify();
  };
}

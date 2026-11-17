import { geometryArrays, type GeometryJob, type GeometryReply, type GeometryRequest, type PreparedGeometry } from "./geometryWork";
import { reportError } from "./errors";

type Reply = (geometry: PreparedGeometry | null) => void;
type Work = GeometryRequest & { key: string; listeners: Set<Reply>; priority: boolean };

const MAX_CACHE_BYTES = 96 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 512;
const TIMEOUT_MS = 20_000;
const cache = new Map<string, { data: PreparedGeometry; bytes: number }>();
let cacheBytes = 0;
const jobs = new Map<string, Work>();
const subscribers = new Set<() => void>();
let serial = 0;
let worker: Worker | undefined;
let broken = false;
let running: Work | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;

export const supportsGeometryWorker = () => !broken && typeof Worker !== "undefined";
export const hasGeometryWork = () => jobs.size > 0 && (!running || jobs.size > 1 || running.listeners.size > 0);
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

function store(key: string, data: PreparedGeometry) {
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

function failWorker(error: unknown) {
  broken = true;
  worker?.terminate();
  worker = undefined;
  clearTimeout(timeout);
  running = undefined;
  const outstanding = [...jobs.values()];
  jobs.clear();
  reportError("view", error);
  for (const job of outstanding) for (const listener of job.listeners) listener(null);
  notify();
}

function next() {
  if (running || !jobs.size || broken) return;
  try {
    if (!worker) {
      worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module" });
      worker.onerror = (event) => failWorker(new Error(event.message || "The geometry worker stopped"));
      worker.onmessageerror = () => failWorker(new Error("The geometry worker reply could not be read"));
      worker.onmessage = ({ data }: MessageEvent<GeometryReply>) => {
        if (!running || running.id !== data.id) return;
        clearTimeout(timeout);
        const finished = running;
        running = undefined;
        jobs.delete(finished.key);
        // Superseded work can finish, but only currently subscribed signatures may update the view.
        if (finished.listeners.size) {
          if ("error" in data) reportError("view", new Error(data.error));
          else store(finished.key, data.result);
          for (const listener of finished.listeners) listener("result" in data ? data.result : null);
        }
        notify();
        next();
      };
    }
    let first: Work | undefined;
    for (const work of jobs.values()) {
      first ??= work;
      if (work.priority) {
        first = work;
        break;
      }
    }
    if (!first) return;
    running = first;
    worker.postMessage({ id: first.id, job: first.job } satisfies GeometryRequest);
    timeout = setTimeout(() => failWorker(new Error("The geometry worker timed out")), TIMEOUT_MS);
  } catch (error) {
    failWorker(error);
  }
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
  next();
  return () => {
    work.listeners.delete(listener);
    if (work !== running && !work.listeners.size && jobs.get(key) === work) jobs.delete(key);
    notify();
  };
}

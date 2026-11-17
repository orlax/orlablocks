import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { toBufferGeometry } from "../shared/bake";
import { cachedGeometry, rememberGeometry, requestGeometry, supportsGeometryWorker } from "./geometryQueue";
import { prepareGeometry, type GeometryJob, type PreparedGeometry } from "./geometryWork";

/** Captures render an exact snapshot without depending on a live preview or a React effect in the capture root. */
export const GeometryWorkers = createContext(true);

export function usePreparedGeometry(key: string, job: GeometryJob, eligible: boolean, syncKey = key, syncJob = job, retainSync = true) {
  const live = useContext(GeometryWorkers);
  const async = live && eligible && supportsGeometryWorker();
  const [reply, setReply] = useState<{ key: string; data: PreparedGeometry | null } | undefined>();
  const exact = reply?.key === key ? reply.data : undefined;
  const failed = exact === null;
  useEffect(() => {
    if (async) return requestGeometry(key, job, job.kind === "shape", (data) => setReply({ key, data }));
  }, [async, key]);
  const sync = !async || failed;
  const immediate = useMemo(() => sync ? (cachedGeometry(syncKey) ?? prepareGeometry(syncJob, !live)) : undefined, [sync, syncKey, live]);
  const data = sync ? immediate : exact ?? cachedGeometry(key);
  // A synchronous CSG fallback can report an error and return uncut geometry. Only cache its verified worker
  // counterpart. Transient drafts also stay out of the cache.
  const reusable = live && sync && retainSync && (syncJob.kind === "batch" || !syncJob.cuts?.length);
  const previous = useRef<PreparedGeometry | undefined>(undefined);
  useLayoutEffect(() => {
    if (!data) return;
    previous.current = data;
    if (reusable) rememberGeometry(syncKey, data);
  }, [data, reusable, syncKey]);
  return { data, previous: previous.current, pending: !sync && !data };
}

export function useGeometryBuffers(data: PreparedGeometry | undefined) {
  const buffers = useMemo(() => ({
    solid: data?.body ? toBufferGeometry(data.body) : null,
    floor: data?.floor ? toBufferGeometry(data.floor) : null,
    edges: data?.edges ? new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(data.edges, 3)) : null,
  }), [data]);
  useEffect(() => () => {
    buffers.solid?.dispose();
    buffers.floor?.dispose();
    buffers.edges?.dispose();
  }, [buffers]);
  return buffers;
}

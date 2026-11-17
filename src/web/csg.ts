import { useEffect, useState } from "react";
import Module from "manifold-3d";
import wasmUrl from "manifold-3d/manifold.wasm?url";
import { manifoldLoaded, setManifold } from "../shared/csg";
import { reportError } from "./errors";

/**
 * The boolean library in the browser: manifold loads once, in the background, and is handed to `src/shared/csg.ts`,
 * which cuts the holes (15.1). Until it's ready shapes are drawn uncut.
 */

let loading: Promise<void> | null = null;
const waiting = new Set<() => void>();

function load(): Promise<void> {
  loading ??= Module({ locateFile: () => wasmUrl })
    .then((m) => {
      m.setup();
      setManifold(m, (e) => reportError("view", e));
      waiting.forEach((f) => f());
      waiting.clear();
    })
    .catch((e) => { reportError("view", e); throw e; });
  return loading;
}

/** Captures require the boolean library before using their synchronous geometry path. */
export const manifoldReady = (): Promise<void> => (manifoldLoaded() ? Promise.resolve() : load());

/** Whether the boolean library is ready; loads it on first use and re-renders the caller when it is. */
export function useManifold(needed: boolean): boolean {
  const [ready, setReady] = useState(manifoldLoaded());
  useEffect(() => {
    if (!needed || manifoldLoaded()) return;
    const done = () => setReady(true);
    waiting.add(done);
    void load().catch(() => {});
    return () => void waiting.delete(done);
  }, [needed]);
  return ready || manifoldLoaded();
}

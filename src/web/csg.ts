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
    .catch((e) => reportError("view", e));
  return loading;
}

/** Resolves once the boolean library is ready (or failed to load, when shapes draw uncut). */
export const manifoldReady = (): Promise<void> => (manifoldLoaded() ? Promise.resolve() : load());

/** Whether the boolean library is ready; loads it on first use and re-renders the caller when it is. */
export function useManifold(): boolean {
  const [ready, setReady] = useState(manifoldLoaded());
  useEffect(() => {
    if (manifoldLoaded()) return;
    const done = () => setReady(true);
    waiting.add(done);
    void load();
    return () => void waiting.delete(done);
  }, []);
  return ready;
}

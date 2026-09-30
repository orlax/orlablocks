import Module from "manifold-3d";
import { manifoldLoaded, setManifold } from "../shared/csg";

/**
 * The boolean library on the server (15.1), for the export's cuts: loaded once, on first use. In the bundled server
 * (`scripts/build-server.mjs`) manifold finds `manifold.wasm` next to `main.js`, where the build copies it. Cut
 * failures go to `report` (the export collects them as warnings).
 */

let loading: Promise<void> | null = null;
let report: (e: unknown) => void = () => {};

export function loadManifold(): Promise<void> {
  if (manifoldLoaded()) return Promise.resolve();
  loading ??= Module().then((m) => {
    m.setup();
    setManifold(m, (e) => report(e));
  });
  return loading;
}

/** Where cut failures go from now on (the export in progress sets its own, and clears it after). */
export function onCutError(handler: (e: unknown) => void): void {
  report = handler;
}

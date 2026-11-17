import Module from "manifold-3d";
import wasmUrl from "manifold-3d/manifold.wasm?url";
import { setManifold } from "../shared/csg";
import { geometryArrays, prepareGeometry, type GeometryReply, type GeometryRequest } from "./geometryWork";

const worker = self as unknown as {
  onmessage: (event: MessageEvent<GeometryRequest>) => void;
  postMessage: (reply: GeometryReply, transfers?: Transferable[]) => void;
};
let loading: Promise<void> | undefined;

worker.onmessage = async ({ data: { id, job } }) => {
  try {
    if (job.kind === "shape" && job.cuts?.length) {
      loading ??= Module({ locateFile: () => wasmUrl }).then((manifold) => {
        manifold.setup();
        setManifold(manifold);
      });
      await loading;
    }
    const result = prepareGeometry(job, true);
    worker.postMessage({ id, result }, [...new Set(geometryArrays(result).map((array) => array.buffer as ArrayBuffer))]);
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

import { memo } from "react";
import { ShapeMesh, colorMaterials, getShared } from "./ShapeMesh";
import type { StaticBatch } from "./staticBatches";
import { useGeometryBuffers, usePreparedGeometry } from "./usePreparedGeometry";

export const StaticMeshes = memo(function StaticMeshes({ batch }: { batch: StaticBatch }) {
  const { data, pending, previous } = usePreparedGeometry(
    `batch:${batch.signature}`, { kind: "batch", shapes: batch.shapes }, true,
  );
  const { solid, floor, edges } = useGeometryBuffers(data);
  // On a live edit, keep the affected cell visible with individual shapes while exact buffers are prepared.
  // The old batch is removed immediately so old transforms and cuts cannot leak into picking or Walk.
  if (pending && previous) return <>{batch.shapes.map((shape) => <ShapeMesh key={shape.id} shape={shape} />)}</>;
  if (!data) return null;
  const materials = colorMaterials(batch.color);
  return (
    <>
      {solid && <mesh geometry={solid} material={materials.body} userData={{ walkable: true }} castShadow receiveShadow />}
      {floor && <mesh geometry={floor} material={materials.floor} userData={{ walkable: true }} receiveShadow />}
      {edges && <lineSegments geometry={edges} material={getShared().edge} renderOrder={1} />}
    </>
  );
}, (a, b) => a.batch.signature === b.batch.signature);

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { evaluateTerrain } from "../shared/terrain";
import { PALETTE, type SceneNode, type Terrain } from "../shared/scene.types";

export function TerrainMesh({ terrain, nodes, selected = false }: { terrain: Terrain; nodes: SceneNode[]; selected?: boolean }) {
  const field = useMemo(() => evaluateTerrain(terrain, nodes), [terrain, nodes]);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(field.mesh.positions, 3));
    g.setIndex(field.mesh.indices); g.computeVertexNormals();
    return g;
  }, [field]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} receiveShadow castShadow>
    <meshStandardMaterial color={PALETTE[terrain.color]} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} roughness={0.9} side={THREE.DoubleSide} emissive={selected ? "#355477" : "#000000"} emissiveIntensity={0.25} />
  </mesh>;
}

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { WALL_THICKNESS, type BoxKind } from "../shared/scene.types";

type Props = {
  kind: BoxKind;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  /** The live preview while drawing: translucent blue, so it reads as not-yet-placed. */
  draft?: boolean;
  highlight?: "hover" | "selected";
};

const FLOOR_THICKNESS = 0.04; // a thin slab just above the ground, so it hides the grid inside the room

/** A white 1 m tile with thin gray borders: the classic prototype texture. Lines land on whole meters. */
function tileTexture() {
  const size = 256;
  const line = 3; // total px, split across the tile border so neighbors join into one line
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#c4bfb5";
  ctx.fillRect(0, 0, size, line / 2);
  ctx.fillRect(0, size - line / 2, size, line / 2);
  ctx.fillRect(0, 0, line / 2, size);
  ctx.fillRect(size - line / 2, 0, line / 2, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

const SELECT_COLOR = "#3d7be0";

// Graybox materials, shared by every box: warm near-white, matte, tiled every meter.
let materials: ReturnType<typeof createMaterials> | null = null;
function createMaterials() {
  const tiles = tileTexture();
  const wall = new THREE.MeshLambertMaterial({ color: "#f3f0ea", map: tiles });
  const floor = new THREE.MeshLambertMaterial({ color: "#e6e2da", map: tiles });
  const volume = new THREE.MeshLambertMaterial({ color: "#ece9e3", map: tiles });
  // Selected: the same materials with a faint blue glow.
  const selected = (m: THREE.MeshLambertMaterial) => {
    const c = m.clone();
    c.emissive.set(SELECT_COLOR);
    c.emissiveIntensity = 0.22;
    return c;
  };
  return {
    wall,
    floor,
    volume,
    wallSelected: selected(wall),
    floorSelected: selected(floor),
    volumeSelected: selected(volume),
    edge: new THREE.LineBasicMaterial({ color: "#8a857b", transparent: true, opacity: 0.3 }),
    edgeHover: new THREE.LineBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0.6 }),
    edgeSelected: new THREE.LineBasicMaterial({ color: SELECT_COLOR }),
    draft: new THREE.MeshLambertMaterial({ color: "#3d7be0", transparent: true, opacity: 0.35, depthWrite: false }),
    draftEdge: new THREE.LineBasicMaterial({ color: "#3d7be0" }),
  };
}
const getMaterials = () => (materials ??= createMaterials());

/**
 * World-aligned UVs (1 unit = 1 m), picked per face from its dominant normal axis, so the tile grid
 * lines up across faces and across boxes. `ox, oz` is the geometry's world offset.
 */
function applyWorldUVs(geometry: THREE.BufferGeometry, ox: number, oz: number) {
  const pos = geometry.getAttribute("position");
  const nrm = geometry.getAttribute("normal");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + ox;
    const y = pos.getY(i);
    const z = pos.getZ(i) + oz;
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const [u, v] = ny >= nx && ny >= nz ? [x, z] : nx >= nz ? [z, y] : [x, y];
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/**
 * A ring of walls around the footprint, extruded up to `height`. Built as a rectangle with a rectangular hole
 * so it's one mesh with clean edges (no seams at the corners). Local coordinates: origin at the footprint's
 * min corner on the ground.
 */
function wallGeometry(width: number, depth: number, height: number) {
  const half = WALL_THICKNESS / 2;
  // Shape is drawn in x / -z, then rotated so the extrusion points up (+y).
  const outer = new THREE.Shape()
    .moveTo(-half, half)
    .lineTo(width + half, half)
    .lineTo(width + half, -depth - half)
    .lineTo(-half, -depth - half)
    .closePath();
  // Rooms narrower than two wall thicknesses have no inside left: they render as a solid block.
  if (width > WALL_THICKNESS && depth > WALL_THICKNESS) {
    outer.holes.push(
      new THREE.Path()
        .moveTo(half, -half)
        .lineTo(half, -depth + half)
        .lineTo(width - half, -depth + half)
        .lineTo(width - half, -half)
        .closePath(),
    );
  }
  const geometry = new THREE.ExtrudeGeometry(outer, { depth: height, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * Graybox rendering. A room is a floor slab plus thick walls, with no ceiling, so you see in from above.
 * A volume is a solid block. Both cast and receive shadows and have faint outlined edges.
 */
export function BoxMesh({ kind, x, z, width, depth, height, draft = false, highlight }: Props) {
  const solid = useMemo(() => {
    if (kind === "volume") {
      const g = new THREE.BoxGeometry(width, height, depth);
      g.translate(width / 2, height / 2, depth / 2);
      return applyWorldUVs(g, x, z);
    }
    return applyWorldUVs(wallGeometry(width, depth, height), x, z);
  }, [kind, x, z, width, depth, height]);

  const floor = useMemo(() => {
    if (kind !== "room") return null;
    const g = new THREE.BoxGeometry(width, FLOOR_THICKNESS, depth);
    g.translate(width / 2, FLOOR_THICKNESS / 2, depth / 2);
    return applyWorldUVs(g, x, z);
  }, [kind, x, z, width, depth]);

  const edges = useMemo(() => new THREE.EdgesGeometry(solid, 15), [solid]);

  useEffect(() => () => solid.dispose(), [solid]);
  useEffect(() => () => floor?.dispose(), [floor]);
  useEffect(() => () => edges.dispose(), [edges]);

  const m = getMaterials();
  const sel = highlight === "selected";
  const bodyMaterial = draft
    ? m.draft
    : kind === "room"
      ? sel ? m.wallSelected : m.wall
      : sel ? m.volumeSelected : m.volume;
  const floorMaterial = draft ? m.draft : sel ? m.floorSelected : m.floor;
  const edgeMaterial = draft ? m.draftEdge : sel ? m.edgeSelected : highlight === "hover" ? m.edgeHover : m.edge;

  return (
    <group position={[x, 0, z]}>
      <mesh geometry={solid} material={bodyMaterial} castShadow={!draft} receiveShadow={!draft} />
      {floor && <mesh geometry={floor} material={floorMaterial} receiveShadow={!draft} />}
      <lineSegments geometry={edges} material={edgeMaterial} renderOrder={1} />
    </group>
  );
}

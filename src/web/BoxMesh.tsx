import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { PALETTE, WALL_THICKNESS, type BoxColor, type BoxKind } from "../shared/scene.types";

type Props = {
  kind: BoxKind;
  x: number; // footprint center
  z: number;
  y: number; // bottom
  width: number;
  depth: number;
  height: number;
  rotation: number; // degrees, counterclockwise seen from above
  color: BoxColor;
  /** The live preview while drawing: translucent blue, so it reads as not-yet-placed. */
  draft?: boolean;
  highlight?: "hover" | "selected";
};

const FLOOR_THICKNESS = 0.04; // a thin slab just above the box's bottom, so it hides the grid inside the room
/** Room floors are a slightly darker shade of the room's color. */
const FLOOR_SHADE = 0.94;

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

// Graybox materials: matte, tiled every meter, in the box's palette color. Shared per color, made on first use.
let shared: ReturnType<typeof createShared> | null = null;
function createShared() {
  return {
    tiles: tileTexture(),
    edge: new THREE.LineBasicMaterial({ color: "#8a857b", transparent: true, opacity: 0.3 }),
    edgeHover: new THREE.LineBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0.6 }),
    edgeSelected: new THREE.LineBasicMaterial({ color: SELECT_COLOR }),
    draft: new THREE.MeshLambertMaterial({ color: "#3d7be0", transparent: true, opacity: 0.35, depthWrite: false }),
    draftEdge: new THREE.LineBasicMaterial({ color: "#3d7be0" }),
  };
}
const getShared = () => (shared ??= createShared());

type ColorMaterials = Record<"body" | "floor" | "bodySelected" | "floorSelected", THREE.MeshLambertMaterial>;
const byColor = new Map<BoxColor, ColorMaterials>();
function colorMaterials(color: BoxColor): ColorMaterials {
  let m = byColor.get(color);
  if (m) return m;
  const map = getShared().tiles;
  const body = new THREE.MeshLambertMaterial({ color: PALETTE[color], map });
  const floor = new THREE.MeshLambertMaterial({ color: new THREE.Color(PALETTE[color]).multiplyScalar(FLOOR_SHADE), map });
  // Selected: the same materials with a faint blue glow.
  const selected = (base: THREE.MeshLambertMaterial) => {
    const c = base.clone();
    c.emissive.set(SELECT_COLOR);
    c.emissiveIntensity = 0.22;
    return c;
  };
  m = { body, floor, bodySelected: selected(body), floorSelected: selected(floor) };
  byColor.set(color, m);
  return m;
}

/**
 * Box-aligned UVs (1 unit = 1 m), picked per face from its dominant normal axis in the box's local frame, so tiles
 * follow the box's edges. `ox, oy, oz` offsets them: with the box's world position for an unrotated box (its tiles
 * line up with the ground grid and with other boxes), with its half size for a rotated one (tiles start at a corner).
 */
function applyBoxUVs(geometry: THREE.BufferGeometry, ox: number, oy: number, oz: number) {
  const pos = geometry.getAttribute("position");
  const nrm = geometry.getAttribute("normal");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + ox;
    const y = pos.getY(i) + oy;
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
 * center, on the box's bottom.
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
  geometry.translate(-width / 2, 0, -depth / 2);
  return geometry;
}

/**
 * Graybox rendering. A room is a floor slab plus thick walls, with no ceiling, so you see in from above.
 * A volume is a solid block. Both cast and receive shadows and have faint outlined edges.
 */
export function BoxMesh({ kind, x, z, y, width, depth, height, rotation, color, draft = false, highlight }: Props) {
  // UV offset: see applyBoxUVs.
  const [ox, oz] = rotation === 0 ? [x, z] : [width / 2, depth / 2];

  const solid = useMemo(() => {
    if (kind === "volume") {
      const g = new THREE.BoxGeometry(width, height, depth);
      g.translate(0, height / 2, 0);
      return applyBoxUVs(g, ox, y, oz);
    }
    return applyBoxUVs(wallGeometry(width, depth, height), ox, y, oz);
  }, [kind, ox, y, oz, width, depth, height]);

  const floor = useMemo(() => {
    if (kind !== "room") return null;
    const g = new THREE.BoxGeometry(width, FLOOR_THICKNESS, depth);
    g.translate(0, FLOOR_THICKNESS / 2, 0);
    return applyBoxUVs(g, ox, y, oz);
  }, [kind, ox, y, oz, width, depth]);

  const edges = useMemo(() => new THREE.EdgesGeometry(solid, 15), [solid]);

  useEffect(() => () => solid.dispose(), [solid]);
  useEffect(() => () => floor?.dispose(), [floor]);
  useEffect(() => () => edges.dispose(), [edges]);

  const s = getShared();
  const c = colorMaterials(color);
  const sel = highlight === "selected";
  const bodyMaterial = draft ? s.draft : sel ? c.bodySelected : c.body;
  const floorMaterial = draft ? s.draft : sel ? c.floorSelected : c.floor;
  const edgeMaterial = draft ? s.draftEdge : sel ? s.edgeSelected : highlight === "hover" ? s.edgeHover : s.edge;

  return (
    <group position={[x, y, z]} rotation={[0, (rotation * Math.PI) / 180, 0]}>
      <mesh geometry={solid} material={bodyMaterial} castShadow={!draft} receiveShadow={!draft} />
      {floor && <mesh geometry={floor} material={floorMaterial} receiveShadow={!draft} />}
      <lineSegments geometry={edges} material={edgeMaterial} renderOrder={1} />
    </group>
  );
}

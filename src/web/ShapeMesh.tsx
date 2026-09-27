import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { isFootprinted, localFootprint, pointInPolygon, roomWalls, shapeFrame, signedArea2, type Point } from "../shared/geometry";
import { PALETTE, WALL_THICKNESS, type Shape, type ShapeColor } from "../shared/scene.types";

type Props = {
  shape: Shape;
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
/** Hover (what a click would select): a yellow tint, the same kind of overlay as the selection's blue. */
const HOVER_COLOR = "#f5c518";

// Graybox materials: matte, tiled every meter, in the box's palette color. Shared per color, made on first use.
let shared: ReturnType<typeof createShared> | null = null;
function createShared() {
  return {
    tiles: tileTexture(),
    edge: new THREE.LineBasicMaterial({ color: "#8a857b", transparent: true, opacity: 0.3 }),
    edgeHover: new THREE.LineBasicMaterial({ color: HOVER_COLOR }),
    edgeSelected: new THREE.LineBasicMaterial({ color: SELECT_COLOR }),
    draft: new THREE.MeshLambertMaterial({ color: "#3d7be0", transparent: true, opacity: 0.35, depthWrite: false }),
    draftEdge: new THREE.LineBasicMaterial({ color: "#3d7be0" }),
  };
}
const getShared = () => (shared ??= createShared());

type ColorMaterials = Record<
  "body" | "floor" | "bodySelected" | "floorSelected" | "bodyHover" | "floorHover",
  THREE.MeshLambertMaterial
>;
const byColor = new Map<ShapeColor, ColorMaterials>();
function colorMaterials(color: ShapeColor): ColorMaterials {
  let m = byColor.get(color);
  if (m) return m;
  const map = getShared().tiles;
  const body = new THREE.MeshLambertMaterial({ color: PALETTE[color], map });
  const floor = new THREE.MeshLambertMaterial({ color: new THREE.Color(PALETTE[color]).multiplyScalar(FLOOR_SHADE), map });
  // Selected and hovered: the same materials with a faint glow (blue, or yellow a bit stronger to read as much).
  const tinted = (base: THREE.MeshLambertMaterial, color: string, intensity: number) => {
    const c = base.clone();
    c.emissive.set(color);
    c.emissiveIntensity = intensity;
    return c;
  };
  m = {
    body,
    floor,
    bodySelected: tinted(body, SELECT_COLOR, 0.22),
    floorSelected: tinted(floor, SELECT_COLOR, 0.22),
    bodyHover: tinted(body, HOVER_COLOR, 0.3),
    floorHover: tinted(floor, HOVER_COLOR, 0.3),
  };
  byColor.set(color, m);
  return m;
}

/**
 * Shape-aligned UVs (1 unit = 1 m), picked per face from its dominant normal axis in the shape's own frame, so
 * tiles follow its edges. `ox, oy, oz` offsets them (see `uvOffset`).
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

/** A ring on the ground as a three.js outline: drawn in x / -z, then rotated so the extrusion points up (+y). */
const flat = (points: Point[]) => points.map((p) => new THREE.Vector2(p.x, -p.z));

/**
 * A region on the ground (in the shape's frame), given as rings, extruded from 0 up to `height`, as one mesh with
 * clean edges (no seams at the corners). Rings wound like the first one are solid, the others are holes in the
 * solid ring around them.
 */
function extrude(rings: Point[][], height: number) {
  const solid = Math.sign(signedArea2(rings[0]));
  const shapes = rings.filter((r) => Math.sign(signedArea2(r)) === solid).map((r) => ({ ring: r, shape: new THREE.Shape(flat(r)) }));
  for (const hole of rings.filter((r) => Math.sign(signedArea2(r)) !== solid)) {
    const around = shapes.find((s) => pointInPolygon(s.ring, hole[0])) ?? shapes[0];
    around.shape.holes.push(new THREE.Path(flat(hole)));
  }
  const geometry = new THREE.ExtrudeGeometry(
    shapes.map((s) => s.shape),
    { depth: height, bevelEnabled: false },
  );
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * Curved walls are many flat facets: faces that meet at less than this angle share their normals, so a round
 * tower or a curved cave wall lights as round, while a box's (or a hexagon's) corners stay sharp.
 */
const CREASE = (30 * Math.PI) / 180;

/**
 * The UV offset: the frame's world position for an unrotated shape (its tiles line up with the ground grid and
 * with other shapes), its half size for a rotated one (tiles start at a corner). A free-form's frame is the
 * world's, so its tiles always line up with the grid.
 */
function uvOffset(shape: Shape): [number, number] {
  if (!isFootprinted(shape)) return [0, 0];
  return shape.rotation === 0 ? [shape.x, shape.z] : [shape.width / 2, shape.depth / 2];
}

/**
 * Graybox rendering of a closed shape, from its footprint polygon. A room is a floor slab plus thick walls (the
 * region between the footprint grown and shrunk by half the wall thickness), with no ceiling, so you see in from
 * above. A volume is the footprint extruded to its height. Both cast and receive shadows and have faint outlined
 * edges.
 */
export function ShapeMesh({ shape, draft = false, highlight }: Props) {
  const { kind, y, height, color } = shape;
  const frame = shapeFrame(shape);
  const outline = localFootprint(shape);
  const [ox, oz] = uvOffset(shape);
  // Geometry is rebuilt only when what it's made from changes (the outline is a new array every render).
  const key = JSON.stringify([kind, outline, height, ox, y, oz]);

  // An outline with no area (a stored shape is never one, but a preview can be) has no walls or body: nothing to draw.
  const empty = Math.abs(signedArea2(outline)) < 1e-9;
  const solid = useMemo(() => {
    if (empty) return null;
    // Rooms too narrow to have an inside come out as solid blocks (no inner ring).
    const rings = kind === "volume" ? [outline] : roomWalls(shape, WALL_THICKNESS / 2).walls;
    if (rings.length === 0) return null;
    // UVs pick their plane from the flat normals, so they come first.
    return toCreasedNormals(applyBoxUVs(extrude(rings, height), ox, y, oz), CREASE);
  }, [key]);

  const floor = useMemo(
    () => (kind === "room" && !empty ? applyBoxUVs(extrude([outline], FLOOR_THICKNESS), ox, y, oz) : null),
    [key],
  );

  const edges = useMemo(() => (solid ? new THREE.EdgesGeometry(solid, 15) : null), [solid]);

  useEffect(() => () => solid?.dispose(), [solid]);
  useEffect(() => () => floor?.dispose(), [floor]);
  useEffect(() => () => edges?.dispose(), [edges]);

  const s = getShared();
  const c = colorMaterials(color);
  const sel = highlight === "selected";
  const hover = highlight === "hover";
  const bodyMaterial = draft ? s.draft : sel ? c.bodySelected : hover ? c.bodyHover : c.body;
  const floorMaterial = draft ? s.draft : sel ? c.floorSelected : hover ? c.floorHover : c.floor;
  const edgeMaterial = draft ? s.draftEdge : sel ? s.edgeSelected : hover ? s.edgeHover : s.edge;

  return (
    <group position={[frame.x, y, frame.z]} rotation={[0, (frame.rotation * Math.PI) / 180, 0]}>
      {solid && <mesh geometry={solid} material={bodyMaterial} castShadow={!draft} receiveShadow={!draft} />}
      {floor && <mesh geometry={floor} material={floorMaterial} receiveShadow={!draft} />}
      {edges && <lineSegments geometry={edges} material={edgeMaterial} renderOrder={1} />}
    </group>
  );
}

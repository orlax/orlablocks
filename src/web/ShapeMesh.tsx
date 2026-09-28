import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { isFootprinted, localFootprint, shapeFrame, wallOf } from "../shared/geometry";
import { cutsFloor } from "../shared/holes";
import { shapeMesh, type Mesh } from "../shared/mesh";
import { PALETTE, type ClosedShape, type ShapeColor, type Solid } from "../shared/scene.types";
import { holeInFrameOf, subtract, useManifold } from "./csg";
import { VIEW_ACCENT } from "../ui/viewColors";

type Props = {
  shape: Solid;
  /** The live preview while drawing: translucent blue, so it reads as not-yet-placed. */
  draft?: boolean;
  highlight?: "hover" | "selected";
  /** The holes that cut this shape (see `cutters`): its mesh is drawn minus them. */
  cuts?: ClosedShape[];
  /** Whether the Walk tool's floor-follow can stand on it (09.2; not the walker's own avatar). Holes and drafts never. */
  walkable?: boolean;
};

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

export const SELECT_COLOR = VIEW_ACCENT;
/** Hover (what a click would select): a yellow tint, the same kind of overlay as the selection's blue. */
export const HOVER_COLOR = "#f5c518";

// Graybox materials: matte, tiled every meter, in the box's palette color. Shared per color, made on first use.
let shared: ReturnType<typeof createShared> | null = null;
function createShared() {
  return {
    tiles: tileTexture(),
    edge: new THREE.LineBasicMaterial({ color: "#8a857b", transparent: true, opacity: 0.3 }),
    edgeHover: new THREE.LineBasicMaterial({ color: HOVER_COLOR }),
    edgeSelected: new THREE.LineBasicMaterial({ color: SELECT_COLOR }),
    draft: new THREE.MeshLambertMaterial({ color: VIEW_ACCENT, transparent: true, opacity: 0.35, depthWrite: false }),
    draftEdge: new THREE.LineBasicMaterial({ color: VIEW_ACCENT }),
    // A hole's dashed outline, and its highlights.
    holeEdge: new THREE.LineDashedMaterial({ color: "#5d5c5a", dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.8 }),
    holeEdgeHover: new THREE.LineDashedMaterial({ color: HOVER_COLOR, dashSize: 0.18, gapSize: 0.12 }),
    holeEdgeSelected: new THREE.LineDashedMaterial({ color: SELECT_COLOR, dashSize: 0.18, gapSize: 0.12 }),
  };
}

/** A hole is a ghost: translucent in its color (a bit stronger when hovered or selected), casting no shadow. */
const ghosts = new Map<string, THREE.MeshLambertMaterial>();
function ghostMaterial(color: ShapeColor, highlight: "hover" | "selected" | undefined) {
  const k = `${color}:${highlight ?? ""}`;
  let m = ghosts.get(k);
  if (!m) {
    const tint = highlight === "selected" ? SELECT_COLOR : highlight === "hover" ? HOVER_COLOR : PALETTE[color];
    m = new THREE.MeshLambertMaterial({ color: tint, transparent: true, opacity: highlight ? 0.3 : 0.18, depthWrite: false });
    ghosts.set(k, m);
  }
  return m;
}
export const getShared = () => (shared ??= createShared());

type ColorMaterials = Record<
  "body" | "floor" | "bodySelected" | "floorSelected" | "bodyHover" | "floorHover",
  THREE.MeshLambertMaterial
>;
const byColor = new Map<ShapeColor, ColorMaterials>();
export function colorMaterials(color: ShapeColor): ColorMaterials {
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

/** A shared mesh as three.js geometry, unshared per face (so each face gets its own flat normal, for the UVs). */
function toGeometry(mesh: Mesh) {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
  indexed.setIndex(mesh.indices);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
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
function uvOffset(shape: Solid): [number, number] {
  if (!isFootprinted(shape)) return [0, 0];
  return shape.rotation === 0 ? [shape.x, shape.z] : [shape.width / 2, shape.depth / 2];
}

/**
 * Graybox rendering of a closed shape, from its meshes (`shapeMesh`), minus the holes that cut it. A room is a floor
 * slab plus thick walls (the region between the footprint and the footprint shrunk by the wall thickness), with no
 * ceiling, so you see in from above. A volume is the footprint extruded to its height. Both cast and receive shadows
 * and have faint outlined edges. A hole is a translucent ghost with dashed edges.
 */
export function ShapeMesh({ shape, draft = false, highlight, cuts, walkable = true }: Props) {
  const { kind, color } = shape;
  const { solid, floor, edges, frame, y, height, tilt } = useShapeGeometry(shape, cuts);
  const hole = kind === "hole" && !draft;

  const s = getShared();
  const c = colorMaterials(color);
  const sel = highlight === "selected";
  const hover = highlight === "hover";
  const bodyMaterial = draft ? s.draft : hole ? ghostMaterial(color, highlight) : sel ? c.bodySelected : hover ? c.bodyHover : c.body;
  const floorMaterial = draft ? s.draft : sel ? c.floorSelected : hover ? c.floorHover : c.floor;
  const edgeMaterial = draft
    ? s.draftEdge
    : hole
      ? sel
        ? s.holeEdgeSelected
        : hover
          ? s.holeEdgeHover
          : s.holeEdge
      : sel
        ? s.edgeSelected
        : hover
          ? s.edgeHover
          : s.edge;

  // Turned around the vertical, then (inside) tilted around the shape's center: roll, then pitch (see `toWorld3`).
  const deg = Math.PI / 180;
  const turn = new THREE.Euler(tilt[0] * deg, frame.rotation * deg, tilt[1] * deg, "YXZ");
  return (
    <group position={[frame.x, y + height / 2, frame.z]} rotation={turn}>
      <group position={[0, -height / 2, 0]}>
        {solid && (
          <mesh
            geometry={solid}
            material={bodyMaterial}
            castShadow={!draft && !hole}
            receiveShadow={!draft && !hole}
            renderOrder={hole ? 2 : 0}
            userData={{ walkable: walkable && !draft && !hole }}
          />
        )}
        {floor && <mesh geometry={floor} material={floorMaterial} receiveShadow={!draft} userData={{ walkable: walkable && !draft }} />}
        {edges && (
          <lineSegments
            key={hole ? "dashed" : "solid"}
            geometry={edges}
            material={edgeMaterial}
            renderOrder={hole ? 3 : 1}
            // Dashes need each segment's distance along the line.
            onUpdate={(l: THREE.LineSegments) => hole && l.computeLineDistances()}
          />
        )}
      </group>
    </group>
  );
}

/**
 * Where a shape's geometry sits (`useShapeGeometry` builds it in the shape's own frame, from its bottom): turned
 * around the vertical, tilted around its center, as ShapeMesh places it. The instanced arrays (10.5) multiply it by
 * each item's place.
 */
export function shapeMatrix(shape: Solid): THREE.Matrix4 {
  const { y, height } = shape.type === "ramp" ? { y: 0, height: 0 } : shape;
  const frame = shape.type === "ramp" ? { x: 0, z: 0, rotation: 0 } : shapeFrame(shape);
  const tilt = shape.type === "ramp" ? [0, 0] : [shape.pitch ?? 0, shape.roll ?? 0];
  const deg = Math.PI / 180;
  const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt[0] * deg, frame.rotation * deg, tilt[1] * deg, "YXZ"));
  const outer = new THREE.Matrix4().compose(new THREE.Vector3(frame.x, y + height / 2, frame.z), turn, new THREE.Vector3(1, 1, 1));
  return outer.multiply(new THREE.Matrix4().makeTranslation(0, -height / 2, 0));
}

/**
 * A shape's three.js geometry (its body, a room's floor, the body's edges), in its own frame from its bottom, minus
 * the holes that cut it: rebuilt only when what it's made from changes, and cut again when a hole that cuts it
 * changes. Disposed when replaced. ShapeMesh draws it; the instanced arrays (10.5) draw one per entity part.
 */
export function useShapeGeometry(shape: Solid, cuts?: ClosedShape[]) {
  const { kind } = shape;
  // A ramp's mesh is in world coordinates (its frame is the world's, at height 0).
  const { y, height } = shape.type === "ramp" ? { y: 0, height: 0 } : shape;
  const frame = shape.type === "ramp" ? { x: 0, z: 0, rotation: 0 } : shapeFrame(shape);
  const [ox, oz] = uvOffset(shape);
  const ready = useManifold();
  // Geometry is rebuilt only when what it's made from changes (the shape is a new object every render), and cut
  // again when a hole that cuts it changes (its position, the target's tilt and turn included).
  const key =
    shape.type === "ramp"
      ? JSON.stringify([kind, shape.points, shape.width, shape.step, shape.base])
      : JSON.stringify([kind, localFootprint(shape), height, ox, y, oz, kind === "room" ? wallOf(shape) : 0, shape.taper, shape.bevel]);
  const tilt = shape.type === "ramp" ? [0, 0] : [shape.pitch ?? 0, shape.roll ?? 0];
  const cutKey = cuts && cuts.length > 0 && ready ? JSON.stringify([cuts, frame, tilt]) : "";

  // An outline with no area (a stored shape is never one, but a preview can be) has no meshes: nothing to draw.
  // Rooms too narrow to have an inside come out as solid blocks (walls with no inner ring).
  const parts = useMemo(() => {
    const p = shapeMesh(shape);
    if (!cutKey || !cuts) return p;
    const holes = cuts.map((h) => ({ hole: h, mesh: holeInFrameOf(shape, h) })).filter((h): h is { hole: ClosedShape; mesh: Mesh } => h.mesh !== null);
    const floorHoles = shape.type === "ramp" ? [] : holes.filter((h) => cutsFloor(h.hole, shape)).map((h) => h.mesh);
    return {
      body: p.body && subtract(p.body, holes.map((h) => h.mesh)),
      floor: p.floor && (floorHoles.length > 0 ? subtract(p.floor, floorHoles) : p.floor),
    };
  }, [key, cutKey]);
  // UVs pick their plane from the flat normals, so they come first.
  const solid = useMemo(() => (parts.body ? toCreasedNormals(applyBoxUVs(toGeometry(parts.body), ox, y, oz), CREASE) : null), [parts]);
  const floor = useMemo(() => (parts.floor ? applyBoxUVs(toGeometry(parts.floor), ox, y, oz) : null), [parts]);

  const edges = useMemo(() => (solid ? new THREE.EdgesGeometry(solid, 15) : null), [solid]);

  useEffect(() => () => solid?.dispose(), [solid]);
  useEffect(() => () => floor?.dispose(), [floor]);
  useEffect(() => () => edges?.dispose(), [edges]);
  return { solid, floor, edges, frame, y, height, tilt };
}

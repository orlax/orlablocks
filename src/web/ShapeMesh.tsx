import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { meshFrame, shapeGeometryKey } from "./geometryWork";
import { useGeometryBuffers, usePreparedGeometry } from "./usePreparedGeometry";
import { boundsOf } from "../shared/geometry";
import { PALETTE, type ClosedShape, type ShapeColor, type Solid } from "../shared/scene.types";
import { useManifold } from "./csg";
import { VIEW_ACCENT } from "../ui/viewColors";

type Props = {
  authoring?: boolean;
  /** Localized hover over an instanced part; draw above its unchanged batched body. */
  overlay?: boolean;
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

const unitBox = new THREE.BoxGeometry();
const previewEdges = new THREE.EdgesGeometry(unitBox);
unitBox.dispose();

function PendingOutline({ shape }: { shape: Solid }) {
  const b = useMemo(() => boundsOf([shape]), [shape]);
  if (!Number.isFinite(b.minX + b.minY + b.minZ)) return null;
  return <lineSegments
    geometry={previewEdges}
    material={getShared().draftEdge}
    position={[(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2]}
    scale={[b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ]}
    renderOrder={3}
  />;
}

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
 * Graybox rendering of a closed shape, from its meshes (`shapeMesh`), minus the holes that cut it. A room is a floor
 * slab plus thick walls (the region between the footprint and the footprint shrunk by the wall thickness), with no
 * ceiling, so you see in from above. A volume is the footprint extruded to its height. Both cast and receive shadows
 * and have faint outlined edges. A hole is a translucent ghost with dashed edges.
 */
export const ShapeMesh = memo(function ShapeMesh({ shape, draft = false, highlight, cuts, walkable = true, authoring = false, overlay = false }: Props) {
  const { kind, color } = shape;
  const { solid, floor, edges, frame, y, height, tilt, pending } = useShapeGeometry(shape, cuts, !draft);
  const hole = (kind === "hole" || authoring) && !draft;

  const s = getShared();
  const c = colorMaterials(color);
  const sel = highlight === "selected";
  const hover = highlight === "hover";
  const bodyMaterial = draft ? s.draft : hole ? ghostMaterial(color, highlight) : sel ? c.bodySelected : hover ? c.bodyHover : c.body;
  const floorMaterial = draft ? s.draft : sel ? c.floorSelected : hover ? c.floorHover : c.floor;
  const edgeMaterial = draft || pending
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

  const overlayMaterials = useMemo(() => overlay ? [bodyMaterial, floorMaterial].map((m) => {
    const copy = m.clone();
    copy.depthWrite = false;
    copy.polygonOffset = true;
    copy.polygonOffsetFactor = -1;
    copy.polygonOffsetUnits = -1;
    return copy;
  }) : null, [overlay, bodyMaterial, floorMaterial]);
  useEffect(() => () => overlayMaterials?.forEach((m) => m.dispose()), [overlayMaterials]);

  // Turned around the vertical, then (inside) tilted around the shape's center: roll, then pitch (see `toWorld3`).
  const deg = Math.PI / 180;
  const turn = new THREE.Euler(tilt[0] * deg, frame.rotation * deg, tilt[1] * deg, "YXZ");
  if (pending && !solid && !floor && highlight) return <PendingOutline shape={shape} />;
  return (
    <group position={[frame.x, y + height / 2, frame.z]} rotation={turn}>
      <group position={[0, -height / 2, 0]}>
        {solid && (
          <mesh
            geometry={solid}
            material={overlayMaterials?.[0] ?? bodyMaterial}
            castShadow={!overlay && !draft && !hole}
            receiveShadow={!draft && !hole}
            renderOrder={overlay ? 2 : hole ? 2 : 0}
            userData={{ walkable: !pending && !overlay && walkable && !draft && !hole }}
          />
        )}
        {floor && <mesh geometry={floor} material={overlayMaterials?.[1] ?? floorMaterial} renderOrder={overlay ? 2 : 0} receiveShadow={!draft} userData={{ walkable: !pending && !overlay && walkable && !draft }} />}
        {edges && (
          <lineSegments
            key={hole ? "dashed" : "solid"}
            geometry={edges}
            material={edgeMaterial}
            renderOrder={overlay ? 3 : hole ? 3 : 1}
            // Dashes need each segment's distance along the line.
            onUpdate={(l: THREE.LineSegments) => hole && l.computeLineDistances()}
          />
        )}
      </group>
    </group>
  );
});

export { shapeMatrix } from "./geometryWork";

/** Exact local geometry, with the last committed mesh available while a newer worker preview is pending. */
export function useShapeGeometry(shape: Solid, cuts?: ClosedShape[], allowWorker = true) {
  const hasCuts = !!cuts?.length;
  const manifold = useManifold(hasCuts);
  const uncutKey = shapeGeometryKey(shape);
  const key = hasCuts ? shapeGeometryKey(shape, cuts) : uncutKey;
  const expensive = hasCuts || shape.type === "freeform" || shape.type === "ramp"
    || (shape.type === "cylinder" && (!!shape.bevel || !!shape.taper));
  const { data, previous, pending } = usePreparedGeometry(
    `shape:${key}`, { kind: "shape", shape, cuts }, allowWorker && expensive,
    `shape:${manifold ? key : uncutKey}`, { kind: "shape", shape, cuts: manifold ? cuts : undefined },
    allowWorker,
  );
  const buffers = useGeometryBuffers(data ?? previous);
  return { ...buffers, ...meshFrame(shape), pending };
}

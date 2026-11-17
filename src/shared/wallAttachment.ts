import { cutParts, manifoldLoaded } from "./csg";
import { expandNodes } from "./entities";
import { cutters, isHole } from "./holes";
import { rayMeshFirst } from "./ray";
import { hiddenIds } from "./tree";
import { toLocal3, round2 } from "./geometry";
import { DEFAULT_WALL, type Cylinder, type Instance, type PolarPlacement, type SceneNode, type WallAttachment } from "./scene.types";

export const wallAngle = (n: number) => round2(((n % 360) + 360) % 360) % 360;
type Pose = Pick<Instance, "x" | "y" | "z" | "rotation">;
type Result<T> = T | { problem: string };

function cylinder(nodes: SceneNode[], id: string, room: boolean): Result<Cylinder> {
  const n = nodes.find((n) => n.id === id);
  if (!n) return { problem: `support ${id} is missing; repair the reference or detach` };
  if (n.type !== "cylinder" || n.sides !== undefined || n.width !== n.depth || n.pitch || n.roll || (room && n.kind !== "room"))
    return { problem: `${id} must be an upright smooth circular ${room ? "room " : ""}cylinder` };
  return n;
}

export function polarPose(nodes: SceneNode[], p: PolarPlacement): Result<Pose> {
  const target = cylinder(nodes, p.around, false);
  if ("problem" in target) return target;
  const angle = p.angle + target.rotation, radians = angle * Math.PI / 180;
  return { x: round2(target.x + p.radius * Math.cos(radians)), z: round2(target.z - p.radius * Math.sin(radians)),
    y: round2(target.y + (p.elevation ?? 0)), rotation: wallAngle(angle + (p.facing === "in" ? 180 : p.facing === "tangent" ? 90 : 0) + (p.rotationOffset ?? 0)) };
}

export function wallPose(nodes: SceneNode[], a: WallAttachment): Result<Pose> {
  const target = cylinder(nodes, a.id, true);
  if ("problem" in target) return target;
  if (a.elevation < 0 || a.elevation > target.height) return { problem: `mount elevation must be within ${a.id}'s wall (0..${target.height} m)` };
  const local = ((a.angle % 360) + 360) % 360;
  if (target.arc && target.arc.sweep < 360 && ((local - target.arc.from) % 360 + 360) % 360 > target.arc.sweep + 1e-8)
    return { problem: `mount angle is outside ${a.id}'s supported arc` };
  const inner = Math.max(0, target.width / 2 - (target.wall ?? DEFAULT_WALL));
  if (a.side === "inner" && inner <= 0) return { problem: `${a.id} has no inner wall surface` };
  const radius = (a.side === "inner" ? inner - a.offset : target.width / 2 + a.offset);
  if (radius <= 0) return { problem: "mount normal offset crosses the cylinder center" };
  return polarPose(nodes, { around: a.id, radius, angle: a.angle, elevation: a.elevation,
    facing: a.side === "inner" ? "in" : "out", rotationOffset: a.facingOffset });
}

/** Convert an explicit world-pose edit into mount parameters. No silent unlinking. */
export function wallFromPose(nodes: SceneNode[], a: WallAttachment, pose: Instance): Result<WallAttachment> {
  const target = cylinder(nodes, a.id, true);
  if ("problem" in target) return target;
  if (pose.pitch || pose.roll) return { problem: "a wall mount must remain upright; detach before tilting" };
  const dx = pose.x - target.x, dz = pose.z - target.z;
  if (Math.hypot(dx, dz) < 0.005) return { problem: "a mount at the cylinder center has no angle; detach first" };
  const angle = wallAngle(Math.atan2(-dz, dx) * 180 / Math.PI - target.rotation);
  const surface = a.side === "inner" ? Math.max(0, target.width / 2 - (target.wall ?? DEFAULT_WALL)) : target.width / 2;
  const next = { ...a, angle, elevation: round2(pose.y - target.y), offset: round2((Math.hypot(dx, dz) - surface) * (a.side === "inner" ? -1 : 1)),
    facingOffset: wallAngle(pose.rotation - target.rotation - angle - (a.side === "inner" ? 180 : 0)) };
  const result = wallPose(nodes, next);
  return "problem" in result ? result : next;
}

/** Support diagnostic shared by inspector and lint; relation alone never exempts a floating instance. */
export function wallSupportProblem(nodes: SceneNode[], n: Instance): string | null {
  if (!n.wallAttachment) return null;
  if (n.on) return "wall attachment conflicts with floor on placement";
  if (n.pitch || n.roll) return "wall attachment is tilted; detach before tilting";
  const pose = wallPose(nodes, n.wallAttachment);
  if ("problem" in pose) return pose.problem;
  if (Math.abs(n.wallAttachment.offset) > 0.5) return "mount is more than 0.5 m from its wall surface; reduce offset or detach";
  const surfaceProblem = wallSurfaceProblem(nodes, n.wallAttachment);
  if (surfaceProblem) return surfaceProblem;
  if (Math.hypot(n.x - pose.x, n.y - pose.y, n.z - pose.z) > 0.02 || Math.abs(wallAngle(n.rotation - pose.rotation + 180) - 180) > 0.02)
    return "mount pose is out of date with its support";
  return null;
}

/** Check the surface at the mounting pivot, independent of its cached world pose. */
export function wallSurfaceProblem(nodes: SceneNode[], attachment: WallAttachment): string | null {
  const pose = wallPose(nodes, attachment);
  if ("problem" in pose) return pose.problem;
  // Test the actual cut wall when cutters are present. A tag alone does not establish contact.
  const target = nodes.find((t) => t.id === attachment.id) as Cylinder;
  if (!target.cutTags?.length) return null;
  const hidden = hiddenIds(nodes);
  const holes = cutters(expandNodes(nodes.filter((t) => !(isHole(t) && hidden.has(t.id))))).get(target.id);
  if (holes?.length) {
    if (!manifoldLoaded()) return "wall support cannot be verified until the geometry engine loads";
    const body = cutParts(target, holes).body;
    if (!body) return "the supporting wall has been cut away";
    const surface = wallPose(nodes, { ...attachment, offset: 0 });
    if (!("problem" in surface)) {
      const angle = (attachment.angle + target.rotation) * Math.PI / 180;
      const sign = attachment.side === "inner" ? -1 : 1;
      const normal = { x: sign * Math.cos(angle), y: 0, z: -sign * Math.sin(angle) };
      const margin = attachment.side === "inner" ? Math.min(1, (target.width / 2 - (target.wall ?? DEFAULT_WALL)) / 2) : 1;
      const origin = toLocal3(target, { x: surface.x + normal.x * margin, y: surface.y, z: surface.z + normal.z * margin });
      const end = toLocal3(target, { x: surface.x, y: surface.y, z: surface.z });
      const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < body.positions.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis], body.positions[i]); max[axis] = Math.max(max[axis], body.positions[i]); }
      const hit = rayMeshFirst({ origin, dir: { x: end.x - origin.x, y: end.y - origin.y, z: end.z - origin.z } }, { ...body, min, max });
      // Smooth circles render as chords: allow their sagitta, plus position rounding.
      const tolerance = 0.02 + target.width / 2 * (1 - Math.cos(Math.PI / 32));
      if (!hit || Math.abs(hit.t - 1) > tolerance / margin) return "no wall surface supports the mount pivot (an opening may cut it away)";
    }
  }
  return null;
}

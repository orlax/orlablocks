import type { Line, Shape } from "../shared/scene.types";
import { polyline } from "../shared/geometry";
import { worldToScreen, type CameraState, type Size, type Vec3 } from "./camera";

// Picking with rays moved to src/shared/ray.ts (plan 13 §7); the editor imports it from here as before.
export { pickHit, pickShape, rayMesh, surfaceUnder, type Surface } from "../shared/ray";

/** How close (px) to a line's path on screen a click picks it: more for a thick line. */
export const lineHitPx = (line: Line) => Math.max(6, line.thickness / 2 + 4);

/**
 * The line nearest the cursor on screen, within its hit distance, and the point on it nearest the cursor (in 3D,
 * interpolated along the segment). Lines are drawn over the shapes, so the view checks them first.
 */
export function pickLine(cam: CameraState, size: Size, sx: number, sy: number, shapes: Shape[]): { id: string; point: Vec3 } | null {
  let best: { id: string; point: Vec3; d: number } | null = null;
  for (const line of shapes) {
    if (line.type !== "line") continue;
    const path = polyline(line);
    const screen = path.map((p) => worldToScreen(cam, size, p));
    for (let i = 0; i + 1 < path.length; i++) {
      const a = screen[i];
      const b = screen[i + 1];
      if (!a || !b) continue;
      const dx = b.sx - a.sx;
      const dy = b.sy - a.sy;
      const len2 = dx * dx + dy * dy;
      const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((sx - a.sx) * dx + (sy - a.sy) * dy) / len2));
      const d = Math.hypot(sx - (a.sx + dx * u), sy - (a.sy + dy * u));
      if (d <= lineHitPx(line) && (!best || d < best.d)) {
        const [p, q] = [path[i], path[i + 1]];
        best = { id: line.id, point: { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, z: p.z + (q.z - p.z) * u }, d };
      }
    }
  }
  return best && { id: best.id, point: best.point };
}

/**
 * A note's pin on screen (from 08): a pole standing on its point, with a flag (or, without a label, a round head)
 * at the top, at a constant size in pixels whatever the zoom. `noteRect` is the area a click picks it in.
 */
export const NOTE_PX = { pole: 30, flagW: 34, flagH: 20, head: 11 } as const;
export function noteRect(anchor: { sx: number; sy: number }, labeled: boolean): { x0: number; y0: number; x1: number; y1: number } {
  const top = anchor.sy - NOTE_PX.pole - (labeled ? NOTE_PX.flagH / 2 : NOTE_PX.head / 2);
  const right = anchor.sx + (labeled ? NOTE_PX.flagW : NOTE_PX.head / 2);
  return { x0: anchor.sx - NOTE_PX.head / 2 - 2, y0: top - 2, x1: right + 2, y1: anchor.sy + 3 };
}

/**
 * The note whose pin is under the cursor (the nearest one, when pins overlap), with its point. Pins are drawn over
 * everything, so the view checks them first.
 */
export function pickNote(cam: CameraState, size: Size, sx: number, sy: number, shapes: Shape[]): { id: string; point: Vec3 } | null {
  let best: { id: string; point: Vec3; d: number } | null = null;
  for (const note of shapes) {
    if (note.type !== "note") continue;
    const at = worldToScreen(cam, size, note);
    if (!at) continue;
    const r = noteRect(at, !!note.label);
    if (sx < r.x0 || sx > r.x1 || sy < r.y0 || sy > r.y1) continue;
    const d = Math.hypot(sx - at.sx, sy - (at.sy - NOTE_PX.pole));
    if (!best || d < best.d) best = { id: note.id, point: { x: note.x, y: note.y, z: note.z }, d };
  }
  return best && { id: best.id, point: best.point };
}


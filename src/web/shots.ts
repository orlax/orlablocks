import { MAX_SHOT_SIZE } from "../shared/scene.types";

/** Shots in the editor (plan 09 §4): the pure parts, tested in `shots.test.ts`. */

/** A size scaled down so its long edge is at most `max` pixels (never up), in whole pixels. */
export function fitSize(width: number, height: number, max = MAX_SHOT_SIZE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A shot's file name: its ID and caption, safe for any file system. */
export function shotFileName(shot: { id: string; caption?: string }): string {
  const caption = (shot.caption ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return `${shot.id}${caption ? ` ${caption}` : ""}.png`;
}

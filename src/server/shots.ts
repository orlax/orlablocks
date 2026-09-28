import fs from "node:fs";
import { MAX_SHOT_CAPTION, type ShotCamera, type ShotRecord, type ShotView } from "../shared/scene.types";
import type { ShotsFile } from "../shared/project.types";
import type { DataDir, DocumentRef } from "./persist";
import { SceneError } from "./scene";

/**
 * The open document's shots (plan 09 §4): captures of the view, each kept with the camera that took it. Not scene
 * edits: no history, and a deleted shot is gone. Saved as they're taken, in the document's `shots/` folder.
 */

/** The largest image accepted, in bytes (a 4096 px capture is well under this). */
export const MAX_SHOT_BYTES = 40 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's size from its header, or null if the bytes aren't a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || PNG_SIGNATURE.some((b, i) => png[i] !== b) || png.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Where the editor loads a shot's image from (served by the HTTP route in `main.ts`). */
export const shotUrl = (project: string, doc: DocumentRef, id: string) =>
  `/shots/${project}/${doc.kind === "scene" ? "scenes" : "entities"}/${doc.id}/${id}.png`;

export type NewShot = { camera: ShotCamera; caption?: string; image: string };

export function createShotStore(data: DataDir) {
  let open: { project: string; doc: DocumentRef } | null = null;
  let file: ShotsFile = { nextId: 1, shots: [] };
  // A shots.json that didn't load: the document's shots can't be changed (and the file isn't written over).
  let broken: string | null = null;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((l) => l());

  const requireOpen = (failure: string) => {
    if (!open) throw new SceneError(`${failure}\nNo scene is open.`);
    if (broken) throw new SceneError(`${failure}\nThe document's shots didn't load: ${broken}`);
    return open;
  };
  const find = (id: string, failure: string) => {
    const shot = file.shots.find((s) => s.id === id);
    if (!shot) throw new SceneError(`${failure}\nNo shot "${id}".`);
    return shot;
  };
  const cleanCaption = (caption: string | undefined) => {
    const text = (caption ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SHOT_CAPTION);
    return text ? { caption: text } : {};
  };

  return {
    /** Loads a document's shots (when it opens). A file that doesn't load leaves them read-only and empty. */
    load(project: string, doc: DocumentRef): void {
      open = { project, doc };
      broken = null;
      try {
        file = data.readShots(project, doc) ?? { nextId: 1, shots: [] };
      } catch (err) {
        broken = (err as Error).message;
        console.warn(`Ignoring the shots: ${broken}`);
        file = { nextId: 1, shots: [] };
      }
      changed();
    },

    /** The open document's shots, oldest first, with where each image is served. */
    list(): ShotView[] {
      if (!open) return [];
      const { project, doc } = open;
      return file.shots.map((s) => ({ ...s, url: shotUrl(project, doc, s.id) }));
    },

    /** A shot's image (the PNG as taken), or null if it has none. */
    image(id: string): Buffer | null {
      if (!open) return null;
      const file = data.shotImageFile(open.project, open.doc, id);
      return file ? fs.readFileSync(file) : null;
    },

    /** One shot's record, or undefined. */
    get(id: string): ShotRecord | undefined {
      return file.shots.find((s) => s.id === id);
    },

    /**
     * Saves a shot: its image (base64 PNG), and a record with a new ID and the document's history step (`seq`). The
     * size is read from the image itself. Returns the record.
     */
    add(shot: NewShot, actor: "human" | "agent", seq: number): ShotRecord {
      const failure = "The shot wasn't saved.";
      const { project, doc } = requireOpen(failure);
      const png = Buffer.from(shot.image, "base64");
      if (png.length > MAX_SHOT_BYTES) throw new SceneError(`${failure}\nThe image is over ${MAX_SHOT_BYTES / 1024 / 1024} MB.`);
      const size = pngSize(png);
      if (!size) throw new SceneError(`${failure}\nThe image isn't a PNG.`);
      const record: ShotRecord = {
        id: `shot_${file.nextId}`,
        ...cleanCaption(shot.caption),
        createdBy: actor,
        createdAt: new Date().toISOString(),
        seq,
        width: size.width,
        height: size.height,
        camera: shot.camera,
      };
      // The image first: a record never points at an image that isn't there.
      data.writeShotImage(project, doc, record.id, png);
      file = { nextId: file.nextId + 1, shots: [...file.shots, record] };
      data.writeShots(project, doc, file);
      changed();
      return record;
    },

    /** Sets (or, with an empty text, removes) a shot's caption. */
    update(id: string, caption: string): void {
      const failure = "The shot wasn't changed.";
      const { project, doc } = requireOpen(failure);
      const shot = find(id, failure);
      const { caption: _old, ...rest } = shot;
      const next: ShotRecord = { ...rest, ...cleanCaption(caption) };
      file = { ...file, shots: file.shots.map((s) => (s.id === id ? next : s)) };
      data.writeShots(project, doc, file);
      changed();
    },

    /** Deletes a shot and its image, for good. */
    remove(id: string): void {
      const failure = "The shot wasn't deleted.";
      const { project, doc } = requireOpen(failure);
      find(id, failure);
      file = { ...file, shots: file.shots.filter((s) => s.id !== id) };
      // The record first: an image without a record is only a stray file.
      data.writeShots(project, doc, file);
      data.removeShotImage(project, doc, id);
      changed();
    },

    /** When the open document's shots change, or another document's are loaded. */
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ShotStore = ReturnType<typeof createShotStore>;

import {
  BoxInputSchema,
  BoxUpdateSchema,
  DEFAULT_HEIGHT,
  DEFAULT_VIEW,
  MIN_HEIGHT,
  type Actor,
  type Box,
  type BoxInput,
  type BoxKind,
  type BoxUpdate,
  type HistorySummary,
  type Scene,
  type View,
} from "../shared/scene.types";
import { createHistory, runOps, type HistoryEntry, type Op } from "./commands";

export class SceneError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "Draw room_3", or for the agent "Agent: draw room_4, volume_2" / "Agent: draw 5 boxes". */
function drawLabel(boxes: Box[], actor: Actor): string {
  const what = boxes.length <= 3 ? boxes.map((b) => b.id).join(", ") : `${boxes.length} boxes`;
  return actor === "agent" ? `Agent: draw ${what}` : `Draw ${what}`;
}

/** "Change height of room_3", or for the agent "Agent: change height of room_4, volume_2" / "... of 5 boxes". */
function heightLabel(ids: string[], actor: Actor): string {
  const what = ids.length <= 3 ? ids.join(", ") : `${ids.length} boxes`;
  return actor === "agent" ? `Agent: change height of ${what}` : `Change height of ${what}`;
}

export function createSceneStore() {
  const scene: Scene = { view: { ...DEFAULT_VIEW }, boxes: [] };
  const listeners = new Set<(scene: Scene) => void>();
  // Per-kind counters that only go up, so IDs are never reused.
  const nextId: Record<BoxKind, number> = { room: 1, volume: 1 };

  const history = createHistory();

  const emit = () => listeners.forEach((l) => l(scene));

  /** The single path for edits: apply ops, record one undo step, broadcast. */
  const commit = (label: string, actor: Actor, ops: Op[]) => {
    const { boxes, inverse } = runOps(scene.boxes, ops);
    scene.boxes = boxes;
    history.push({ label, actor, at: Date.now(), ops, inverse });
    emit();
  };

  return {
    getScene(): Scene {
      return scene;
    },

    getHistory(): HistorySummary {
      return history.summary();
    },

    /** Validates every input first; applies all or nothing. Missing heights get the kind's default. */
    drawBoxes(inputs: BoxInput[], actor: Actor): Box[] {
      if (inputs.length === 0) throw new SceneError("boxes: at least one box is required");

      const errors: string[] = [];
      const valid = inputs.map((input, i) => {
        const result = BoxInputSchema.safeParse(input);
        if (!result.success) {
          for (const issue of result.error.issues) {
            errors.push(`boxes[${i}].${issue.path.join(".") || "(item)"}: ${issue.message}`);
          }
          return null;
        }
        const { kind, x, z, width, depth, height = DEFAULT_HEIGHT[kind] } = result.data;
        const box = { kind, x: round2(x), z: round2(z), width: round2(width), depth: round2(depth), height: round2(height) };
        if (box.width <= 0) errors.push(`boxes[${i}].width: ${width} rounds to 0 at 2 decimals`);
        if (box.depth <= 0) errors.push(`boxes[${i}].depth: ${depth} rounds to 0 at 2 decimals`);
        if (box.height < MIN_HEIGHT) errors.push(`boxes[${i}].height: ${height} rounds below ${MIN_HEIGHT} at 2 decimals`);
        return box;
      });
      if (errors.length > 0) throw new SceneError(`Nothing was drawn.\n${errors.join("\n")}`);

      const created: Box[] = valid.map((b) => ({ id: `${b!.kind}_${nextId[b!.kind]++}`, ...b!, createdBy: actor }));
      commit(drawLabel(created, actor), actor, [{ op: "add", boxes: created }]);
      return created;
    },

    /**
     * Changes existing boxes by ID (height only for now). Validates every change first; applies all or nothing.
     * Changes that don't alter anything are dropped, and if nothing is left no step is recorded.
     */
    updateBoxes(changes: BoxUpdate[], actor: Actor): Box[] {
      if (changes.length === 0) throw new SceneError("changes: at least one change is required");

      const byId = new Map(scene.boxes.map((b) => [b.id, b]));
      const seen = new Set<string>();
      const errors: string[] = [];
      const valid = changes.map((change, i) => {
        const result = BoxUpdateSchema.safeParse(change);
        if (!result.success) {
          for (const issue of result.error.issues) {
            errors.push(`changes[${i}].${issue.path.join(".") || "(item)"}: ${issue.message}`);
          }
          return null;
        }
        const { id, height } = result.data;
        if (!byId.has(id)) errors.push(`changes[${i}].id: no box "${id}"`);
        if (seen.has(id)) errors.push(`changes[${i}].id: "${id}" appears more than once`);
        seen.add(id);
        const rounded = round2(height);
        if (rounded < MIN_HEIGHT) errors.push(`changes[${i}].height: ${height} rounds below ${MIN_HEIGHT} at 2 decimals`);
        return { id, height: rounded };
      });
      if (errors.length > 0) throw new SceneError(`Nothing was changed.\n${errors.join("\n")}`);

      const effective = valid.filter((c) => byId.get(c!.id)!.height !== c!.height) as { id: string; height: number }[];
      if (effective.length > 0) {
        commit(heightLabel(effective.map((c) => c.id), actor), actor, [{ op: "update", changes: effective }]);
      }
      const ids = new Set(valid.map((c) => c!.id));
      return scene.boxes.filter((b) => ids.has(b.id));
    },

    /** What the editor currently shows (last reporting tab wins). Not an edit, so no broadcast. */
    setView(view: View): void {
      const { focus, yaw, bounds } = view;
      scene.view = {
        focus: { x: round2(focus.x), z: round2(focus.z) },
        yaw: round2(yaw),
        bounds: { x: round2(bounds.x), z: round2(bounds.z), width: round2(bounds.width), depth: round2(bounds.depth) },
      };
    },

    /** Removes every box as one undoable step. Clearing an empty scene records nothing. */
    clear(actor: Actor): void {
      if (scene.boxes.length === 0) return;
      commit("Clear", actor, [{ op: "remove", ids: scene.boxes.map((b) => b.id) }]);
    },

    /** Reverts the latest step, whoever made it. Returns it, or null if there was nothing to undo. */
    undo(): HistoryEntry | null {
      const result = history.undo(scene.boxes);
      if (!result) return null;
      scene.boxes = result.boxes;
      emit();
      return result.entry;
    },

    redo(): HistoryEntry | null {
      const result = history.redo(scene.boxes);
      if (!result) return null;
      scene.boxes = result.boxes;
      emit();
      return result.entry;
    },

    onChange(listener: (scene: Scene) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type SceneStore = ReturnType<typeof createSceneStore>;

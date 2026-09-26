import {
  BoxInputSchema,
  DEFAULT_HEIGHT,
  DEFAULT_VIEW,
  MIN_HEIGHT,
  type Actor,
  type Box,
  type BoxInput,
  type BoxKind,
  type Scene,
  type View,
} from "../shared/scene.types";

export class SceneError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function createSceneStore() {
  const scene: Scene = { view: { ...DEFAULT_VIEW }, boxes: [] };
  const listeners = new Set<(scene: Scene) => void>();
  // Per-kind counters that only go up, so IDs are never reused.
  const nextId: Record<BoxKind, number> = { room: 1, volume: 1 };

  const emit = () => listeners.forEach((l) => l(scene));

  return {
    getScene(): Scene {
      return scene;
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
      scene.boxes.push(...created);
      emit();
      return created;
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

    clear(): void {
      scene.boxes = [];
      emit();
    },

    onChange(listener: (scene: Scene) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type SceneStore = ReturnType<typeof createSceneStore>;

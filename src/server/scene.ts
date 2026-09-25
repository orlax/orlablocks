import {
  DEFAULT_VIEW,
  RectInputSchema,
  type Actor,
  type Scene,
  type Rect,
  type RectInput,
  type View,
} from "../shared/scene.types";

export class SceneError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function createSceneStore() {
  const scene: Scene = { view: { ...DEFAULT_VIEW }, rects: [] };
  const listeners = new Set<(scene: Scene) => void>();
  let nextId = 1;

  const emit = () => listeners.forEach((l) => l(scene));

  return {
    getScene(): Scene {
      return scene;
    },

    /** Validates every input first; applies all or nothing. */
    addRects(inputs: RectInput[], actor: Actor): Rect[] {
      if (inputs.length === 0) throw new SceneError("rects: at least one rect is required");

      const errors: string[] = [];
      const valid = inputs.map((input, i) => {
        const result = RectInputSchema.safeParse(input);
        if (!result.success) {
          for (const issue of result.error.issues) {
            errors.push(`rects[${i}].${issue.path.join(".") || "(item)"}: ${issue.message}`);
          }
          return null;
        }
        const { x, y, width, height } = result.data;
        const rect = { x: round2(x), y: round2(y), width: round2(width), height: round2(height) };
        if (rect.width <= 0) errors.push(`rects[${i}].width: ${width} rounds to 0 at 2 decimals`);
        if (rect.height <= 0) errors.push(`rects[${i}].height: ${height} rounds to 0 at 2 decimals`);
        return rect;
      });
      if (errors.length > 0) throw new SceneError(`Nothing was drawn.\n${errors.join("\n")}`);

      const created: Rect[] = valid.map((r) => ({ id: `rect_${nextId++}`, ...r!, createdBy: actor }));
      scene.rects.push(...created);
      emit();
      return created;
    },

    /** The area the editor window currently shows (last reporting tab wins). Not an edit, so no broadcast. */
    setView(view: View): void {
      scene.view = { x: round2(view.x), y: round2(view.y), width: round2(view.width), height: round2(view.height) };
    },

    clear(): void {
      scene.rects = [];
      emit();
    },

    onChange(listener: (scene: Scene) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type SceneStore = ReturnType<typeof createSceneStore>;

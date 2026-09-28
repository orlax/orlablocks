import type { SceneNode } from "../shared/scene.types";

/**
 * The entities every project starts with (plan 08 §8): a person for scale, 1.8 m tall, standing on its pivot (the
 * origin) and facing -z (north) at rotation 0. Plain shapes, so the project can edit it to match its player.
 */

export const HUMAN_DESCRIPTION = "A person for scale: 1.8 m tall. Edit it to match your player.";

const part = {
  kind: "volume" as const,
  z: 0,
  rotation: 0,
  color: "gray" as const,
  createdBy: "human" as const,
};

export const HUMAN: SceneNode[] = [
  { id: "cylinder_1", type: "cylinder", name: "left leg", ...part, x: -0.1, y: 0, width: 0.15, depth: 0.15, height: 0.85 },
  { id: "cylinder_2", type: "cylinder", name: "right leg", ...part, x: 0.1, y: 0, width: 0.15, depth: 0.15, height: 0.85 },
  { id: "box_1", type: "box", name: "torso", ...part, x: 0, y: 0.85, width: 0.42, depth: 0.24, height: 0.6, bevel: 0.3 },
  { id: "cylinder_3", type: "cylinder", name: "left arm", ...part, x: -0.28, y: 0.82, width: 0.1, depth: 0.1, height: 0.62 },
  { id: "cylinder_4", type: "cylinder", name: "right arm", ...part, x: 0.28, y: 0.82, width: 0.1, depth: 0.1, height: 0.62 },
  { id: "cylinder_5", type: "cylinder", name: "head", ...part, x: 0, y: 1.5, width: 0.24, depth: 0.26, height: 0.3, bevel: 1 },
];

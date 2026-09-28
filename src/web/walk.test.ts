import { describe, expect, it } from "vitest";
import { DEFAULT_PLAYER } from "../shared/scene.types";
import {
  floorUnder,
  frameRect,
  look,
  lookDir,
  move,
  NO_KEYS,
  PITCH_LIMIT,
  presetOf,
  settle,
  shotSize,
  STEP_HEIGHT,
  verticalFov,
  viewVerticalFov,
  walkCamera,
  wheelSpeed,
  type Pose,
} from "./walk";

const pose = (patch: Partial<Pose> = {}): Pose => ({ feet: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, ...patch });
const close = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
  expect(a.z).toBeCloseTo(b.z, 6);
};

describe("walk", () => {
  it("looks north at yaw 0, west at 90, and up with the pitch", () => {
    close(lookDir(0, 0), { x: 0, y: 0, z: -1 });
    close(lookDir(90, 0), { x: -1, y: 0, z: 0 });
    close(lookDir(0, 90), { x: 0, y: 1, z: 0 });
  });

  it("turns right with the mouse moving right, looks up with it moving up, and stops short of straight up", () => {
    expect(look(pose(), 100, 0).yaw).toBeCloseTo(348, 6);
    expect(look(pose(), 0, -100).pitch).toBeCloseTo(12, 6);
    expect(look(pose(), 0, -10_000).pitch).toBe(PITCH_LIMIT);
    expect(look(pose(), 0, 10_000).pitch).toBe(-PITCH_LIMIT);
  });

  it("walks along the ground whatever the pitch, no faster diagonally, and floats with E / Q", () => {
    close(move(pose({ pitch: 60 }), { ...NO_KEYS, forward: true }, 4, 0.5).feet, { x: 0, y: 0, z: -2 });
    close(move(pose({ yaw: 90 }), { ...NO_KEYS, right: true }, 4, 1).feet, { x: 0, y: 0, z: -4 });
    const diagonal = move(pose(), { ...NO_KEYS, forward: true, right: true }, 4, 1).feet;
    expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(4, 6);
    close(move(pose(), { ...NO_KEYS, up: true, fast: true }, 4, 1).feet, { x: 0, y: 12, z: 0 });
    expect(move(pose(), { ...NO_KEYS, forward: true, back: true }, 4, 1)).toEqual(pose());
  });

  it("puts a first-person camera at the eye, and a third-person one behind, above and right of it", () => {
    const first = walkCamera(pose(), 1.65, "first", presetOf(DEFAULT_PLAYER, "first").boom);
    close(first.position, { x: 0, y: 1.65, z: 0 });
    close(first.target, { x: 0, y: 1.65, z: -1 });
    const third = walkCamera(pose(), 1.65, "third", { distance: 3, height: 0.4, shoulder: 0.5 });
    close(third.position, { x: 0.5, y: 2.05, z: 3 });
    close(third.target, { x: 0.5, y: 2.05, z: 2 });
  });

  it("stands on the highest upward face within a step, else the ground, and passes through what's taller", () => {
    expect(floorUnder([], 0)).toBe(0);
    expect(floorUnder([{ y: 0.3, up: 1 }], 0)).toBe(0.3);
    expect(floorUnder([{ y: STEP_HEIGHT + 0.1, up: 1 }], 0)).toBe(0);
    expect(floorUnder([{ y: 3, up: 1 }, { y: 0.2, up: 1 }], 0)).toBe(0.2);
    // A steep face isn't a floor, a ramp's slope is.
    expect(floorUnder([{ y: 0.3, up: 0.2 }], 0)).toBe(0);
    expect(floorUnder([{ y: 0.3, up: 0.8 }], 0)).toBe(0.3);
    // High up, the floor below is found however far down it is.
    expect(floorUnder([{ y: 2, up: 1 }], 10)).toBe(2);
    // Under the ground with nothing below: nowhere to stand.
    expect(floorUnder([], -3)).toBeNull();
    expect(floorUnder([{ y: -3, up: 1 }], -3)).toBe(-3);
  });

  it("eases the feet toward the floor, up quicker than down, and lands exactly", () => {
    const up = settle(0, 0.3, 0.05);
    const down = settle(0.3, 0, 0.05);
    expect(up - 0).toBeGreaterThan(0.3 - down);
    expect(settle(0, 0.3, 1)).toBe(0.3);
    expect(settle(0.298, 0.3, 0.001)).toBe(0.3);
  });

  it("keeps the frame's aspect, centered, and fits the field of view to it", () => {
    expect(frameRect(1600, 900, "16:9")).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    expect(frameRect(2000, 900, "16:9")).toEqual({ x: 200, y: 0, width: 1600, height: 900 });
    expect(frameRect(1000, 1000, "16:9")).toEqual({ x: 0, y: 218.75, width: 1000, height: 562.5 });
    expect(frameRect(1000, 800, "none")).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    expect(verticalFov(90, 1)).toBeCloseTo(90, 6);
    expect(verticalFov(90, 16 / 9)).toBeCloseTo(58.72, 1);
    // The view is taller than the frame: it sees more above and below.
    expect(viewVerticalFov(90, { width: 1000, height: 562.5 }, 1000)).toBeGreaterThan(verticalFov(90, 16 / 9));
    expect(viewVerticalFov(90, { width: 1600, height: 900 }, 900)).toBeCloseTo(verticalFov(90, 16 / 9), 6);
    expect(shotSize({ width: 1000, height: 562.5 }, 1920)).toEqual({ width: 1920, height: 1080 });
  });

  it("changes speed with the wheel, within limits", () => {
    expect(wheelSpeed(4, 100)).toBeLessThan(4);
    expect(wheelSpeed(4, -100)).toBeGreaterThan(4);
    expect(wheelSpeed(4, 100_000)).toBe(0.5);
    expect(wheelSpeed(4, -100_000)).toBe(20);
  });

  it("has a default player camera", () => {
    expect(DEFAULT_PLAYER).toEqual({ eyeHeight: 1.65, speed: 4, first: { fov: 90 }, third: { fov: 60, distance: 3, height: 0.4, shoulder: 0.5, avatar: true } });
  });
});

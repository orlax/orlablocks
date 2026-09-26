import { describe, expect, it } from "vitest";
import type { Box } from "../shared/scene.types";
import { DEFAULT_CAMERA, heightOnVertical, screenRay, worldToScreen, type CameraState, type Vec3 } from "./camera";
import { pickBox } from "./pick";

const size = { width: 1200, height: 800 };
const cam: CameraState = { ...DEFAULT_CAMERA, yaw: 30, distance: 60 };

const room: Box = { id: "room_1", kind: "room", x: 0, z: 0, width: 10, depth: 8, height: 3, createdBy: "human" };
const volume: Box = { id: "volume_1", kind: "volume", x: 4, z: 3, width: 2, depth: 2, height: 1, createdBy: "human" };

/** The ray through the screen position of a world point. */
const rayAt = (p: Vec3) => {
  const s = worldToScreen(cam, size, p)!;
  return screenRay(cam, size, s.sx, s.sy);
};

describe("pickBox", () => {
  it("picks a volume inside a room through the open top", () => {
    expect(pickBox(rayAt({ x: 5, y: 1, z: 4 }), [room, volume])).toBe("volume_1");
  });

  it("picks the room when aiming at its floor", () => {
    expect(pickBox(rayAt({ x: 1.5, y: 0, z: 6.5 }), [room, volume])).toBe("room_1");
  });

  it("picks the room when aiming at the top of a wall", () => {
    expect(pickBox(rayAt({ x: 10, y: 3, z: 4 }), [room, volume])).toBe("room_1");
  });

  it("misses empty ground", () => {
    expect(pickBox(rayAt({ x: 30, y: 0, z: 30 }), [room, volume])).toBeNull();
  });

  it("picks the nearer of two volumes along the same ray", () => {
    const tall: Box = { ...volume, id: "volume_2", x: 4, z: 3, height: 5 };
    expect(pickBox(rayAt({ x: 5, y: 1, z: 4 }), [volume, tall])).toBe("volume_2");
  });
});

describe("worldToScreen and heightOnVertical", () => {
  it("round-trips the focus point to the screen center", () => {
    const s = worldToScreen(cam, size, { x: cam.focus.x, y: 0, z: cam.focus.z })!;
    expect(s.sx).toBeCloseTo(600);
    expect(s.sy).toBeCloseTo(400);
  });

  it("reads back the height of a point on a vertical line from its screen position", () => {
    for (const h of [0.25, 3, 7.5]) {
      const s = worldToScreen(cam, size, { x: 5, y: h, z: 4 })!;
      expect(heightOnVertical(cam, size, s.sx, s.sy, 5, 4)).toBeCloseTo(h);
    }
  });
});

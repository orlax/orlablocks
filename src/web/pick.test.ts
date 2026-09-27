import { describe, expect, it } from "vitest";
import type { Box, Freeform } from "../shared/scene.types";
import { DEFAULT_CAMERA, heightOnVertical, screenRay, worldToScreen, type CameraState, type Vec3 } from "./camera";
import { prism } from "../shared/mesh";
import { pickHit, pickLine, pickShape, rayMesh } from "./pick";

const size = { width: 1200, height: 800 };
const cam: CameraState = { ...DEFAULT_CAMERA, yaw: 30, distance: 60 };

const base = { type: "box", y: 0, rotation: 0, color: "almost-white", createdBy: "human" } as const;
// Footprints by center: the room spans x 0..10, z 0..8; the volume x 4..6, z 3..5.
const room: Box = { ...base, id: "room_1", kind: "room", x: 5, z: 4, width: 10, depth: 8, height: 3 };
const volume: Box = { ...base, id: "volume_1", kind: "volume", x: 5, z: 4, width: 2, depth: 2, height: 1 };

/** The ray through the screen position of a world point. */
const rayAt = (p: Vec3) => {
  const s = worldToScreen(cam, size, p)!;
  return screenRay(cam, size, s.sx, s.sy);
};

describe("pickShape", () => {
  it("picks a volume inside a room through the open top", () => {
    expect(pickShape(rayAt({ x: 5, y: 1, z: 4 }), [room, volume])).toBe("volume_1");
  });

  it("picks the room when aiming at its floor", () => {
    expect(pickShape(rayAt({ x: 1.5, y: 0, z: 6.5 }), [room, volume])).toBe("room_1");
  });

  it("picks the room when aiming at the top of a wall", () => {
    expect(pickShape(rayAt({ x: 10, y: 3, z: 4 }), [room, volume])).toBe("room_1");
  });

  it("misses empty ground", () => {
    expect(pickShape(rayAt({ x: 30, y: 0, z: 30 }), [room, volume])).toBeNull();
  });

  it("picks the nearer of two volumes along the same ray", () => {
    const tall: Box = { ...volume, id: "volume_2", height: 5 };
    expect(pickShape(rayAt({ x: 5, y: 1, z: 4 }), [volume, tall])).toBe("volume_2");
  });

  it("honors elevation: a raised box is hit above the ground, not at it", () => {
    const raised: Box = { ...volume, x: 20, z: 20, y: 3 };
    expect(pickShape(rayAt({ x: 20, y: 3.5, z: 20 }), [raised])).toBe("volume_1");
    expect(pickShape(rayAt({ x: 20, y: 0.5, z: 20 }), [raised])).toBeNull();
  });

  it("honors rotation: a long box turned 90° covers z, not x", () => {
    const long: Box = { ...volume, x: 20, z: 20, width: 10, depth: 1, rotation: 90 };
    expect(pickShape(rayAt({ x: 20, y: 1, z: 24 }), [long])).toBe("volume_1");
    expect(pickShape(rayAt({ x: 24, y: 1, z: 20 }), [long])).toBeNull();
  });
});

describe("pickShape on free-forms", () => {
  // An L-shaped room: 0..6 along x at z 0..2, and 0..2 along z up to 6.
  const l = {
    id: "freeform_1",
    type: "freeform",
    kind: "room",
    y: 0,
    height: 3,
    color: "almost-white",
    createdBy: "human",
    points: [
      { x: 0, z: 0 },
      { x: 6, z: 0 },
      { x: 6, z: 2 },
      { x: 2, z: 2 },
      { x: 2, z: 6 },
      { x: 0, z: 6 },
    ],
  } as const satisfies Freeform;

  it("hits the floor of an arm and misses the L's inside corner", () => {
    expect(pickShape(rayAt({ x: 4, y: 0, z: 1 }), [l])).toBe("freeform_1");
    expect(pickShape(rayAt({ x: 4, y: 0, z: 4 }), [l])).toBeNull();
  });
});

describe("rayMesh", () => {
  // An L-shaped prism 0..2 m tall: 0..4 along x at z 0..1, and 0..1 along z up to 4.
  const l = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 1 },
    { x: 1, z: 1 },
    { x: 1, z: 4 },
    { x: 0, z: 4 },
  ];
  const m = prism([l], 0, 2)!;
  const mesh = { ...m, min: [0, 0, 0] as [number, number, number], max: [4, 2, 4] as [number, number, number] };
  const down = (x: number, z: number) => ({ origin: { x, y: 10, z }, dir: { x: 0, y: -1, z: 0 } });

  it("hits the top straight down through an arm", () => {
    expect(rayMesh(down(3, 0.5), mesh)).toBeCloseTo(8);
  });

  it("misses the inside corner of a concave outline", () => {
    expect(rayMesh(down(3, 3), mesh)).toBeNull();
  });

  it("hits a side face with a level ray", () => {
    expect(rayMesh({ origin: { x: -5, y: 1, z: 2 }, dir: { x: 1, y: 0, z: 0 } }, mesh)).toBeCloseTo(5);
  });

  it("finds nothing behind the ray", () => {
    expect(rayMesh({ origin: { x: 3, y: 10, z: 0.5 }, dir: { x: 0, y: 1, z: 0 } }, mesh)).toBeNull();
  });
});

describe("pickShape with thick walls", () => {
  // The walls grow inward: a 1 m wall on the 10 × 8 room covers x 0..1 on the west side, a default one x 0..0.2.
  const thick: Box = { ...room, wall: 1 };

  it("hits the top of a thick wall where a thin one leaves the room open", () => {
    const ray = rayAt({ x: 0.5, y: 3, z: 4 });
    expect(pickHit(ray, [thick])!.point.y).toBeCloseTo(3);
    expect(pickHit(ray, [room])!.point.y).toBeLessThan(2.9);
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

describe("pickLine", () => {
  const line = { id: "line_1", type: "line" as const, color: "black" as const, points: [{ x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }], thickness: 3, dashed: false, arrow: "none" as const, createdBy: "human" as const };

  it("picks a line near its path on screen, with the point on it", () => {
    const s = worldToScreen(cam, size, { x: 5, y: 1, z: 0 })!;
    const hit = pickLine(cam, size, s.sx + 3, s.sy, [line]);
    expect(hit?.id).toBe("line_1");
    expect(hit!.point.y).toBeCloseTo(1);
    expect(pickLine(cam, size, s.sx, s.sy + 40, [line])).toBeNull();
  });
});

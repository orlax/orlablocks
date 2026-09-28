import { describe, expect, it } from "vitest";
import {
  basis,
  DEFAULT_CAMERA,
  framedCamera,
  lerpCamera,
  MAX_DISTANCE,
  MIN_DISTANCE,
  panTo,
  PITCH_DEG,
  pxPerMeterAtFocus,
  rotateBy,
  screenToGround,
  viewOf,
  worldToScreen,
  zoomBy,
  type CameraState,
} from "./camera";

const size = { width: 1200, height: 800 };
const cam = (patch: Partial<CameraState> = {}): CameraState => ({ ...DEFAULT_CAMERA, ...patch });
const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

describe("camera", () => {
  it("has an orthonormal basis at any yaw", () => {
    for (const yaw of [0, 45, 133, 270]) {
      const { forward, right, up } = basis(yaw);
      for (const v of [forward, right, up]) expect(dot(v, v)).toBeCloseTo(1);
      expect(dot(forward, right)).toBeCloseTo(0);
      expect(dot(forward, up)).toBeCloseTo(0);
      expect(dot(right, up)).toBeCloseTo(0);
      expect(Math.asin(-forward.y) * (180 / Math.PI)).toBeCloseTo(PITCH_DEG);
    }
  });

  it("maps the screen center to the focus point", () => {
    const c = cam({ focus: { x: 7, z: -3 }, yaw: 123 });
    const g = screenToGround(c, size, size.width / 2, size.height / 2);
    expect(g.x).toBeCloseTo(7);
    expect(g.z).toBeCloseTo(-3);
  });

  it("at yaw 0, screen right is +x and screen down is +z", () => {
    const c = cam({ yaw: 0 });
    const ppm = pxPerMeterAtFocus(c, size);
    const center = screenToGround(c, size, 600, 400);
    const right = screenToGround(c, size, 600 + ppm, 400);
    const down = screenToGround(c, size, 600, 400 + ppm);
    expect(right.x - center.x).toBeCloseTo(1); // 1 m per `ppm` px across the screen center
    expect(right.z - center.z).toBeCloseTo(0);
    expect(down.x - center.x).toBeCloseTo(0);
    expect(down.z - center.z).toBeGreaterThan(1); // foreshortened
  });

  it("the default camera shows about 20 px per meter at the focus in an 800 px tall window", () => {
    expect(pxPerMeterAtFocus(DEFAULT_CAMERA, size)).toBeCloseTo(20, 0);
  });

  it("shows things farther away smaller (perspective)", () => {
    const c = cam({ yaw: 0 });
    const top = screenToGround(c, size, 700, 50).x - screenToGround(c, size, 500, 50).x;
    const bottom = screenToGround(c, size, 700, 750).x - screenToGround(c, size, 500, 750).x;
    expect(top).toBeGreaterThan(bottom); // the same 200 px covers more ground near the top of the screen
  });

  it("at yaw 45, +x runs down-right and +z down-left on screen", () => {
    const c = cam({ yaw: 45 });
    const downRight = screenToGround(c, size, 700, 500);
    const downLeft = screenToGround(c, size, 500, 500);
    expect(downRight.x).toBeGreaterThan(0);
    expect(Math.abs(downRight.z)).toBeLessThan(downRight.x);
    expect(downLeft.z).toBeGreaterThan(0);
    expect(Math.abs(downLeft.x)).toBeLessThan(downLeft.z);
  });

  it("pans so the grabbed ground point stays under the cursor", () => {
    const c = cam({ yaw: 71, distance: 40 });
    const grabbed = screenToGround(c, size, 300, 200);
    const panned = panTo(c, size, grabbed, 850, 610);
    const under = screenToGround(panned, size, 850, 610);
    expect(under.x).toBeCloseTo(grabbed.x);
    expect(under.z).toBeCloseTo(grabbed.z);
    expect(panned.yaw).toBe(c.yaw);
    expect(panned.distance).toBe(c.distance);
  });

  it("zooms around the focus point and clamps", () => {
    const c = cam({ focus: { x: 4, z: 5 } });
    const zoomedIn = zoomBy(c, -100);
    expect(zoomedIn.distance).toBeLessThan(c.distance);
    expect(zoomedIn.focus).toEqual(c.focus);
    expect(screenToGround(zoomedIn, size, 600, 400).x).toBeCloseTo(4); // the screen center stays on the focus
    expect(zoomBy(c, 100).distance).toBeGreaterThan(c.distance);
    expect(zoomBy(c, -1e6).distance).toBe(MIN_DISTANCE);
    expect(zoomBy(c, 1e6).distance).toBe(MAX_DISTANCE);
  });

  it("wraps yaw into 0..360", () => {
    expect(rotateBy(cam({ yaw: 350 }), 20).yaw).toBeCloseTo(10);
    expect(rotateBy(cam({ yaw: 10 }), -20).yaw).toBeCloseTo(350);
  });

  it("reports view bounds that contain the focus and every screen corner", () => {
    const c = cam({ focus: { x: 12, z: 8 }, yaw: 45 });
    const view = viewOf(c, size);
    const { x, z, width, depth } = view.bounds;
    expect(view.focus).toEqual({ x: 12, z: 8 });
    expect(view.yaw).toBe(45);
    for (const [sx, sy] of [[0, 0], [size.width, 0], [0, size.height], [size.width, size.height], [600, 400]]) {
      const g = screenToGround(c, size, sx, sy);
      expect(g.x).toBeGreaterThanOrEqual(x - 0.01);
      expect(g.x).toBeLessThanOrEqual(x + width + 0.01);
      expect(g.z).toBeGreaterThanOrEqual(z - 0.01);
      expect(g.z).toBeLessThanOrEqual(z + depth + 0.01);
    }
  });

  it("at yaw 0 the bounds are centered on the focus left to right", () => {
    const view = viewOf(cam({ focus: { x: 3, z: 0 }, yaw: 0 }), size);
    expect(view.bounds.x + view.bounds.width / 2).toBeCloseTo(3, 1);
  });
});

describe("framing", () => {
  const box = { minX: 10, maxX: 14, minY: 0, maxY: 6, minZ: -3, maxZ: 1 };
  it("puts the box's center at the screen center, keeping the yaw", () => {
    for (const yaw of [0, 45, 200]) {
      const c = framedCamera(cam({ yaw }), size, box);
      expect(c.yaw).toBe(yaw);
      const s = worldToScreen(c, size, { x: 12, y: 3, z: -1 })!;
      expect(s.sx).toBeCloseTo(size.width / 2, 3);
      expect(s.sy).toBeCloseTo(size.height / 2, 3);
    }
  });
  it("fits the box: its corners on screen, a bigger box from farther away", () => {
    const c = framedCamera(cam(), size, box);
    for (const x of [box.minX, box.maxX])
      for (const y of [box.minY, box.maxY])
        for (const z of [box.minZ, box.maxZ]) {
          const s = worldToScreen(c, size, { x, y, z })!;
          expect(s.sx).toBeGreaterThan(0);
          expect(s.sx).toBeLessThan(size.width);
          expect(s.sy).toBeGreaterThan(0);
          expect(s.sy).toBeLessThan(size.height);
        }
    const big = framedCamera(cam(), size, { ...box, maxX: 40, maxZ: 30 });
    expect(big.distance).toBeGreaterThan(c.distance);
    // A tiny thing still keeps the closest zoom.
    expect(framedCamera(cam(), size, { minX: 0, maxX: 0.1, minY: 0, maxY: 0.1, minZ: 0, maxZ: 0.1 }).distance).toBe(MIN_DISTANCE);
  });
  it("interpolates the focus, the distance geometrically and the yaw the short way", () => {
    const a = cam({ focus: { x: 0, z: 0 }, yaw: 350, distance: 10 });
    const b = cam({ focus: { x: 10, z: -4 }, yaw: 10, distance: 40 });
    expect(lerpCamera(a, b, 0)).toEqual(a);
    const mid = lerpCamera(a, b, 0.5);
    expect(mid.focus).toEqual({ x: 5, z: -2 });
    expect(mid.yaw).toBeCloseTo(0, 6);
    expect(mid.distance).toBeCloseTo(20, 6);
    const end = lerpCamera(a, b, 1);
    expect(end.focus).toEqual(b.focus);
    expect(end.yaw).toBeCloseTo(10, 6);
    expect(end.distance).toBeCloseTo(40, 6);
  });
});

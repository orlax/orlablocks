import { describe, expect, it } from "vitest";
import { DEFAULT_SNAP, resolveSnap, validSnap } from "./snap";
import { dragArrayHandle } from "./arrayEdit";
import { dragUpdate, gizmoAnchor, startBodyDrag, startHandleDrag, scaleHandlePoint, snapElevation } from "./gizmo";
import { DEFAULT_CAMERA, worldToScreen } from "./camera";
import { boundsOf } from "../shared/geometry";
import type { ArrayNode, Box } from "../shared/scene.types";

const settings = { ...DEFAULT_SNAP, translation: 0.2, elevation: 0.1, rotation: 30, arrayDistance: 0.4, arrayRotation: 20 };
const a: Box = { id: 'a', type: 'box', kind: 'volume', x: 0, y: 0, z: 0, width: 2, depth: 2, height: 1, rotation: 0, color: 'gray', createdBy: 'human' };
const cam = { ...DEFAULT_CAMERA, yaw: 30, distance: 60 };
const size = { width: 1200, height: 800 };
const screen = (p: { x: number; y: number; z: number }) => worldToScreen(cam, size, p)!;
const mods = { snap: true, shift: false, alt: false, settings };

describe('viewer snap preferences', () => {
  it('retains operation defaults and rejects values geometry cannot retain', () => {
    expect(resolveSnap(null)).toEqual(DEFAULT_SNAP);
    for (const value of [0, -1, NaN, Infinity, 0.001, 0.015, 10001, '1', null]) expect(validSnap(value)).toBe(false);
    expect(validSnap(0.01)).toBe(true);
    expect(resolveSnap({ translation: 0.2, rotation: Infinity, elevation: -1 })).toEqual({ ...DEFAULT_SNAP, translation: 0.2 });
  });
  it('shares configured move, height and rotation steps; free movement bypasses them', () => {
    const drag = startBodyDrag([a], { x: 0, y: 1, z: 0 });
    const end = screen({ x: 1.13, y: 1, z: 0.31 });
    expect(dragUpdate(drag, cam, size, end.sx, end.sy, mods, []).patches.a).toEqual({ x: 1.2, z: 0.4 });
    expect(dragUpdate(drag, cam, size, end.sx, end.sy, { ...mods, snap: false }, []).patches.a).toEqual({ x: 1.13, z: 0.31 });
    const start = screen({ x: 0, y: 1, z: 0 });
    const height = startHandleDrag(cam, size, start.sx, start.sy, 'height', [a]);
    const up = screen({ x: 0, y: 3.26, z: 0 });
    expect(dragUpdate(height, cam, size, up.sx, up.sy, mods, []).patches.a.height).toBe(3.3);
    const pivot = gizmoAnchor(boundsOf([a]));
    const at = (deg: number) => screen({ x: pivot.x + 5 * Math.cos(deg * Math.PI / 180), y: pivot.y, z: pivot.z - 5 * Math.sin(deg * Math.PI / 180) });
    const r0 = at(-135), r1 = at(-98);
    const rotate = startHandleDrag(cam, size, r0.sx, r0.sy, 'rotate', [a]);
    expect(dragUpdate(rotate, cam, size, r1.sx, r1.sy, mods, []).patches.a.rotation).toBe(30);
    expect(a).toMatchObject({ x: 0, z: 0, height: 1, rotation: 0 });
  });
  it('resizes on the configured grid with the opposite edge fixed', () => {
    const from = screen(scaleHandlePoint(a, 'scale:1:0'));
    const drag = startHandleDrag(cam, size, from.sx, from.sy, 'scale:1:0', [a]);
    const end = screen({ x: 2.13, y: 1, z: 0 });
    const patch = dragUpdate(drag, cam, size, end.sx, end.sy, mods, []).patches.a;
    expect(patch.width).toBe(3.2);
    expect(patch.x).toBe(0.6);
    expect(patch.x! - patch.width! / 2).toBe(-1);
  });
  it('keeps surface attraction independent of the elevation increment', () => {
    expect(snapElevation(2.8, [3], true, 1)).toBe(3);
    expect(snapElevation(2.6, [3], true, 0.1)).toBe(2.6);
    expect(snapElevation(1.66, [], true, 0.1)).toBe(1.7);
    expect(snapElevation(1.66, [], false, 0.1)).toBe(1.66);
  });
  it('uses configured array center, radius and angle steps, with fully free Ctrl/Cmd', () => {
    const array = { id: 'arr', type: 'array', layout: { type: 'circle', x: 0, y: 0, z: 0, radius: 3, count: 8 } } as ArrayNode;
    expect(dragArrayHandle(array, 'center', { x: 1.13, z: 0.31 }, { settings })!.patch).toEqual({ x: 1.2, z: 0.4 });
    expect(dragArrayHandle(array, 'radius', { x: 3.34, z: 0 }, { settings })!.patch).toEqual({ radius: 3.2 });
    expect(dragArrayHandle(array, 'radius', { x: 3.34, z: 0 }, { settings, free: true })!.patch).toEqual({ radius: 3.34 });
    const to = { x: 3 * Math.cos(33 * Math.PI / 180), z: -3 * Math.sin(33 * Math.PI / 180) };
    expect(dragArrayHandle(array, 'radius', to, { settings, alt: true })!.patch).toEqual({ start: 40 });
    expect(dragArrayHandle(array, 'radius', to, { settings, alt: true, free: true })!.patch).toEqual({ start: 33 });
  });
});

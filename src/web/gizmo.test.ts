import { describe, expect, it } from "vitest";
import type { Box } from "../shared/scene.types";
import { DEFAULT_CAMERA, worldToScreen, type CameraState, type Vec3 } from "./camera";
import {
  ARROW,
  dragUpdate,
  effectiveChanges,
  elevationTargets,
  footprintBounds,
  gizmoAnchor,
  gizmoScale,
  hitGizmo,
  rotateHandlePlacement,
  SCALE_PARTS,
  scaleHandlePoint,
  selectionBounds,
  snapElevation,
  startBodyDrag,
  startHandleDrag,
} from "./gizmo";

const size = { width: 1200, height: 800 };
const cam: CameraState = { ...DEFAULT_CAMERA, yaw: 30, distance: 60 };
const box = (patch: Partial<Box>): Box => ({
  id: "box_1",
  type: "box",
  kind: "volume",
  x: 0,
  z: 0,
  y: 0,
  width: 2,
  depth: 2,
  height: 1,
  rotation: 0,
  color: "almost-white",
  createdBy: "human",
  ...patch,
});
const screen = (p: Vec3) => worldToScreen(cam, size, p)!;
const snapOn = { shift: false, alt: false, snap: true };

describe("bounds", () => {
  it("covers a rotated footprint", () => {
    const f = footprintBounds(box({ width: 4, depth: 2, rotation: 90 }));
    expect(f.minX).toBeCloseTo(-1);
    expect(f.maxX).toBeCloseTo(1);
    expect(f.minZ).toBeCloseTo(-2);
    expect(f.maxZ).toBeCloseTo(2);
  });

  it("spans every box, and the gizmo sits on its top center", () => {
    const b = selectionBounds([box({}), box({ id: "box_2", x: 10, z: 4, y: 2, height: 3 })]);
    expect(b).toEqual({ minX: -1, maxX: 11, minY: 0, maxY: 5, minZ: -1, maxZ: 5 });
    expect(gizmoAnchor(b)).toEqual({ x: 5, y: 5, z: 2 });
  });
});

describe("elevation snapping", () => {
  const room = box({ id: "room", kind: "room", x: 0, z: 0, width: 6, depth: 6, height: 3 });
  const far = box({ id: "far", x: 30, z: 30, height: 7 });

  it("targets the ground and the tops of boxes under the selection only", () => {
    expect(elevationTargets(selectionBounds([box({ x: 2 })]), [room, far])).toEqual([0, 3]);
  });

  it("snaps to a target within 0.25 m, else to 0.05 m steps, and not at all when free", () => {
    expect(snapElevation(2.8, [0, 3], true)).toBe(3);
    expect(snapElevation(0.2, [0, 3], true)).toBe(0);
    expect(snapElevation(1.62, [0, 3], true)).toBe(1.6);
    expect(snapElevation(2.8, [0, 3], false)).toBe(2.8);
  });
});

describe("hitGizmo", () => {
  const anchor = { x: 0, y: 1, z: 0 };
  const along = (axis: Vec3, units: number) => {
    const s = gizmoScale(cam) * units;
    return screen({ x: anchor.x + axis.x * s, y: anchor.y + axis.y * s, z: anchor.z + axis.z * s });
  };
  const mid = ARROW.start + ARROW.length / 2;

  it("finds each arrow along its length, and the height handle at the center", () => {
    const parts = ["x", "y", "z", "height"] as const;
    const at = (p: { sx: number; sy: number }) => hitGizmo(cam, size, p.sx, p.sy, anchor, [...parts]);
    expect(at(along({ x: 1, y: 0, z: 0 }, mid))).toBe("x");
    expect(at(along({ x: 0, y: 1, z: 0 }, mid))).toBe("y");
    expect(at(along({ x: 0, y: 0, z: 1 }, mid))).toBe("z");
    expect(at(along({ x: 0, y: 1, z: 0 }, 0.1))).toBe("height");
    expect(at(along({ x: -1, y: 0, z: -1 }, 3))).toBeNull();
  });

  it("ignores parts that aren't shown", () => {
    const p = along({ x: 0, y: 1, z: 0 }, 0.1);
    expect(hitGizmo(cam, size, p.sx, p.sy, anchor, ["x", "y", "z"])).not.toBe("height");
  });
});

describe("dragUpdate", () => {
  const a = box({ x: 1, z: 1 });

  it("an x arrow drag moves along x only, in 0.5 m steps", () => {
    const top = { x: 1, y: 1, z: 1 };
    const start = screen({ x: top.x + 1, y: top.y, z: top.z });
    const drag = startHandleDrag(cam, size, start.sx, start.sy, "x", [a]);
    const end = screen({ x: top.x + 1 + 3.2, y: top.y, z: top.z });
    const { patches, label } = dragUpdate(drag, cam, size, end.sx, end.sy, snapOn, []);
    expect(patches).toEqual({ box_1: { x: 4, z: 1 } });
    expect(label).toBe("x 4.00 · z 1.00");
    // Wandering off the axis never changes z.
    const off = screen({ x: top.x + 1, y: top.y, z: top.z + 5 });
    expect(dragUpdate(drag, cam, size, off.sx, off.sy, snapOn, []).patches.box_1.z).toBe(1);
  });

  it("a body drag keeps the grabbed point under the cursor, and Shift locks it to the dominant axis", () => {
    const grab = { x: 1.5, y: 1, z: 0.5 };
    const drag = startBodyDrag([a], grab);
    const end = screen({ x: grab.x + 2, y: grab.y, z: grab.z + 0.5 });
    expect(dragUpdate(drag, cam, size, end.sx, end.sy, snapOn, []).patches).toEqual({ box_1: { x: 3, z: 1.5 } });
    expect(dragUpdate(drag, cam, size, end.sx, end.sy, { shift: true, alt: false, snap: true }, []).patches).toEqual({
      box_1: { x: 3, z: 1 },
    });
  });

  it("a y arrow drag snaps the selection's bottom onto the top of a room under it", () => {
    const room = box({ id: "room", kind: "room", x: 0, z: 0, width: 6, depth: 6, height: 3 });
    const top = { x: 1, y: 1, z: 1 };
    const start = screen({ ...top, y: top.y + 1 });
    const drag = startHandleDrag(cam, size, start.sx, start.sy, "y", [a]);
    // Lift the bottom to about 2.85 m: within range of the room's 3 m top.
    const end = screen({ ...top, y: top.y + 1 + 2.85 });
    const { patches, label } = dragUpdate(drag, cam, size, end.sx, end.sy, snapOn, [room]);
    expect(patches).toEqual({ box_1: { y: 3 } });
    expect(label).toBe("y 3.00 m");
  });

  it("a height drag changes the height with the bottom fixed, never below 0.05 m", () => {
    const top = { x: 1, y: 1, z: 1 };
    const start = screen(top);
    const drag = startHandleDrag(cam, size, start.sx, start.sy, "height", [a]);
    const up = screen({ ...top, y: 3.26 });
    expect(dragUpdate(drag, cam, size, up.sx, up.sy, snapOn, []).patches).toEqual({ box_1: { height: 3.25 } });
    const down = screen({ ...top, y: -5 });
    expect(dragUpdate(drag, cam, size, down.sx, down.sy, snapOn, []).patches).toEqual({ box_1: { height: 0.05 } });
  });

  it("moves every selected box by the same amount", () => {
    const b = box({ id: "box_2", x: 5, z: -2, y: 1 });
    const drag = startBodyDrag([a, b], { x: 0, y: 0, z: 0 });
    const end = screen({ x: -1, y: 0, z: 2 });
    expect(dragUpdate(drag, cam, size, end.sx, end.sy, snapOn, []).patches).toEqual({
      box_1: { x: 0, z: 3 },
      box_2: { x: 4, z: 0 },
    });
  });
});

describe("scale handles", () => {
  // Footprint x 0..2, z 0..2, top at y 1.
  const a = box({ x: 1, z: 1 });
  const plain = { shift: false, alt: false, snap: true };
  /** Drags `part` of `b` from its handle to the world ground point `to` on the top face's plane. */
  const scale = (b: Box, part: (typeof SCALE_PARTS)[number], to: { x: number; z: number }, mods = plain) => {
    const from = screen(scaleHandlePoint(b, part));
    const drag = startHandleDrag(cam, size, from.sx, from.sy, part, [b]);
    const end = screen({ x: to.x, y: b.y + b.height, z: to.z });
    return dragUpdate(drag, cam, size, end.sx, end.sy, mods, []);
  };

  it("sit on the top face's corners and edge midpoints, turned with the box", () => {
    expect(scaleHandlePoint(a, "scale:1:1")).toEqual({ x: 2, y: 1, z: 2 });
    expect(scaleHandlePoint(a, "scale:-1:0")).toEqual({ x: 0, y: 1, z: 1 });
    const turned = scaleHandlePoint(box({ width: 4, depth: 2, rotation: 90 }), "scale:1:0");
    expect(turned.x).toBeCloseTo(0);
    expect(turned.z).toBeCloseTo(-2);
  });

  it("are found by hitGizmo, given the box", () => {
    const p = screen(scaleHandlePoint(a, "scale:1:-1"));
    const anchor = { x: 1, y: 1, z: 1 };
    expect(hitGizmo(cam, size, p.sx, p.sy, anchor, ["x", "y", "z", "height", ...SCALE_PARTS], [a])).toBe("scale:1:-1");
  });

  it("a corner resizes with the opposite corner fixed, in 0.5 m steps", () => {
    const { patches, label } = scale(a, "scale:1:1", { x: 3.2, z: 3.6 });
    expect(patches).toEqual({ box_1: { x: 1.5, z: 1.75, width: 3, depth: 3.5 } });
    expect(label).toBe("3.00 × 3.50 m");
  });

  it("an edge moves one side only", () => {
    expect(scale(a, "scale:-1:0", { x: -1.1, z: 5 }).patches).toEqual({ box_1: { x: 0.5, z: 1, width: 3, depth: 2 } });
  });

  it("Alt scales around the center, 0.5 m per side", () => {
    expect(scale(a, "scale:1:0", { x: 3.2, z: 1 }, { ...plain, alt: true }).patches).toEqual({
      box_1: { x: 1, z: 1, width: 4, depth: 2 },
    });
  });

  it("Shift keeps the aspect ratio: a corner follows the side that grows more, an edge scales around the center", () => {
    const shift = { ...plain, shift: true };
    expect(scale(a, "scale:1:1", { x: 4.1, z: 2.5 }, shift).patches).toEqual({ box_1: { x: 2, z: 2, width: 4, depth: 4 } });
    expect(scale(a, "scale:1:0", { x: 4.1, z: 1 }, shift).patches).toEqual({ box_1: { x: 2, z: 1, width: 4, depth: 4 } });
  });

  it("works in the box's own axes when it's rotated", () => {
    // Turned 90°: its width runs along world -z, so its +x edge is at z = -2.
    const turned = box({ x: 0, z: 0, width: 4, depth: 2, rotation: 90 });
    const { patches } = scale(turned, "scale:1:0", { x: 0.7, z: -3 });
    expect(patches.box_1).toMatchObject({ width: 5, depth: 2 });
    expect(patches.box_1.x).toBeCloseTo(0);
    expect(patches.box_1.z).toBeCloseTo(-0.5);
  });

  it("never shrinks a side below the smallest size on the snap lattice", () => {
    expect(scale(a, "scale:1:0", { x: -10, z: 1 }).patches.box_1).toMatchObject({ width: 0.5, x: 0.25 });
    expect(scale(a, "scale:1:0", { x: -10, z: 1 }, { ...plain, snap: false }).patches.box_1).toMatchObject({ width: 0.05 });
  });
});

describe("rotate handle", () => {
  const plain = { shift: false, alt: false, snap: true };
  /** Drags the rotate handle around the selection's center by `degrees` (counterclockwise seen from above). */
  const rotate = (boxes: Box[], degrees: number, mods = plain) => {
    const bounds = selectionBounds(boxes);
    const pivot = gizmoAnchor(bounds);
    const r = 5;
    const at = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return screen({ x: pivot.x + r * Math.cos(a), y: pivot.y, z: pivot.z - r * Math.sin(a) });
    };
    const start = at(-135);
    const drag = startHandleDrag(cam, size, start.sx, start.sy, "rotate", boxes);
    const end = at(-135 + degrees);
    return dragUpdate(drag, cam, size, end.sx, end.sy, mods, []);
  };

  it("sits just outside the box's (-x, -z) corner, turning with the box", () => {
    const a = box({ x: 0, z: 0, width: 2, depth: 2 });
    const { point, inward } = rotateHandlePlacement([a], 1);
    expect(point.x).toBeLessThan(-1);
    expect(point.z).toBeLessThan(-1);
    expect(point.y).toBe(1);
    expect(inward.x).toBeCloseTo(Math.SQRT1_2);
    const turned = rotateHandlePlacement([box({ x: 0, z: 0, width: 2, depth: 2, rotation: 90 })], 1).point;
    // Turned 90° counterclockwise: the (-x, -z) corner is now at world (-1, +1).
    expect(turned.x).toBeLessThan(-1);
    expect(turned.z).toBeGreaterThan(1);
  });

  it("is found by hitGizmo", () => {
    const a = box({ x: 3, z: 3 });
    const p = screen(rotateHandlePlacement([a], gizmoScale(cam)).point);
    expect(hitGizmo(cam, size, p.sx, p.sy, { x: 3, y: 1, z: 3 }, ["x", "y", "z", "rotate"], [a])).toBe("rotate");
  });

  it("turns a single box in place, snapping to whole 15° angles", () => {
    const a = box({ x: 2, z: 3, rotation: 7 });
    const { patches, label } = rotate([a], 36);
    expect(patches).toEqual({ box_1: { x: 2, z: 3, rotation: 45 } });
    expect(label).toBe("45°");
    expect(rotate([a], -20).patches.box_1.rotation).toBe(345);
    expect(rotate([a], 36, { ...plain, snap: false }).patches.box_1.rotation).toBeCloseTo(43, 0);
  });

  it("turns several boxes around their combined center, snapping the change", () => {
    // Centers at x -2 and +2, so the bounds' center (the pivot) is 0, 0. A 90° counterclockwise turn (seen from
    // above) sends +x to -z.
    const a = box({ x: -2, z: 0, rotation: 90 });
    const b = box({ id: "box_2", x: 2, z: 0 });
    const { patches, label } = rotate([a, b], 88);
    expect(patches).toEqual({ box_1: { x: 0, z: 2, rotation: 180 }, box_2: { x: 0, z: -2, rotation: 90 } });
    expect(label).toBe("+90°");
  });
});

describe("effectiveChanges", () => {
  it("keeps only patches that change something", () => {
    const a = box({});
    const b = box({ id: "box_2" });
    expect(effectiveChanges([a, b], { box_1: { x: 0, z: 0 }, box_2: { x: 1, z: 0 } })).toEqual([{ id: "box_2", x: 1, z: 0 }]);
  });
});

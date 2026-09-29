import * as THREE from "three";
import { definitionOf, expandShapes, ownerOf } from "../shared/entities";
import { boundsOf, polyline, rampStations } from "../shared/geometry";
import {
  DEFAULT_RENDER_SIZE,
  type PlayerCamera,
  type RenderJob,
  type RenderSection,
  type RenderResult,
  type SceneNode,
  type Shape,
  type ShotCamera,
  type WalkPreset,
} from "../shared/scene.types";
import { isShape } from "../shared/tree";
import { framedCamera, FOV_DEG, MAX_DISTANCE, type Box3, type CameraState } from "./camera";
import { blobToBase64, editorView, makeCamera, type CaptureView } from "./capture";
import {
  drawnShapes,
  gridLayout,
  labelTargets,
  legendLine,
  lookAt,
  niceLength,
  pairLayout,
  planFrame,
  planSize,
  SHEET_ANGLES,
  sheetLayout,
  stripLayout,
  walkFrames,
  type Cell,
  type LabelTarget,
} from "./renders";
import { eyeOf, lookDir, presetOf, shotSize, verticalFov, walkCamera, type Boom, type Pose, type Vec3 } from "./walk";
import { avatarShapes } from "./WalkScreens";

/**
 * `render_view` in the editor (plan 09 §6): each view is one or more captures (capture.tsx) drawn onto one image,
 * with letter labels, captions, and for plans a grid, a scale bar and north. The text says what the image shows,
 * with the labels' legend. The planning is in `renders.ts`.
 */

/** What rendering needs from the view. */
export type RenderContext = {
  nodes: SceneNode[];
  /** The hidden nodes (and what's in them): left out. */
  hidden: Set<string>;
  /** The view's camera: its yaw is the default direction for close-ups and eye views. */
  editor: CameraState;
  player: PlayerCamera;
  avatarEntity: string | null;
  /** The height of the highest floor or top at a point (for points given without y), else 0. */
  surfaceY: (x: number, z: number) => number;
  /** A clean capture (no notes; lines as asked) at 1 × pixel ratio, with extra shapes (an avatar). */
  capture: (view: CaptureView, width: number, height: number, options: { notes: boolean; lines: boolean; clip?: number }, extra?: Shape[]) => Promise<Blob>;
  /** A capture of other nodes than the document's: an entity's definition (its holes cut as in an instance), plus extra shapes. */
  captureNodes: (view: CaptureView, width: number, height: number, nodes: SceneNode[], extra?: Shape[]) => Promise<Blob>;
};

const round = (n: number) => Math.round(n * 100) / 100;
const range = (a: number, b: number) => `${round(a)}..${round(b)}`;
const boundsText = (b: Box3) => `x ${range(b.minX, b.maxX)}, y ${range(b.minY, b.maxY)}, z ${range(b.minZ, b.maxZ)}`;

export async function renderJob(job: RenderJob, ctx: RenderContext): Promise<RenderResult> {
  const size = job.size ?? DEFAULT_RENDER_SIZE;
  const labels = job.labels ?? true;
  const shown = (s: Shape) => !ctx.hidden.has(ownerOf(s.id)) && !ctx.hidden.has(s.id) && s.type !== "note";
  const scope = (job.ids ? job.ids.flatMap((id) => drawnShapes(ctx.nodes, id)) : expandShapes(ctx.nodes.filter(isShape))).filter(shown);
  const hiddenCount = ctx.nodes.filter((n) => n.hidden).length;
  const notes: string[] = [];
  if (hiddenCount > 0) notes.push(`${hiddenCount} hidden node${hiddenCount === 1 ? "" : "s"} left out.`);
  if (job.hide) notes.push(`For this render only, ${job.hide.join(", ")} (and what's in ${job.hide.length === 1 ? "it" : "them"}) left out.`);
  if (job.clip !== undefined) notes.push(`Everything above y ${job.clip} cut away (a section).`);
  const scopeText = job.ids ? job.ids.join(", ") : "everything";
  const needShapes = () => {
    if (scope.length === 0) throw new Error(job.ids ? `${scopeText} draw${job.ids.length === 1 ? "s" : ""} nothing to render.` : "The document is empty: nothing to render.");
    return boundsOf(scope);
  };
  const targets = (): LabelTarget[] => (labels ? labelTargets(ctx.nodes, job.ids, ctx.hidden) : []);
  const legend = (t: LabelTarget[]) => (t.length > 0 ? [`Labels: ${t.map(legendLine).join(", ")}.`] : []);
  const lines = { notes: false, lines: true };

  switch (job.view) {
    case "plan": {
      const b = needShapes();
      if (job.sections) return slicePlan(job, job.sections, b, size, ctx, notes, scopeText);
      const { width, height } = planSize(b, size);
      const cell = { x: 0, y: 0, width, height };
      const { view, frame } = planView(b, width / height);
      const img = compose(width, height);
      await img.draw(await ctx.capture(view, width, height, lines), cell);
      const grid = img.planOverlay(frame, cell);
      const t = targets();
      img.labels(t, makeCamera(view, width, height), cell);
      return img.result(
        [`Plan of ${scopeText}, top-down, north up: ${round(frame.width)} × ${round(frame.height)} m, with a ${grid} m grid and a scale bar. Bounds: ${boundsText(b)} (m).`, ...legend(t), ...notes].join("\n"),
      );
    }
    case "sheet": {
      const b = needShapes();
      const layout = sheetLayout(size);
      const img = compose(layout.width, layout.height);
      const t = targets();
      const [planCell, ...angleCells] = layout.cells;
      const plan = planView(b, planCell.width / planCell.height);
      await img.draw(await ctx.capture(plan.view, planCell.width, planCell.height, lines), planCell);
      const grid = img.planOverlay(plan.frame, planCell);
      img.labels(t, makeCamera(plan.view, planCell.width, planCell.height), planCell);
      img.caption("plan, north up", planCell);
      for (const [i, angle] of SHEET_ANGLES.entries()) {
        const cell = angleCells[i];
        const view = editorView(framedCamera({ focus: { x: 0, z: 0 }, yaw: angle.yaw, distance: 50 }, cell, b));
        await img.draw(await ctx.capture(view, cell.width, cell.height, lines), cell);
        img.labels(t, makeCamera(view, cell.width, cell.height), cell);
        img.caption(angle.name, cell);
      }
      img.dividers(layout.cells);
      return img.result(
        [
          `Sheet of ${scopeText}. Top left: the plan, north up (${grid} m grid, scale bar); top right: from the northeast; bottom left: from the south; bottom right: from the west. Bounds: ${boundsText(b)} (m).`,
          ...legend(t),
          ...notes,
        ].join("\n"),
      );
    }
    case "node": {
      const b = needShapes();
      const width = size;
      const height = Math.round((size * 9) / 16);
      const cam = framedCamera({ focus: { x: 0, z: 0 }, yaw: job.yaw ?? ctx.editor.yaw, distance: 50 }, { width, height }, b);
      const view = editorView(cam);
      const img = compose(width, height);
      const cell = { x: 0, y: 0, width, height };
      await img.draw(await ctx.capture(view, width, height, lines), cell);
      const t = targets();
      img.labels(t, makeCamera(view, width, height), cell);
      return img.result(
        [`Close-up of ${scopeText}, from yaw ${round(cam.yaw)}° (0 = from the south, looking north). Bounds: ${boundsText(b)} (m).`, ...legend(t), ...notes].join("\n"),
        { kind: "editor", ...cam },
      );
    }
    case "eye": {
      const width = size;
      const height = Math.round((size * 9) / 16);
      const e = eyeOfJob(job, ctx);
      const { image, camera } = await eyeFrame(e, width, height, ctx);
      const img = compose(width, height);
      await img.draw(image, { x: 0, y: 0, width, height });
      const where = job.human ? "Where the human is walking" : `From feet at ${pointText(e.pose.feet)}`;
      return img.result(
        [
          `${where}: the eye at ${pointText(eyeOf(e.pose, ctx.player.eyeHeight))}, looking yaw ${round(e.pose.yaw)}°, pitch ${round(e.pose.pitch)}°, ${e.preset === "first" ? "first" : "third"} person, ${round(e.fov)}° across.`,
          ...notes,
        ].join("\n"),
        camera,
      );
    }
    case "walk": {
      const path = walkPath(job, ctx);
      const n = job.frames ?? 5;
      const preset: WalkPreset = job.preset ?? "first";
      const frames = walkFrames(path, n);
      const layout = stripLayout(n, size);
      const img = compose(layout.width, layout.height);
      const { fov, boom } = presetOf(ctx.player, preset);
      const where: string[] = [];
      for (const [i, f] of frames.entries()) {
        const cell = layout.cells[i];
        const pose: Pose = { feet: f.feet, yaw: f.yaw, pitch: f.pitch };
        const { image } = await eyeFrame({ pose, preset, fov, boom }, cell.width, cell.height, ctx);
        await img.draw(image, cell);
        img.caption(String(i + 1), cell);
        where.push(`${i + 1}: feet ${pointText(f.feet)}, yaw ${round(f.yaw)}°`);
      }
      img.dividers(layout.cells);
      const along = typeof job.path === "string" ? job.path : "the points given";
      return img.result([`Walk along ${along}, ${n} frames at eye height (${ctx.player.eyeHeight} m, ${preset} person), numbered in order. ${where.join("; ")}.`, ...notes].join("\n"));
    }
    case "shot": {
      const shot = job.shotCamera!;
      const { width, height } = shotSize(shot, size);
      const img = compose(width, height);
      const c = shot.camera;
      await img.draw(await shotAgain(c, width, height, ctx), { x: 0, y: 0, width, height });
      return img.result([`${job.shot} taken again now, with its camera (${c.kind === "editor" ? "the editor's" : `a ${c.preset}-person walk`}).`, ...notes].join("\n"), c);
    }
    case "shots": {
      const pairs = job.pairs ?? [];
      const layout = pairLayout(
        pairs.map((p) => p.width / p.height),
        size,
      );
      const img = compose(layout.width, layout.height);
      const said: string[] = [];
      for (const [i, p] of pairs.entries()) {
        const row = layout.rows[i];
        const before = await (await fetch(p.url)).blob();
        await img.draw(before, row.before);
        await img.draw(await shotAgain(p.camera, row.now.width, row.now.height, ctx), row.now);
        img.caption(`${p.id}, as taken`, row.before);
        img.caption(p.since === 0 ? "now (no change)" : `now, ${p.since} step${p.since === 1 ? "" : "s"} later`, row.now);
        said.push(`${p.id}${p.caption ? `: "${p.caption}"` : " (no caption)"}, ${p.since} step${p.since === 1 ? "" : "s"} since`);
      }
      img.dividers(layout.rows.flatMap((r) => [r.before, r.now]));
      return img.result(
        [
          `${pairs.length} shot${pairs.length === 1 ? "" : "s"} re-checked, one per row: on the left as taken, on the right the same camera now. For each, is its caption still true?`,
          ...said,
          ...notes,
        ].join("\n"),
      );
    }
    case "entities": {
      const entities = job.entities ?? [];
      const layout = gridLayout(entities.length, size);
      const img = compose(layout.width, layout.height);
      const said: string[] = [];
      for (const [i, e] of entities.entries()) {
        const cell = layout.cells[i];
        const def = definitionOf(e.id) ?? [];
        const own = def.filter(isShape).filter((s) => s.type !== "note");
        if (own.length === 0) {
          img.caption(`${e.name} (empty)`, cell);
          said.push(`${i + 1}. ${e.id} "${e.name}": no shapes`);
          continue;
        }
        const b = boundsOf(own);
        // The human beside it for scale (not beside the human itself).
        const human = e.id === ctx.avatarEntity ? [] : avatarShapes(ctx.avatarEntity, ctx.player.eyeHeight, { x: b.maxX + 0.8, y: 0, z: (b.minZ + b.maxZ) / 2, rotation: 0 });
        const all = human.length > 0 ? boundsOf([...own, ...human]) : b;
        const view = editorView(framedCamera({ focus: { x: 0, z: 0 }, yaw: MODEL_SHEET_YAW, distance: 50 }, cell, all));
        await img.draw(await ctx.captureNodes(view, cell.width, cell.height, def, human), cell);
        img.caption(`${i + 1} ${e.name}`, cell);
        said.push(`${i + 1}. ${e.id} "${e.name}": ${round(b.maxX - b.minX)} × ${round(b.maxZ - b.minZ)} × ${round(b.maxY - b.minY)} m${e.tags?.length ? `, ${e.tags.map((t) => `#${t}`).join(" ")}` : ""}`);
      }
      img.dividers(layout.cells);
      return img.result(
        [
          `Model sheet: ${entities.length} entit${entities.length === 1 ? "y" : "ies"}, each from the same angle, with the human (${round(boundsOf(avatarShapes(ctx.avatarEntity, ctx.player.eyeHeight)).maxY)} m) beside it for scale. Sizes are width × depth × height.`,
          ...said,
        ].join("\n"),
      );
    }
  }
}

/**
 * A slice render (14.7): a plan cut at each height (the capture clipped there), washed pale, with each solid's
 * section drawn bold, holes dashed, and the gaps between solids ringed in red with their widths. Several heights
 * come as a small multiple, one panel each.
 */
async function slicePlan(job: RenderJob, sections: RenderSection[], b: Box3, size: number, ctx: RenderContext, notes: string[], scopeText: string): Promise<RenderResult> {
  const lines = { notes: false, lines: false };
  const single = sections.length === 1;
  const layout = single ? null : sheetLayout(size);
  const { width, height } = single ? planSize(b, size) : layout!;
  const cells = single ? [{ x: 0, y: 0, width, height }] : layout!.cells.slice(0, sections.length);
  const img = compose(width, height);
  const text: string[] = [];
  for (const [i, section] of sections.entries()) {
    const cell = cells[i];
    const { view, frame } = planView(b, cell.width / cell.height);
    await img.draw(await ctx.capture(view, cell.width, cell.height, { ...lines, clip: section.y }), cell);
    img.planOverlay(frame, cell);
    img.section(section, frame, cell);
    img.caption(`y ${round(section.y)}`, cell);
    const solids = section.outlines.filter((o) => !o.hole).length;
    const gaps = section.gaps.map((g) => `${g.between.join(" – ")} ${g.width} m apart at (${round(g.at.x)}, ${round(g.at.z)})`);
    text.push(`At y ${round(section.y)}: ${solids} solid${solids === 1 ? "" : "s"} cut; ${gaps.length > 0 ? `gaps: ${gaps.join("; ")}` : `no gaps up to ${job.gap ?? 2} m`}.`);
  }
  if (!single) img.dividers(cells);
  return img.result(
    [`Slice plan of ${scopeText}, top-down, north up: each solid cut at the height (bold), holes dashed, gaps ringed in red.`, ...text, ...notes].join("\n"),
  );
}

/** Every model sheet cell looks from the southeast, a little turned, so fronts (south) and sides both show. */
const MODEL_SHEET_YAW = 30;

/** A stored shot's camera, captured now. */
async function shotAgain(c: ShotCamera, width: number, height: number, ctx: RenderContext): Promise<Blob> {
  if (c.kind === "editor") return ctx.capture(editorView({ focus: c.focus, yaw: c.yaw, distance: c.distance }), width, height, { notes: false, lines: true });
  const pose: Pose = { feet: { x: c.eye.x, y: c.eye.y - ctx.player.eyeHeight, z: c.eye.z }, yaw: c.yaw, pitch: c.pitch };
  const boom = c.boom ?? presetOf(ctx.player, c.preset).boom;
  return (await eyeFrame({ pose, preset: c.preset, fov: c.fov, boom }, width, height, ctx)).image;
}

const pointText = (p: Vec3) => `(${round(p.x)}, ${round(p.y)}, ${round(p.z)})`;

/** A plan's straight-down camera over bounds, for an image of `aspect`. */
function planView(b: Box3, aspect: number): { view: CaptureView; frame: ReturnType<typeof planFrame> } {
  const frame = planFrame(b, aspect);
  return {
    frame,
    view: {
      position: { x: frame.x, y: b.maxY + 100, z: frame.z },
      target: { x: frame.x, y: b.minY - 1, z: frame.z },
      vfov: FOV_DEG,
      light: { focus: { x: frame.x, z: frame.z }, yaw: 0, distance: Math.min(MAX_DISTANCE, Math.max(20, Math.max(frame.width, frame.height) * 1.5)) },
      ortho: { width: frame.width, height: frame.height },
    },
  };
}

type Eye = { pose: Pose; preset: WalkPreset; fov: number; boom: Boom };

/** The eye view a job asks for: from where the human walks, or from feet at a point, looking at `at` or along yaw / pitch. */
function eyeOfJob(job: RenderJob, ctx: RenderContext): Eye {
  const eyeHeight = ctx.player.eyeHeight;
  if (job.human) {
    const h = job.human;
    return { pose: { feet: { x: h.eye.x, y: h.eye.y - eyeHeight, z: h.eye.z }, yaw: h.yaw, pitch: h.pitch }, preset: h.preset, fov: h.fov, boom: presetOf(ctx.player, h.preset).boom };
  }
  const from = job.from as { x: number; y?: number; z: number };
  const feet = { x: from.x, y: from.y ?? ctx.surfaceY(from.x, from.z), z: from.z };
  const eye = { ...feet, y: feet.y + eyeHeight };
  let look = { yaw: job.yaw ?? ctx.editor.yaw, pitch: job.pitch ?? 0 };
  if (job.at !== undefined) {
    let target: Vec3;
    if (typeof job.at === "string") {
      const b = boundsOf(drawnShapes(ctx.nodes, job.at));
      target = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
    } else target = job.at;
    look = lookAt(eye, target);
  }
  const preset = job.preset ?? "first";
  const { fov, boom } = presetOf(ctx.player, preset);
  return { pose: { feet, ...look }, preset, fov, boom };
}

/** One frame from an eye: its capture (with the avatar in third person) and its camera. */
async function eyeFrame(e: Eye, width: number, height: number, ctx: RenderContext): Promise<{ image: Blob; camera: ShotCamera }> {
  const p = ctx.player;
  const wc = walkCamera(e.pose, p.eyeHeight, e.preset, e.boom);
  const eye = eyeOf(e.pose, p.eyeHeight);
  const ahead = lookDir(e.pose.yaw, 0);
  const view: CaptureView = {
    ...wc,
    vfov: verticalFov(e.fov, width / height),
    light: { focus: { x: eye.x + ahead.x * 10, z: eye.z + ahead.z * 10 }, yaw: e.pose.yaw, distance: 40 },
  };
  const third = e.preset === "third";
  const extra = third && p.third.avatar ? avatarShapes(ctx.avatarEntity, p.eyeHeight, { ...e.pose.feet, rotation: e.pose.yaw }) : [];
  const image = await ctx.capture(view, width, height, { notes: false, lines: true }, extra);
  return { image, camera: { kind: "walk", preset: e.preset, eye, yaw: e.pose.yaw, pitch: e.pose.pitch, fov: e.fov, ...(third ? { boom: e.boom } : {}) } };
}

/** A walk's feet along its path: a line's or a ramp's (their points carry their height), or points given. */
function walkPath(job: RenderJob, ctx: RenderContext): Vec3[] {
  if (typeof job.path === "string") {
    const node = ctx.nodes.find((n) => n.id === job.path);
    if (node?.type === "line") return polyline(node);
    if (node?.type === "ramp") return rampStations(node).map((s) => ({ x: s.x, y: s.y, z: s.z }));
    throw new Error(`path: ${job.path} isn't a line or a ramp.`);
  }
  return (job.path ?? []).map((p) => ({ x: p.x, y: p.y ?? ctx.surfaceY(p.x, p.z), z: p.z }));
}

/** An image being put together: captures drawn into cells, then labels, captions and plan marks on top. */
function compose(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  const font = (px: number, weight = 600) => `${weight} ${px}px system-ui, -apple-system, sans-serif`;
  const pill = (text: string, x: number, y: number, px: number, fill: string, color: string) => {
    g.font = font(px);
    const w = g.measureText(text).width + px * 0.9;
    const h = px * 1.5;
    g.fillStyle = fill;
    g.beginPath();
    g.roundRect(x, y, w, h, h / 2);
    g.fill();
    g.fillStyle = color;
    g.textBaseline = "middle";
    g.fillText(text, x + px * 0.45, y + h / 2);
    return { w, h };
  };

  return {
    async draw(png: Blob, cell: Cell) {
      const bitmap = await createImageBitmap(png);
      g.drawImage(bitmap, cell.x, cell.y, cell.width, cell.height);
      bitmap.close();
    },

    /** Letter labels at each target's top center, as the camera sees it (nudged down when they'd overlap). */
    labels(targets: LabelTarget[], camera: THREE.Camera, cell: Cell) {
      const px = Math.max(11, Math.round(cell.width / 42));
      const placed: { x: number; y: number }[] = [];
      g.save();
      g.beginPath();
      g.rect(cell.x, cell.y, cell.width, cell.height);
      g.clip();
      for (const t of targets) {
        const v = new THREE.Vector3(t.anchor.x, t.anchor.y, t.anchor.z).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        let x = cell.x + ((v.x + 1) / 2) * cell.width;
        let y = cell.y + ((1 - v.y) / 2) * cell.height;
        if (x < cell.x || x > cell.x + cell.width || y < cell.y || y > cell.y + cell.height) continue;
        for (let k = 0; k < 6 && placed.some((p) => Math.abs(p.x - x) < px * 1.6 && Math.abs(p.y - y) < px * 1.5); k++) y += px * 1.5;
        placed.push({ x, y });
        g.font = font(px, 700);
        const w = g.measureText(t.tag).width + px * 0.8;
        x -= w / 2;
        pill(t.tag, x, y - px * 0.75, px, "rgba(20, 22, 28, 0.85)", "#fff");
      }
      g.restore();
    },

    /** A caption in a cell's top left corner. */
    caption(text: string, cell: Cell) {
      const px = Math.max(11, Math.round(cell.width / 40));
      pill(text, cell.x + px * 0.6, cell.y + px * 0.6, px, "rgba(20, 22, 28, 0.72)", "#fff");
    },

    /** Lines between cells. */
    dividers(cells: Cell[]) {
      g.fillStyle = "#ffffff";
      for (const c of cells) {
        if (c.x > 0) g.fillRect(c.x - 1, c.y, 2, c.height);
        if (c.y > 0) g.fillRect(c.x, c.y - 1, c.width, 2);
      }
    },

    /** A plan's grid (returns its step in meters), scale bar and north arrow. */
    planOverlay(frame: { x: number; z: number; width: number; height: number }, cell: Cell): number {
      const step = niceLength(Math.max(frame.width, frame.height) / 10);
      const left = frame.x - frame.width / 2;
      const top = frame.z - frame.height / 2;
      const sx = (x: number) => cell.x + ((x - left) / frame.width) * cell.width;
      const sy = (z: number) => cell.y + ((z - top) / frame.height) * cell.height;
      g.save();
      g.strokeStyle = "rgba(30, 32, 38, 0.13)";
      g.lineWidth = 1;
      g.beginPath();
      for (let x = Math.ceil(left / step) * step; x <= left + frame.width; x += step) {
        g.moveTo(Math.round(sx(x)) + 0.5, cell.y);
        g.lineTo(Math.round(sx(x)) + 0.5, cell.y + cell.height);
      }
      for (let z = Math.ceil(top / step) * step; z <= top + frame.height; z += step) {
        g.moveTo(cell.x, Math.round(sy(z)) + 0.5);
        g.lineTo(cell.x + cell.width, Math.round(sy(z)) + 0.5);
      }
      g.stroke();
      // The scale bar, bottom left.
      const px = Math.max(11, Math.round(cell.width / 45));
      const bar = niceLength(frame.width / 5);
      const barPx = (bar / frame.width) * cell.width;
      const bx = cell.x + px;
      const by = cell.y + cell.height - px * 1.4;
      g.fillStyle = "rgba(20, 22, 28, 0.85)";
      g.fillRect(bx, by, barPx, Math.max(3, px / 4));
      g.font = font(px);
      g.textBaseline = "bottom";
      g.fillText(`${bar} m`, bx, by - 3);
      // North, top right.
      g.textBaseline = "top";
      g.textAlign = "right";
      g.fillText("N ↑", cell.x + cell.width - px * 0.7, cell.y + px * 0.6);
      g.restore();
      return step;
    },

    /** A section's outlines over a plan cell (14.7): a pale wash, then the solids bold, holes dashed and gaps in red. */
    section(section: RenderSection, frame: { x: number; z: number; width: number; height: number }, cell: Cell) {
      const left = frame.x - frame.width / 2;
      const top = frame.z - frame.height / 2;
      const sx = (x: number) => cell.x + ((x - left) / frame.width) * cell.width;
      const sy = (z: number) => cell.y + ((z - top) / frame.height) * cell.height;
      g.save();
      g.beginPath();
      g.rect(cell.x, cell.y, cell.width, cell.height);
      g.clip();
      g.fillStyle = "rgba(255, 255, 255, 0.55)";
      g.fillRect(cell.x, cell.y, cell.width, cell.height);
      for (const o of section.outlines) {
        g.strokeStyle = o.hole ? "rgba(40, 90, 200, 0.9)" : "rgba(20, 22, 28, 0.95)";
        g.lineWidth = o.hole ? 1.5 : 2.5;
        g.setLineDash(o.hole ? [5, 4] : []);
        g.fillStyle = "rgba(20, 22, 28, 0.12)";
        g.beginPath();
        for (const loop of o.loops) {
          loop.forEach((p, k) => (k === 0 ? g.moveTo(sx(p.x), sy(p.z)) : g.lineTo(sx(p.x), sy(p.z))));
        }
        if (!o.hole) g.fill("evenodd");
        g.stroke();
      }
      g.setLineDash([]);
      const px = Math.max(11, Math.round(cell.width / 45));
      for (const gap of section.gaps) {
        const [x, y] = [sx(gap.at.x), sy(gap.at.z)];
        const r = Math.max(px * 0.9, (gap.width / frame.width) * cell.width);
        g.strokeStyle = "#e0342b";
        g.lineWidth = 3;
        g.beginPath();
        g.arc(x, y, r, 0, 2 * Math.PI);
        g.stroke();
        pill(`${gap.width} m`, x + r + 3, y - px * 0.75, px, "#e0342b", "#fff");
      }
      g.restore();
    },

    async result(text: string, camera?: ShotCamera): Promise<RenderResult> {
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image came back empty"))), "image/png"));
      return { image: await blobToBase64(png), width, height, text, ...(camera ? { camera } : {}) };
    },
  };
}

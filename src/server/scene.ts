import type { z } from "zod";
import {
  boundsOf,
  footprintBounds,
  isFootprinted,
  mirrorAcross,
  moveShape,
  isClosed,
  isTilted,
  normalizeDeg,
  lineProblem,
  outlineProblem,
  rotateAround,
  round2,
  rampProblem,
  roundPoints,
  spiralLinePoints,
  spiralPoints,
  sameValue,
  toFreeformPoints,
} from "../shared/geometry";
import {
  ArrayLayoutInputSchema,
  MIN_ARRAY_SPACING,
  type ArrayEntity,
  type ArrayLayout,
  type ArrayNode,
  type Follow,
  ConvertNodesSchema,
  DEFAULT_COLOR,
  DEFAULT_WALL,
  DEFAULT_NOTE_COLOR,
  DEFAULT_RAMP_WIDTH,
  DEFAULT_HEIGHT,
  DEFAULT_LINE_COLOR,
  DEFAULT_THICKNESS,
  DEFAULT_VIEW,
  DuplicateNodesSchema,
  GroupNodesSchema,
  MIN_HEIGHT,
  MIN_WALL,
  MIN_RAMP_WIDTH,
  MIN_STEP,
  KIND_FIELDS,
  MirrorNodesSchema,
  MoveNodesSchema,
  NodeUpdateSchema,
  PasteNodesSchema,
  PlaceNodesSchema,
  RotateNodesSchema,
  ShapeInputSchema,
  SNAP,
  UngroupSchema,
  type Actor,
  type KindField,
  type RampBase,
  type RampPoint,
  type ShapeKind,
  type Box,
  type ClosedShape,
  type Cylinder,
  type Freeform,
  type LinePoint,
  type Shape,
  type FootPoint,
  type ShapePatch,
  type Group,
  type HistorySummary,
  type Instance,
  type NodePatch,
  type NodeUpdate,
  type Scene,
  type SceneNode,
  type ShapeInput,
  type View,
} from "../shared/scene.types";
import { firstIds, type NextId } from "../shared/project.types";
import { arrayItems, followPath, isFollowing, tidyArrayPatch, withFollowed } from "../shared/arrays";
import { definitionOf, expandInstance } from "../shared/entities";
import { shapesUnder, commonParent, copyNodes, isShape, isGroup, subtreeIds, topmost } from "../shared/tree";
import { applyOp, createHistory, invertOp, runOps, type History, type HistoryEntry, type Op } from "./commands";

export class SceneError extends Error {}

/**
 * A `draw_shapes` entry with its batch refs resolved (plan 13 §6): every `$name` in a field that takes an ID
 * (`parent`, `layout.along.id`) becomes what `lookup` gives for `name`.
 */
function resolveBatchRefs(input: ShapeInput, lookup: (ref: string, where: string) => string): ShapeInput {
  const resolve = (value: unknown, where: string) => (typeof value === "string" && value.startsWith("$") ? lookup(value.slice(1), where) : value);
  const out = { ...input } as Record<string, unknown>;
  if ("parent" in out) out.parent = resolve(out.parent, "parent");
  const layout = out.layout as { along?: { id?: unknown } } | undefined;
  if (layout?.along?.id !== undefined) out.layout = { ...layout, along: { ...layout.along, id: resolve(layout.along.id, "layout.along.id") } };
  delete out.ref;
  return out as ShapeInput;
}

/** A change to the nodes that the history records: a new step, or moving through the existing ones. */
export type Step = { type: "commit"; entry: HistoryEntry } | { type: "undo"; entry: HistoryEntry } | { type: "redo"; entry: HistoryEntry };

/** What Make entity prepares (see the store's `prepareEntity`). */
export type PreparedEntity = {
  nodes: SceneNode[];
  pivot: { x: number; y: number; z: number };
  remove: string[];
  parent?: string;
  index: number;
  from?: { name?: string; description?: string; tags?: string[] };
};

/** `{ tags }` when there are any, for spreading into a node. */
const withTags = (tags: string[] | undefined) => (tags && tags.length > 0 ? { tags } : {});

/** Degrees in 0..360, 2 decimals. */
const normalizeRotation = (deg: number) => round2(normalizeDeg(deg)) % 360;

/** "box_3", "box_4, group_1" or "5 nodes". */
const listIds = (ids: string[], plural = "nodes") => (ids.length <= 3 ? ids.join(", ") : `${ids.length} ${plural}`);

/** "Draw box_3", or for the agent "Agent: draw box_4, box_5". Same shape for every label. */
function label(verb: string, what: string, actor: Actor): string {
  const text = `${verb} ${what}`;
  return actor === "agent" ? `Agent: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

/** "lobby (group_1)" for one named node, else as `listIds`. */
function describeIds(nodes: SceneNode[], ids: string[]): string {
  const name = ids.length === 1 ? nodes.find((n) => n.id === ids[0])?.name : undefined;
  return name ? `${name} (${ids[0]})` : listIds(ids);
}

/** What a group's update can change: it has no shape fields. */
const GROUP_FIELDS: readonly string[] = ["name", "description", "tags", "parent", "locked", "hidden"];

const FIELD_VERBS: Record<keyof NodePatch, string> = {
  name: "rename",
  description: "describe",
  tags: "tag",
  parent: "regroup",
  kind: "change kind of",
  x: "move",
  z: "move",
  y: "change elevation of",
  width: "resize",
  depth: "resize",
  height: "change height of",
  rotation: "rotate",
  color: "recolor",
  sides: "change sides of",
  wall: "change walls of",
  taper: "taper",
  bevel: "bevel",
  pitch: "tilt",
  roll: "tilt",
  points: "reshape",
  thickness: "restyle",
  dashed: "restyle",
  arrow: "restyle",
  step: "change steps of",
  base: "restyle",
  locked: "lock",
  hidden: "hide",
  text: "edit",
  label: "label",
  status: "change status of",
  entity: "swap",
  entities: "change entities of",
  layout: "change layout of",
  facing: "turn items of",
  jitter: "jitter",
  turnJitter: "jitter",
  seed: "reroll",
  skip: "skip items of",
};

/** What an array's update can change (plan 10 §9): its items come from these. */
const ARRAY_FIELDS: readonly string[] = ["name", "parent", "locked", "hidden", "entities", "layout", "facing", "rotation", "jitter", "turnJitter", "seed", "skip"];
/** The fields only an array has. */
const ARRAY_ONLY = ["entities", "layout", "facing", "jitter", "turnJitter", "seed", "skip"] as const;

/** What a kind-specific field is called in errors ("only a room has walls"). */
const KIND_FIELD_NOUNS: Record<KindField, string> = { wall: "walls", taper: "a taper", bevel: "a bevel", pitch: "a pitch", roll: "a roll" };
const kindFieldProblem = (f: KindField, kind: ShapeKind) => `only a ${KIND_FIELDS[f].join(" or a ")} has ${KIND_FIELD_NOUNS[f]} (this is a ${kind})`;
const kindAllows = (f: KindField, kind: ShapeKind) => (KIND_FIELDS[f] as readonly ShapeKind[]).includes(kind);

/**
 * One verb when every change is the same kind of edit ("move", "recolor"), "edit" otherwise. A kind change that
 * drops the fields the new kind doesn't have (a room's `wall`) is still "change kind of".
 */
function updateVerb(patches: NodePatch[]): string {
  const dropped = (p: NodePatch, k: string) => "kind" in p && k in KIND_FIELDS && p[k as KindField] === undefined;
  const keys = (p: NodePatch) => Object.keys(p).filter((k) => !dropped(p, k));
  const verb = (p: NodePatch, k: string) =>
    k === "locked" && p.locked === undefined ? "unlock" : k === "hidden" && p.hidden === undefined ? "show" : FIELD_VERBS[k as keyof NodePatch];
  const verbs = new Set(patches.flatMap((p) => keys(p).map((k) => verb(p, k))));
  return verbs.size === 1 ? [...verbs][0] : "edit";
}

/** Turns zod issues into "changes[1].height: ..." lines. */
function issueLines(prefix: string, issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => `${prefix}.${issue.path.map(String).join(".") || "(item)"}: ${issue.message}`);
}

/** Parses with a zod schema or throws a SceneError listing every issue. */
function parse<T extends z.ZodType>(schema: T, input: unknown, failure: string): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new SceneError(`${failure}\n${issueLines("", result.error.issues).map((l) => l.slice(1)).join("\n")}`);
  return result.data;
}

/**
 * `resolveTag` finds a tag in the project library by its name or an alias and returns its current name, or
 * undefined for no such tag (the default: no library, so no tags).
 */
export function createSceneStore({
  resolveTag = () => undefined,
  entityName = (id) => (definitionOf(id) ? id : undefined),
}: {
  resolveTag?: (name: string) => string | undefined;
  /** An entity's name by its ID, or undefined for no such entity (the default: any entity with a definition). */
  entityName?: (id: string) => string | undefined;
} = {}) {
  const scene: Scene = { view: { ...DEFAULT_VIEW }, selection: [], nodes: [] };
  const listeners = new Set<(scene: Scene) => void>();
  const stepListeners = new Set<(step: Step) => void>();
  // Only go up, so IDs are never reused.
  const nextId: NextId = firstIds();

  let history = createHistory();
  // What the store holds: a scene, or an entity's definition (08.5), which can't hold notes or instances.
  let document: "scene" | "entity" = "scene";
  const entityProblem = (n: { type?: string }) =>
    document === "entity" && (n.type === "note" || n.type === "instance" || n.type === "array")
      ? `an entity can't hold ${n.type === "note" ? "notes (put them in the scene)" : n.type === "array" ? "arrays (no nested entities)" : "instances (no nested entities)"}`
      : null;

  /** The next ID for a new node of `type`. */
  const newId = (type: SceneNode["type"]) => `${type}_${nextId[type]++}`;

  /** Tells step listeners (persistence) first, so a step is on disk before anyone sees it. */
  const step = (s: Step) => stepListeners.forEach((l) => l(s));

  /**
   * A `draw_shapes` batch's entries already built (plan 13 §6), with the IDs they'll get: while the batch is checked,
   * later entries see them as if they were in the scene (a group to draw into, a line to follow). Empty otherwise.
   */
  let pending: SceneNode[] = [];
  const byId = () => new Map([...scene.nodes, ...pending].map((n) => [n.id, n]));

  /** Tags as stored: each resolved to its current name, in order, each once; none = undefined. Unknown ones are errors. */
  const tagList = (prefix: string, tags: string[] | null | undefined, errors: string[]): string[] | undefined => {
    if (!tags) return undefined;
    const missing = tags.filter((t) => !resolveTag(t));
    if (missing.length > 0) {
      errors.push(`${prefix}.tags: no tag ${missing.map((t) => `#${t.replace(/^#/, "")}`).join(", ")} in the project library (add it with update_library first)`);
    }
    const names = [...new Set(tags.flatMap((t) => resolveTag(t) ?? []))];
    return names.length > 0 ? names : undefined;
  };

  /** After every change to the nodes: drop selected IDs that no longer exist, then broadcast. */
  const emit = () => {
    const ids = new Set(scene.nodes.map((n) => n.id));
    scene.selection = scene.selection.filter((id) => ids.has(id));
    listeners.forEach((l) => l(scene));
  };

  /**
   * The single path for edits: apply ops, record one undo step, broadcast. Groups the ops leave empty are removed
   * as part of the same step (a group never outlives its contents).
   */
  const commit = (label: string, actor: Actor, ops: Op[]) => {
    const all = [...ops];
    let { nodes, inverse } = runOps(scene.nodes, ops);
    // Arrays that follow a node (10.3) take its path as it is now, in the same step: a follower whose target is
    // gone is unlinked, keeping the path it had.
    const follow = refollow(nodes);
    if (follow) {
      inverse = [invertOp(nodes, follow), ...inverse];
      nodes = applyOp(nodes, follow);
      all.push(follow);
    }
    for (;;) {
      const empty = nodes.filter((n) => isGroup(n) && !nodes.some((c) => c.parent === n.id)).map((n) => n.id);
      if (empty.length === 0) break;
      const prune: Op = { op: "remove", ids: empty };
      inverse = [invertOp(nodes, prune), ...inverse];
      nodes = applyOp(nodes, prune);
      all.push(prune);
    }
    scene.nodes = nodes;
    const entry: HistoryEntry = { label, actor, at: Date.now(), ops: all, inverse };
    history.push(entry);
    step({ type: "commit", entry });
    emit();
  };

  /** The update that brings every following array's path up to date with what it follows, or null if none changed. */
  const refollow = (nodes: SceneNode[]): Op | null => {
    const byIdNow = new Map(nodes.map((n) => [n.id, n]));
    const changes: { id: string; patch: NodePatch }[] = [];
    for (const n of nodes) {
      if (!isFollowing(n)) continue;
      if (!byIdNow.has(n.layout.along.id)) {
        const { along: _along, ...unlinked } = n.layout;
        changes.push({ id: n.id, patch: { layout: unlinked } });
        continue;
      }
      const next = withFollowed(n, (id) => byIdNow.get(id));
      if (next !== n) changes.push({ id: n.id, patch: { layout: next.layout } });
    }
    return changes.length > 0 ? { op: "update", changes } : null;
  };

  /**
   * Copies' follows (10.3): a copied array that follows a node copied with it follows the copy; one copied without
   * its target is unlinked (it keeps its path, moved with the copy).
   */
  const relinkCopies = (source: SceneNode[], copies: SceneNode[]): SceneNode[] => {
    const ids = new Map(source.map((n, i) => [n.id, copies[i].id]));
    return copies.map((c) => {
      if (!isFollowing(c)) return c;
      const to = ids.get(c.layout.along.id);
      if (to) return { ...c, layout: { ...c.layout, along: { ...c.layout.along, id: to } } };
      const { along: _along, ...unlinked } = c.layout;
      return { ...c, layout: unlinked };
    });
  };

  /**
   * The shapes a move, turn or mirror acts on, without following arrays (their paths come from what they follow, so
   * they go where it goes). Refused when an array that follows something that isn't moving is named on its own.
   */
  const withoutFollowers = (ids: string[], boxes: Shape[], what: string): Shape[] => {
    const moving = new Set(boxes.map((b) => b.id));
    const stuck = boxes.filter((b) => isFollowing(b) && ids.includes(b.id) && !moving.has(b.layout.along.id));
    if (stuck.length > 0) {
      const a = stuck[0] as ArrayNode & { layout: { along: Follow } };
      throw new SceneError(
        `${a.id} follows ${a.layout.along.id}, so it goes where ${a.layout.along.id} goes: ${what} ${a.layout.along.id}, or unlink it first (update_nodes layout: { along: null }). Nothing changed.`,
      );
    }
    return boxes.filter((b) => !isFollowing(b));
  };

  /** Errors for IDs that don't exist or repeat. `prefix` is e.g. "ids". */
  const checkIds = (prefix: string, ids: string[], errors: string[]) => {
    const nodes = byId();
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (!nodes.has(id)) errors.push(`${prefix}[${i}]: no node "${id}"`);
      if (seen.has(id)) errors.push(`${prefix}[${i}]: "${id}" appears more than once`);
      seen.add(id);
    });
  };

  const failIf = (errors: string[], what: string) => {
    if (errors.length > 0) throw new SceneError(`${what}\n${errors.join("\n")}`);
  };

  /** An error message if `parent` can't hold nodes (unknown, or not a group), else null. */
  const parentError = (parent: string) => {
    const node = byId().get(parent);
    if (!node) return `no group "${parent}"`;
    if (!isGroup(node)) return `"${parent}" is a ${node.type}, not a group`;
    return null;
  };

  /** Reports sizes that fall out of range once rounded to 2 decimals. */
  const checkSizes = (prefix: string, r: { width?: number; depth?: number; height?: number }, errors: string[]) => {
    if (r.width !== undefined && round2(r.width) <= 0) errors.push(`${prefix}.width: ${r.width} rounds to 0 at 2 decimals`);
    if (r.depth !== undefined && round2(r.depth) <= 0) errors.push(`${prefix}.depth: ${r.depth} rounds to 0 at 2 decimals`);
    if (r.height !== undefined && round2(r.height) < MIN_HEIGHT) {
      errors.push(`${prefix}.height: ${r.height} rounds below ${MIN_HEIGHT} at 2 decimals`);
    }
  };

  /** A wall thickness as stored: 2 decimals, and none (undefined) for the default. */
  const wallValue = (prefix: string, wall: number, errors: string[]) => {
    const w = round2(wall);
    if (w < MIN_WALL) errors.push(`${prefix}: ${wall} rounds below ${MIN_WALL} at 2 decimals`);
    return w === DEFAULT_WALL ? undefined : w;
  };

  /** A pitch or roll as stored: degrees in -180..180, 2 decimals, and none (undefined) for 0. */
  const angle = (v: number | undefined) => {
    if (v === undefined) return undefined;
    const a = round2(normalizeDeg(v + 180) - 180);
    return a === 0 ? undefined : a === -180 ? 180 : a;
  };

  /** A taper or bevel as stored: 2 decimals, and none (undefined) for 0. */
  const fraction = (v: number | undefined) => (v === undefined || round2(v) === 0 ? undefined : round2(v));

  /** A free-form's points rounded to 2 decimals, or an error (as `prefix: ...`) if the outline isn't valid. */
  const checkPoints = (prefix: string, points: FootPoint[], errors: string[]) => {
    const rounded = roundPoints(points);
    const problem = outlineProblem(rounded);
    if (problem) errors.push(`${prefix}.points: ${problem}`);
    return rounded;
  };

  /**
   * Converts boxes and cylinders into free-forms with the same outline, as one step (see `convertNodes`). `prefix`
   * names the input in errors ("ids", or "changes" for update_nodes).
   */
  const convert = (ids: string[], actor: Actor, prefix: string): Freeform[] => {
    const errors: string[] = [];
    checkIds(prefix, ids, errors);
    const nodes = byId();
    const sources = ids.map((id, i) => {
      const node = nodes.get(id);
      if (node && node.type !== "box" && node.type !== "cylinder") {
        errors.push(`${prefix}[${i}]: "${id}" is a ${node.type}; only boxes and cylinders convert to free-forms`);
      } else if (node && isTilted(node)) {
        errors.push(`${prefix}[${i}]: "${id}" is tilted, and a free-form can't be; set its pitch and roll to 0 first`);
      }
      return node as Box | Cylinder;
    });
    const outlines = sources.map((n, i) =>
      n?.type === "box" || n?.type === "cylinder" ? checkPoints(`${prefix}[${i}]`, toFreeformPoints(n), errors) : [],
    );
    failIf(errors, "Nothing was converted.");

    const made = sources.map(
      (n, i): Freeform => ({
        id: newId("freeform"),
        type: "freeform",
        ...(n.name !== undefined ? { name: n.name } : {}),
        ...withTags(n.tags),
        ...(n.parent !== undefined ? { parent: n.parent } : {}),
        kind: n.kind,
        y: n.y,
        height: n.height,
        color: n.color,
        ...(n.wall !== undefined ? { wall: n.wall } : {}),
        ...(n.taper !== undefined ? { taper: n.taper } : {}),
        ...(n.bevel !== undefined ? { bevel: n.bevel } : {}),
        points: outlines[i],
        createdBy: n.createdBy,
      }),
    );
    // Each takes its original's place in the list.
    const indices = ids.map((id) => scene.nodes.findIndex((n) => n.id === id));
    const to = listIds(
      made.map((n) => n.id),
      "free-forms",
    );
    // Arrays following a converted shape follow its free-form (10.3).
    const newIds = new Map(ids.map((id, i) => [id, made[i].id]));
    const relink = scene.nodes.filter(isFollowing).filter((a) => newIds.has(a.layout.along.id));
    commit(label("convert", `${listIds(ids)} to ${to}`, actor), actor, [
      { op: "remove", ids },
      { op: "add", nodes: made, indices },
      ...(relink.length > 0
        ? [{ op: "update" as const, changes: relink.map((a) => ({ id: a.id, patch: { layout: { ...a.layout, along: { ...a.layout.along, id: newIds.get(a.layout.along.id)! } } } })) }]
        : []),
    ]);
    return made;
  };

  /**
   * A ramp's path and shape as stored (points, width and step rounded to 2 decimals, a smooth ramp with no step),
   * or an error (as `prefix: ...`) if it isn't valid.
   */
  const checkRamp = (prefix: string, r: { points: RampPoint[]; width: number; step?: number; base: RampBase }, errors: string[]) => {
    const points = roundPoints(r.points).map(({ in: i, out: o, ...p }) => ({
      ...p,
      ...(i ? { in: { x: i.x, z: i.z } } : {}),
      ...(o ? { out: { x: o.x, z: o.z } } : {}),
    }));
    const width = round2(r.width);
    const step = r.step === undefined ? undefined : round2(r.step);
    if (width < MIN_RAMP_WIDTH) errors.push(`${prefix}.width: ${r.width} rounds below ${MIN_RAMP_WIDTH} at 2 decimals`);
    if (step !== undefined && step < MIN_STEP) errors.push(`${prefix}.step: ${r.step} rounds below ${MIN_STEP} at 2 decimals`);
    const shape = { points, width, ...(step !== undefined ? { step } : {}), base: r.base };
    if (points.length >= 2 && width >= MIN_RAMP_WIDTH) {
      const problem = rampProblem({ id: "", type: "ramp", kind: "volume", color: DEFAULT_COLOR, createdBy: "agent", ...shape });
      if (problem) errors.push(`${prefix}: ${problem}`);
    }
    return shape;
  };

  /** A line's points rounded to 2 decimals, or an error (as `prefix: ...`) if the path isn't valid. */
  const checkLinePoints = (prefix: string, points: LinePoint[], errors: string[]) => {
    const rounded = roundPoints(points);
    const problem = lineProblem(rounded);
    if (problem) errors.push(`${prefix}.points: ${problem}`);
    return rounded;
  };

  /** An entity's width (its definition's extent along x), or 1 when it has no shapes. */
  const entityWidth = (id: string) => {
    const shapes = (definitionOf(id) ?? []).filter(isShape);
    if (shapes.length === 0) return 1;
    const b = boundsOf(shapes);
    return b.maxX - b.minX || 1;
  };

  /**
   * An array's defaults: along a path, 1.5 × its first entity's width apart (at least MIN_ARRAY_SPACING); scattered,
   * its widest entity's width apart.
   */
  const arrayDefaults = (entities: { entity: string }[]) => ({
    spacing: Math.max(MIN_ARRAY_SPACING, round2(entityWidth(entities[0]?.entity ?? "") * 1.5)),
    minDistance: round2(Math.max(0, ...entities.map((e) => entityWidth(e.entity)))),
  });
  const defaultSpacing = (entity: string) => arrayDefaults([{ entity }]).spacing;

  /**
   * An array's layout as stored (plan 10 §3), from its input: rounded to 2 decimals, angles in 0..360, defaults left
   * out (a full sweep, one layer, no stagger), a path's `place` from what's given (count → count, else spacing), and
   * only the number its place uses. Errors go in `errors` as `prefix: ...`.
   */
  const arrayLayoutFrom = (
    prefix: string,
    d: z.output<typeof ArrayLayoutInputSchema>,
    fallback: { spacing: number; minDistance: number },
    errors: string[],
  ): ArrayLayout => {
    const turn = (v: number | undefined) => (v === undefined || normalizeRotation(v) === 0 ? {} : { value: normalizeRotation(v) });
    if (d.type === "path") {
      // A following path takes its points (and whether it's closed) from what it follows.
      let points: LinePoint[] = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
      ];
      let closed = !!d.closed;
      let along: Follow | undefined;
      if (d.along) {
        along = { id: d.along.id, ...(d.along.at === "bottom" ? { at: "bottom" as const } : {}), ...(d.along.offset !== undefined ? { offset: round2(d.along.offset) } : {}) };
        const f = followPath(byId().get(along.id), along);
        if ("problem" in f) errors.push(`${prefix}.along: ${f.problem}`);
        else [points, closed] = [f.points, f.closed];
      } else if (d.spiral) points = spiralLinePoints(d.spiral);
      else if (d.points) points = checkLinePoints(prefix, d.points, errors);
      else errors.push(`${prefix}: give a path points, a spiral or along (a node to follow)`);
      if (!along && closed && points.length < 3) errors.push(`${prefix}.closed: a closed path needs at least 3 points`);
      const place = d.place ?? (d.count !== undefined && d.spacing === undefined ? "count" : "spacing");
      if (place === "count" && d.count === undefined) errors.push(`${prefix}.count: place: count needs a count`);
      const spacing = round2(d.spacing ?? fallback.spacing);
      if (place === "spacing" && spacing < MIN_ARRAY_SPACING) errors.push(`${prefix}.spacing: ${d.spacing} rounds below ${MIN_ARRAY_SPACING} at 2 decimals`);
      return {
        type: "path",
        points,
        ...(closed ? { closed: true as const } : {}),
        ...(along ? { along } : {}),
        place,
        ...(place === "spacing" ? { spacing } : {}),
        ...(place === "count" ? { count: d.count ?? 1 } : {}),
      };
    }
    if (d.type === "circle") {
      const radius = round2(d.radius);
      if (radius <= 0) errors.push(`${prefix}.radius: ${d.radius} rounds to 0 at 2 decimals`);
      const start = turn(d.start);
      const sweep = d.sweep === undefined || round2(d.sweep) >= 360 ? undefined : round2(d.sweep);
      if (sweep !== undefined && sweep <= 0) errors.push(`${prefix}.sweep: ${d.sweep} rounds to 0 at 2 decimals`);
      return {
        type: "circle",
        x: round2(d.x),
        y: round2(d.y ?? 0),
        z: round2(d.z),
        radius,
        count: d.count,
        ...("value" in start ? { start: start.value } : {}),
        ...(sweep !== undefined ? { sweep } : {}),
        ...(d.rise !== undefined && round2(d.rise) !== 0 ? { rise: round2(d.rise) } : {}),
      };
    }
    if (d.type === "scatter") {
      const circle = d.x !== undefined || d.z !== undefined || d.radius !== undefined;
      if (circle === (d.area !== undefined)) errors.push(`${prefix}: give a scatter either x, z and radius (a circle) or area (an outline), one of them`);
      else if (circle && (d.x === undefined || d.z === undefined || d.radius === undefined)) errors.push(`${prefix}: a scatter in a circle needs x, z and radius`);
      const radius = d.radius === undefined ? undefined : round2(d.radius);
      if (radius !== undefined && radius <= 0) errors.push(`${prefix}.radius: ${d.radius} rounds to 0 at 2 decimals`);
      const rotation = turn(d.rotation);
      const minDistance = round2(d.minDistance ?? fallback.minDistance);
      return {
        type: "scatter",
        y: round2(d.y ?? 0),
        ...(d.area ? { area: checkPoints(prefix + ".area", d.area, errors) } : { x: round2(d.x ?? 0), z: round2(d.z ?? 0), radius: radius ?? 1 }),
        count: d.count,
        ...(minDistance > 0 ? { minDistance } : {}),
        ...("value" in rotation ? { rotation: rotation.value } : {}),
      };
    }
    const rotation = turn(d.rotation);
    const spacingY = d.spacing.y === undefined || round2(d.spacing.y) === 0 ? undefined : round2(d.spacing.y);
    if ((d.layers ?? 1) > 1 && spacingY === undefined) errors.push(`${prefix}.spacing.y: a grid with layers needs a spacing.y (meters between layers)`);
    return {
      type: "grid",
      x: round2(d.x),
      y: round2(d.y ?? 0),
      z: round2(d.z),
      ...("value" in rotation ? { rotation: rotation.value } : {}),
      columns: d.columns,
      rows: d.rows,
      ...((d.layers ?? 1) > 1 ? { layers: d.layers } : {}),
      spacing: { x: round2(d.spacing.x), z: round2(d.spacing.z), ...(spacingY !== undefined ? { y: spacingY } : {}) },
      ...(d.stagger ? { stagger: true as const } : {}),
    };
  };

  /** An array's entities as stored: each must exist, weights rounded (1, the default, left out). */
  const arrayEntitiesFrom = (prefix: string, entities: { entity: string; weight?: number }[], errors: string[]): ArrayEntity[] =>
    entities.map((e, i) => {
      if (!entityName(e.entity)) errors.push(`${prefix}[${i}].entity: no entity "${e.entity}" in the project library (get_library lists them)`);
      const weight = e.weight === undefined ? 1 : round2(e.weight);
      if (weight <= 0) errors.push(`${prefix}[${i}].weight: ${e.weight} rounds to 0 at 2 decimals`);
      return { entity: e.entity, ...(weight !== 1 ? { weight } : {}) };
    });

  /** An array's noise and skip list as stored: rounded, none (undefined) for 0 or empty. */
  const arrayNoise = (d: { jitter?: number; turnJitter?: number; seed?: number; skip?: number[] }) => ({
    ...(d.jitter !== undefined ? { jitter: round2(d.jitter) || undefined } : {}),
    ...(d.turnJitter !== undefined ? { turnJitter: round2(d.turnJitter) || undefined } : {}),
    ...(d.seed !== undefined ? { seed: d.seed } : {}),
    ...(d.skip !== undefined ? { skip: d.skip.length > 0 ? [...new Set(d.skip)].sort((a, b) => a - b) : undefined } : {}),
  });

  /**
   * An array's layout after an update: the fields given merge into its layout (a path given `count` alone switches
   * to place: count, `spacing` alone to place: spacing); with another `type`, they're the whole new layout.
   */
  const mergeLayout = (prefix: string, node: ArrayNode, change: NonNullable<NodeUpdate["layout"]>, errors: string[]): ArrayLayout => {
    const { type, ...rest } = change;
    const same = type === undefined || type === node.layout.type;
    const input: Record<string, unknown> = same ? { ...node.layout, ...rest } : { type, ...rest };
    if (same && node.layout.type === "path" && rest.place === undefined) {
      if (rest.count !== undefined) input.place = "count";
      else if (typeof rest.spacing === "number") input.place = "spacing";
    }
    // A path's `along` merges into what it follows (null unlinks it: it keeps the path it has now).
    if (same && node.layout.type === "path" && "along" in rest) {
      if (rest.along === null) delete input.along;
      else {
        const merged: Record<string, unknown> = { ...(node.layout.along ?? {}), ...rest.along };
        if (merged.offset === null) delete merged.offset;
        input.along = merged;
      }
    }
    // A following path's points are its target's (and can be more than a path given as points may have): they
    // come from what it follows, and points given with it are ignored (unlink it first).
    if (input.along) delete input.points;
    // A spiral given to a path replaces its points (and unlinks a following one, as points would be refused).
    if (rest.spiral !== undefined) {
      delete input.points;
      if (!("along" in rest)) delete input.along;
    }
    // A scatter given an area leaves its circle, and given a circle's field leaves its area.
    if (same && node.layout.type === "scatter") {
      if (rest.area !== undefined) for (const k of ["x", "z", "radius"]) if (!(k in rest)) delete input[k];
      if (rest.x !== undefined || rest.z !== undefined || rest.radius !== undefined) {
        if (!("area" in rest)) delete input.area;
        const c = node.layout.area ? footprintBounds({ id: "", type: "freeform", kind: "volume", y: 0, height: 1, color: DEFAULT_COLOR, points: node.layout.area, createdBy: "human" }) : null;
        // From an area, a circle starts around its bounds.
        if (c) {
          input.x ??= round2((c.minX + c.maxX) / 2);
          input.z ??= round2((c.minZ + c.maxZ) / 2);
          input.radius ??= round2(Math.max(c.maxX - c.minX, c.maxZ - c.minZ) / 2);
        }
      }
    }
    const parsed = ArrayLayoutInputSchema.safeParse(input);
    if (!parsed.success) {
      errors.push(...issueLines(prefix, parsed.error.issues));
      return node.layout;
    }
    return arrayLayoutFrom(prefix, parsed.data, { ...arrayDefaults(node.entities), minDistance: node.layout.type === "scatter" ? 0 : arrayDefaults(node.entities).minDistance }, errors);
  };

  /** Drops the keys whose value is undefined (so a stored node doesn't carry them). */
  const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

  /** Shape patches that change something, as update changes. */
  const effectiveShapeChanges = (boxes: Shape[], patches: Record<string, ShapePatch>) =>
    boxes.flatMap((box) => {
      const patch = box.type === "array" && patches[box.id] ? tidyArrayPatch(patches[box.id]) : patches[box.id];
      const changed = patch && (Object.keys(patch) as (keyof ShapePatch)[]).some((k) => !sameValue(patch[k], (box as ShapePatch)[k]));
      return changed ? [{ id: box.id, patch }] : [];
    });

  return {
    getScene(): Scene {
      return scene;
    },

    getHistory(): HistorySummary {
      return history.summary();
    },

    /** The next number for each kind of ID. */
    getNextId(): NextId {
      return { ...nextId };
    },

    /**
     * Replaces the whole scene with a saved one (opening a scene): its nodes, ID counters and history (rebuilt from
     * the log; empty if none), and no selection. Broadcasts; isn't a step.
     */
    /** Whether the store holds a scene or an entity's definition. */
    getDocument: () => document,

    load(saved: { nodes: SceneNode[]; nextId: NextId; history?: History; document?: "scene" | "entity" }): void {
      document = saved.document ?? "scene";
      scene.nodes = saved.nodes;
      scene.selection = [];
      Object.assign(nextId, saved.nextId);
      history = saved.history ?? createHistory();
      emit();
    },

    /**
     * Validates every input first; applies all or nothing. Missing fields get their defaults: a box, the kind's
     * height, y 0, rotation 0, the default color, no name, the top level (and a smooth cylinder).
     */
    drawShapes(inputs: ShapeInput[], actor: Actor): SceneNode[] {
      if (inputs.length === 0) throw new SceneError("shapes: at least one shape is required");

      const errors: string[] = [];
      // Batch refs (plan 13 §6): the ID each entry will get, in order, and `$name` replaced by it where an ID goes.
      const counters = { ...nextId };
      const predicted = inputs.map((input) => {
        const type = ((input as { type?: SceneNode["type"] }).type ?? "box") as SceneNode["type"];
        return `${type}_${counters[type] === undefined ? 0 : counters[type]++}`;
      });
      const refs = new Map<string, string>();
      const resolved = inputs.map((input, i) => {
        const out = resolveBatchRefs(input, (ref, where) => {
          const id = refs.get(ref);
          if (id === undefined) errors.push(`shapes[${i}].${where}: no entry with ref "${ref}" before this one in the batch`);
          return id ?? `$${ref}`;
        });
        const ref = (input as { ref?: string }).ref;
        if (ref !== undefined) {
          if (refs.has(ref)) errors.push(`shapes[${i}].ref: "${ref}" is already an earlier entry's ref in this batch`);
          else refs.set(ref, predicted[i]);
        }
        return out;
      });
      const build = (input: ShapeInput, i: number) => {
        const result = ShapeInputSchema.safeParse(input);
        if (!result.success) {
          errors.push(...issueLines(`shapes[${i}]`, result.error.issues));
          return null;
        }
        const d = result.data;
        const prefix = `shapes[${i}]`;
        if (d.parent !== undefined) {
          const e = parentError(d.parent);
          if (e) errors.push(`${prefix}.parent: ${e}`);
        }
        const name = d.name?.trim();
        if (d.type === "group") {
          return {
            type: "group" as const,
            ...(name ? { name } : {}),
            ...(d.description?.trim() ? { description: d.description.trim() } : {}),
            ...withTags(tagList(prefix, d.tags, errors)),
            ...(d.parent !== undefined ? { parent: d.parent } : {}),
          };
        }
        if (d.type === "line") {
          if ((d.points === undefined) === (d.spiral === undefined)) errors.push(`${prefix}: give a line either points or spiral (one of them)`);
          return {
            type: "line" as const,
            ...(name ? { name } : {}),
            ...(d.parent !== undefined ? { parent: d.parent } : {}),
            color: d.color ?? DEFAULT_LINE_COLOR,
            points: d.spiral ? spiralLinePoints(d.spiral) : checkLinePoints(prefix, d.points ?? [], errors),
            thickness: round2(d.thickness ?? DEFAULT_THICKNESS),
            dashed: d.dashed ?? false,
            arrow: d.arrow ?? "none",
          };
        }
        const inEntity = entityProblem(d);
        if (inEntity) errors.push(`${prefix}: ${inEntity}`);
        if (d.type === "instance") {
          if (!entityName(d.entity)) errors.push(`${prefix}.entity: no entity "${d.entity}" in the project library (get_library lists them)`);
          return {
            type: "instance" as const,
            entity: d.entity,
            ...(name ? { name } : {}),
            ...(d.parent !== undefined ? { parent: d.parent } : {}),
            x: round2(d.x),
            y: round2(d.y ?? 0),
            z: round2(d.z),
            rotation: normalizeRotation(d.rotation ?? 0),
          };
        }
        if (d.type === "array") {
          if ((d.entity === undefined) === (d.entities === undefined)) errors.push(`${prefix}: give an array either entity or entities (one of them)`);
          if (d.layout.type === "path" && [d.layout.points, d.layout.spiral, d.layout.along].filter(Boolean).length > 1) {
            errors.push(`${prefix}.layout: give a path one of points, spiral or along`);
          }
          const entities = arrayEntitiesFrom(`${prefix}.entities`, d.entities ?? (d.entity !== undefined ? [{ entity: d.entity }] : []), errors);
          const layout = arrayLayoutFrom(`${prefix}.layout`, d.layout, arrayDefaults(entities), errors);
          return defined({
            type: "array" as const,
            ...(name ? { name } : {}),
            ...(d.parent !== undefined ? { parent: d.parent } : {}),
            entities,
            layout,
            facing: d.facing,
            rotation: d.rotation === undefined ? undefined : normalizeRotation(d.rotation) || undefined,
            ...arrayNoise(d),
          });
        }
        if (d.type === "note") {
          return {
            type: "note" as const,
            ...(name ? { name } : {}),
            ...(d.parent !== undefined ? { parent: d.parent } : {}),
            x: round2(d.x),
            y: round2(d.y ?? 0),
            z: round2(d.z),
            text: d.text.trim(),
            ...(d.label?.trim() ? { label: d.label.trim() } : {}),
            color: d.color ?? DEFAULT_NOTE_COLOR,
            status: d.status ?? "open",
          };
        }
        if (d.type === "ramp") {
          if ((d.points === undefined) === (d.spiral === undefined)) errors.push(`${prefix}: give a ramp either points or spiral (one of them)`);
          if (d.kind === "hole") errors.push(`${prefix}.kind: a ramp is always a volume, never a hole (to cut under a stair, use a closed shape as the hole)`);
          const points = d.spiral ? spiralPoints(d.spiral) : (d.points ?? []);
          return {
            type: "ramp" as const,
            ...(name ? { name } : {}),
            ...withTags(tagList(prefix, d.tags, errors)),
            ...(d.parent !== undefined ? { parent: d.parent } : {}),
            kind: "volume" as const,
            ...checkRamp(prefix, { points, width: d.width ?? DEFAULT_RAMP_WIDTH, step: d.step, base: d.base ?? "solid" }, errors),
            color: d.color ?? DEFAULT_COLOR,
          };
        }
        const height = d.height ?? DEFAULT_HEIGHT[d.kind];
        checkSizes(prefix, { ...(d.type === "freeform" ? {} : { width: d.width, depth: d.depth }), height }, errors);
        for (const f of Object.keys(KIND_FIELDS) as KindField[]) {
          if ((d as Partial<Record<KindField, number>>)[f] !== undefined && !kindAllows(f, d.kind)) {
            errors.push(`${prefix}.${f}: ${kindFieldProblem(f, d.kind)}`);
          }
        }
        const wall = d.wall !== undefined ? wallValue(`${prefix}.wall`, d.wall, errors) : undefined;
        const taper = fraction(d.taper);
        const bevel = fraction(d.bevel);
        const common = {
          ...(name ? { name } : {}),
          ...withTags(tagList(prefix, d.tags, errors)),
          ...(d.parent !== undefined ? { parent: d.parent } : {}),
          kind: d.kind,
          y: round2(d.y ?? 0),
          height: round2(height),
          color: d.color ?? DEFAULT_COLOR,
          ...(wall !== undefined ? { wall } : {}),
          ...(taper !== undefined ? { taper } : {}),
          ...(bevel !== undefined ? { bevel } : {}),
        };
        if (d.type === "freeform") return { type: "freeform" as const, ...common, points: checkPoints(prefix, d.points, errors) };
        const type = d.type ?? "box";
        if (d.sides !== undefined && type !== "cylinder") errors.push(`${prefix}.sides: only a cylinder has sides (this is a ${type})`);
        return {
          type,
          ...(type === "cylinder" && d.sides !== undefined ? { sides: d.sides } : {}),
          ...common,
          x: round2(d.x),
          z: round2(d.z),
          width: round2(d.width),
          depth: round2(d.depth),
          rotation: normalizeRotation(d.rotation ?? 0),
          ...(angle(d.pitch) !== undefined ? { pitch: angle(d.pitch) } : {}),
          ...(angle(d.roll) !== undefined ? { roll: angle(d.roll) } : {}),
        };
      };
      let valid: ReturnType<typeof build>[];
      try {
        valid = resolved.map((input, i) => {
          const built = build(input, i);
          if (built) pending.push({ id: predicted[i], ...built, createdBy: actor } as SceneNode);
          return built;
        });
      } finally {
        pending = [];
      }
      failIf(errors, "Nothing was drawn.");

      const created = valid.map((b) => ({ id: newId(b!.type), ...b!, createdBy: actor }) as SceneNode);
      const ids = created.map((b) => b.id);
      commit(label("draw", listIds(ids, "shapes"), actor), actor, [{ op: "add", nodes: created }]);
      return created;
    },

    /**
     * Changes existing nodes by ID. A box or cylinder takes any of name, parent, kind, x, z, y, width, depth, height,
     * rotation, color, and a cylinder also sides (null = smooth); a free-form takes name, parent, kind, y, height,
     * color and points (the whole outline); a group takes only name and parent. Validates every change first;
     * applies all or nothing. Fields that don't actually change are dropped, and if nothing is left no step is
     * recorded. An empty name removes the name, and a null (or empty) parent moves the node to the top level.
     * `type: "freeform"` converts a box or cylinder instead (see `convertNodes`): then every change in the call must
     * be a conversion, on its own, and the result is the new free-forms in the same order.
     */
    updateNodes(changes: NodeUpdate[], actor: Actor): SceneNode[] {
      if (changes.length === 0) throw new SceneError("changes: at least one change is required");
      if (changes.some((c) => c.type !== undefined)) {
        const errors: string[] = [];
        changes.forEach((c, i) => {
          const result = NodeUpdateSchema.safeParse(c);
          if (!result.success) return errors.push(...issueLines(`changes[${i}]`, result.error.issues));
          const { id: _id, type, ...others } = result.data;
          const fields = Object.keys(others);
          if (type === undefined) errors.push(`changes[${i}]: a call that converts (type: "freeform") can only convert; update the new free-forms in a second call`);
          else if (fields.length > 0) errors.push(`changes[${i}]: type converts on its own; change ${fields.join(", ")} in a second call, on the new free-form`);
        });
        failIf(errors, "Nothing was changed.");
        return convert(
          changes.map((c) => c.id),
          actor,
          "changes",
        );
      }

      const nodes = byId();
      const seen = new Set<string>();
      const errors: string[] = [];
      const valid = changes.map((change, i) => {
        const result = NodeUpdateSchema.safeParse(change);
        if (!result.success) {
          errors.push(...issueLines(`changes[${i}]`, result.error.issues));
          return null;
        }
        const { id, ...fields } = result.data;
        const node = nodes.get(id);
        if (!node) errors.push(`changes[${i}].id: no node "${id}"`);
        if (seen.has(id)) errors.push(`changes[${i}].id: "${id}" appears more than once`);
        seen.add(id);
        if (Object.keys(fields).length === 0) errors.push(`changes[${i}]: nothing to change`);
        if (node && isGroup(node)) {
          const shapeOnly = Object.keys(fields).filter((k) => !GROUP_FIELDS.includes(k));
          if (shapeOnly.length > 0) {
            errors.push(`changes[${i}]: "${id}" is a group; only name, description, parent, locked and hidden can change (not ${shapeOnly.join(", ")})`);
          }
        } else if (node) {
          if (fields.description !== undefined) errors.push(`changes[${i}].description: only a group has a description ("${id}" is a ${node.type})`);
          if (fields.tags !== undefined && node.type === "line") errors.push(`changes[${i}].tags: a line has no tags (it's an annotation)`);
          const noteOnly = (["text", "label", "status"] as const).filter((k) => fields[k] !== undefined);
          if (node.type !== "note" && noteOnly.length > 0) errors.push(`changes[${i}]: only a note has ${noteOnly.join(", ")} ("${id}" is a ${node.type})`);
          if (fields.entity !== undefined && node.type !== "instance") errors.push(`changes[${i}].entity: only an instance shows an entity ("${id}" is a ${node.type})`);
          if (node.type === "instance") {
            const notInstance = (
              ["kind", "width", "depth", "height", "sides", "wall", "taper", "bevel", "pitch", "roll", "points", "tags", "thickness", "dashed", "arrow", "step", "base", "color", "text", "label", "status"] as const
            ).filter((k) => fields[k] !== undefined);
            if (notInstance.length > 0) {
              errors.push(
                `changes[${i}]: "${id}" is an instance, with no ${notInstance.join(", ")} of its own: it has x, y, z, rotation, name and entity ` +
                  `(its shapes, description and tags are the entity's: detach_instances turns it into a group you can edit)`,
              );
            }
            if (fields.entity !== undefined && !entityName(fields.entity)) errors.push(`changes[${i}].entity: no entity "${fields.entity}" in the project library`);
          }
          const arrayOnly = ARRAY_ONLY.filter((k) => fields[k] !== undefined);
          if (node.type !== "array" && arrayOnly.length > 0) errors.push(`changes[${i}]: only an array has ${arrayOnly.join(", ")} ("${id}" is a ${node.type})`);
          if (node.type === "array") {
            const notArray = Object.keys(fields).filter((k) => !ARRAY_FIELDS.includes(k) && k !== "entity" && fields[k as keyof typeof fields] !== undefined);
            if (notArray.length > 0) {
              errors.push(
                `changes[${i}]: "${id}" is an array, with no ${notArray.join(", ")} of its own: it has entities, layout, facing, rotation, jitter, ` +
                  `turnJitter, seed, skip, name and parent (its items are its entities' instances: detach_instances turns it into a group of instances)`,
              );
            }
          }
          if (node.type === "note") {
            const notNote = (
              ["kind", "width", "depth", "height", "rotation", "sides", "wall", "taper", "bevel", "pitch", "roll", "points", "tags", "thickness", "dashed", "arrow", "step", "base"] as const
            ).filter((k) => fields[k] !== undefined);
            if (notNote.length > 0) {
              errors.push(`changes[${i}]: "${id}" is a note, with no ${notNote.join(", ")}: it has x, y, z, text, label, color and status`);
            }
          }
          if (fields.sides !== undefined && node.type !== "cylinder") {
            errors.push(`changes[${i}].sides: only a cylinder has sides ("${id}" is a ${node.type})`);
          }
          if (fields.points !== undefined && node.type !== "freeform" && node.type !== "line" && node.type !== "ramp") {
            errors.push(`changes[${i}].points: only free-forms, lines and ramps have points ("${id}" is a ${node.type})`);
          }
          const rampOnly = (["step", "base"] as const).filter((k) => fields[k] !== undefined);
          if (node.type !== "ramp" && rampOnly.length > 0) {
            errors.push(`changes[${i}]: only a ramp has ${rampOnly.join(", ")} ("${id}" is a ${node.type})`);
          }
          if (node.type === "ramp") {
            const notRamp = (["x", "z", "y", "depth", "height", "rotation", "wall", "taper", "bevel", "pitch", "roll"] as const).filter(
              (k) => fields[k] !== undefined,
            );
            if (notRamp.length > 0) {
              errors.push(
                `changes[${i}]: "${id}" is a ramp, with no ${notRamp.join(", ")}: change its points (they carry their own y), ` +
                  `or use move_nodes / rotate_nodes`,
              );
            }
            if (fields.kind !== undefined && fields.kind !== "volume") errors.push(`changes[${i}].kind: a ramp is always a volume, never a ${fields.kind}`);
          }
          const lineOnly = (["thickness", "dashed", "arrow"] as const).filter((k) => fields[k] !== undefined);
          if (node.type !== "line" && lineOnly.length > 0) {
            errors.push(`changes[${i}]: only a line has ${lineOnly.join(", ")} ("${id}" is a ${node.type})`);
          }
          if (node.type === "line") {
            const closedOnly = (["kind", "x", "z", "y", "width", "depth", "height", "rotation", "wall", "taper", "bevel", "pitch", "roll"] as const).filter(
              (k) => fields[k] !== undefined,
            );
            if (closedOnly.length > 0) {
              errors.push(
                `changes[${i}]: "${id}" is a line, with no ${closedOnly.join(", ")}: change its points (they carry their own y), ` +
                  `or use move_nodes / rotate_nodes`,
              );
            }
          }
          if (node.type !== "line" && node.type !== "ramp" && node.type !== "note" && node.type !== "instance" && node.type !== "array") {
            const kind = fields.kind ?? node.kind;
            for (const f of Object.keys(KIND_FIELDS) as KindField[]) {
              if (fields[f] !== undefined && fields[f] !== null && !kindAllows(f, kind)) {
                errors.push(`changes[${i}].${f}: ${kindFieldProblem(f, kind).replace("this is", `"${id}" is`)}`);
              }
            }
          }
          if (node.type === "freeform") {
            const footprinted = (["x", "z", "width", "depth", "rotation", "pitch", "roll"] as const).filter((k) => fields[k] !== undefined);
            if (footprinted.length > 0) {
              errors.push(
                `changes[${i}]: "${id}" is a free-form, with no ${footprinted.join(", ")} of its own: change its points, ` +
                  `or use move_nodes / rotate_nodes`,
              );
            }
          }
        }
        checkSizes(`changes[${i}]`, fields, errors);
        const parent = fields.parent === null || fields.parent === "" ? undefined : fields.parent;
        if (parent !== undefined) {
          const e = parentError(parent);
          if (e) errors.push(`changes[${i}].parent: ${e}`);
        }
        if (!node) return null;

        const patch: NodePatch = {};
        for (const key of ["x", "z", "y", "width", "depth", "height"] as const) {
          if (fields[key] !== undefined) patch[key] = round2(fields[key]);
        }
        if (fields.rotation !== undefined) patch.rotation = normalizeRotation(fields.rotation);
        if (fields.kind !== undefined) patch.kind = fields.kind;
        if (fields.color !== undefined) patch.color = fields.color;
        if (fields.sides !== undefined) patch.sides = fields.sides ?? undefined;
        if (fields.wall !== undefined) patch.wall = fields.wall === null ? undefined : wallValue(`changes[${i}].wall`, fields.wall, errors);
        if (fields.taper !== undefined) patch.taper = fraction(fields.taper);
        if (fields.bevel !== undefined) patch.bevel = fraction(fields.bevel);
        if (fields.pitch !== undefined) patch.pitch = angle(fields.pitch);
        if (fields.roll !== undefined) patch.roll = angle(fields.roll);
        // A shape that changes kind loses the fields its new kind doesn't have (undo brings them back).
        if (fields.kind !== undefined && node.type !== "group" && isClosed(node)) {
          for (const f of Object.keys(KIND_FIELDS) as KindField[]) {
            if (!kindAllows(f, fields.kind) && node[f] !== undefined && fields[f] === undefined) patch[f] = undefined;
          }
        }
        if (fields.points !== undefined && node?.type === "freeform") {
          if (fields.points.some((p) => p.y !== undefined || p.in?.y !== undefined || p.out?.y !== undefined)) {
            errors.push(`changes[${i}].points: a free-form's points have no y (the free-form has its own y)`);
          }
          const flat = fields.points.map(({ y: _y, in: pin, out: pout, ...p }) => ({
            ...p,
            ...(pin ? { in: { x: pin.x, z: pin.z } } : {}),
            ...(pout ? { out: { x: pout.x, z: pout.z } } : {}),
          }));
          patch.points = checkPoints(`changes[${i}]`, flat, errors);
        }
        if (fields.points !== undefined && node?.type === "line") {
          const missing = fields.points.findIndex((p) => p.y === undefined || (p.in && p.in.y === undefined) || (p.out && p.out.y === undefined));
          if (missing >= 0) errors.push(`changes[${i}].points[${missing}]: a line's points (and handles) need a y`);
          else patch.points = checkLinePoints(`changes[${i}]`, fields.points as LinePoint[], errors);
        }
        if (node.type === "ramp" && (fields.points !== undefined || fields.width !== undefined || fields.step !== undefined || fields.base !== undefined)) {
          const missing = fields.points?.findIndex((p) => p.y === undefined) ?? -1;
          if (missing >= 0) errors.push(`changes[${i}].points[${missing}]: a ramp's points need a y (the surface's height there)`);
          else {
            const next = checkRamp(
              `changes[${i}]`,
              {
                points: (fields.points as RampPoint[] | undefined) ?? node.points,
                width: fields.width ?? node.width,
                step: fields.step === null ? undefined : (fields.step ?? node.step),
                base: fields.base ?? node.base,
              },
              errors,
            );
            if (fields.points !== undefined) patch.points = next.points;
            if (fields.width !== undefined) patch.width = next.width;
            if (fields.step !== undefined) patch.step = next.step;
            if (fields.base !== undefined) patch.base = next.base;
          }
        }
        if (fields.thickness !== undefined) patch.thickness = round2(fields.thickness);
        if (fields.dashed !== undefined) patch.dashed = fields.dashed;
        if (fields.arrow !== undefined) patch.arrow = fields.arrow;
        if (fields.name !== undefined) patch.name = fields.name.trim() || undefined;
        if (fields.description !== undefined) patch.description = fields.description?.trim() || undefined;
        if (fields.tags !== undefined) patch.tags = tagList(`changes[${i}]`, fields.tags, errors);
        if (fields.text !== undefined) patch.text = fields.text.trim();
        if (fields.label !== undefined) patch.label = fields.label?.trim() || undefined;
        if (fields.status !== undefined) patch.status = fields.status;
        if (fields.entity !== undefined) patch.entity = fields.entity;
        if (node.type === "array") {
          if (fields.entities !== undefined) patch.entities = arrayEntitiesFrom(`changes[${i}].entities`, fields.entities, errors);
          if (fields.layout !== undefined) patch.layout = mergeLayout(`changes[${i}].layout`, node, fields.layout, errors);
          if (fields.facing !== undefined) patch.facing = fields.facing;
          if (fields.rotation !== undefined) patch.rotation = normalizeRotation(fields.rotation) || undefined;
          Object.assign(patch, arrayNoise(fields));
        }
        if (fields.parent !== undefined) patch.parent = parent;
        if (fields.locked !== undefined) patch.locked = fields.locked || undefined;
        if (fields.hidden !== undefined) patch.hidden = fields.hidden || undefined;

        // Keep only what differs from the node as it is.
        const effective: NodePatch = {};
        for (const key of Object.keys(patch) as (keyof NodePatch)[]) {
          if (!sameValue(patch[key], (node as Record<string, unknown>)[key])) (effective as Record<string, unknown>)[key] = patch[key];
        }
        return { id, patch: effective, index: i };
      });
      failIf(errors, "Nothing was changed.");

      // No node may end up inside itself.
      const next = runOps(scene.nodes, [{ op: "update", changes: valid.map((c) => ({ id: c!.id, patch: c!.patch })) }]).nodes;
      for (const c of valid) {
        if (c!.patch.parent !== undefined && isCycle(next, c!.id)) {
          errors.push(`changes[${c!.index}].parent: "${c!.patch.parent}" is inside "${c!.id}"`);
        }
      }
      failIf(errors, "Nothing was changed.");

      const effective = valid.filter((c) => Object.keys(c!.patch).length > 0).map((c) => ({ id: c!.id, patch: c!.patch }));
      if (effective.length > 0) {
        const verb = updateVerb(effective.map((c) => c.patch));
        commit(label(verb, listIds(effective.map((c) => c.id)), actor), actor, [{ op: "update", changes: effective }]);
      }
      const ids = new Set(valid.map((c) => c!.id));
      return scene.nodes.filter((n) => ids.has(n.id));
    },

    /**
     * Converts boxes and cylinders into free-forms with the same outline, as one step: a box gives its 4 corners, a
     * sided cylinder its corners, a smooth one 4 smooth points (still a true circle or oval). Each free-form gets a
     * new ID and takes its original's place in the list, keeping its name, parent, kind, y, height, color and
     * creator. Returns the free-forms, in the order of `ids`.
     */
    convertNodes(input: z.input<typeof ConvertNodesSchema>, actor: Actor): Freeform[] {
      const { ids } = parse(ConvertNodesSchema, input, "Nothing was converted.");
      return convert(ids, actor, "ids");
    },

    /**
     * Removes nodes by ID as one undoable step; a group takes everything in it. Unknown or repeated IDs reject all.
     * `cut` only changes the label (the editor put the nodes on the clipboard first).
     */
    removeNodes(ids: string[], actor: Actor, { cut = false }: { cut?: boolean } = {}): void {
      if (ids.length === 0) throw new SceneError("ids: at least one ID is required");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was removed.");
      const all = new Set(ids.flatMap((id) => [...subtreeIds(scene.nodes, id)]));
      const remove = scene.nodes.filter((n) => all.has(n.id)).map((n) => n.id);
      commit(label(cut ? "cut" : "delete", listIds(ids), actor), actor, [{ op: "remove", ids: remove }]);
    },

    /** Moves boxes and whole groups by a relative offset, as one step. Returns the boxes that moved. */
    moveNodes(input: z.input<typeof MoveNodesSchema>, actor: Actor): Shape[] {
      const { ids, dx = 0, dy = 0, dz = 0 } = parse(MoveNodesSchema, input, "Nothing was moved.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was moved.");
      const boxes = withoutFollowers(ids, shapesUnder(scene.nodes, ids), "move");
      const patches = Object.fromEntries(boxes.map((b) => [b.id, moveShape(b, dx, dy, dz)]));
      const changes = effectiveShapeChanges(boxes, patches);
      if (changes.length > 0) commit(label("move", listIds(ids), actor), actor, [{ op: "update", changes }]);
      const moved = new Set(boxes.map((b) => b.id));
      return scene.nodes.filter((n): n is Shape => moved.has(n.id));
    },

    /**
     * Copies boxes and whole groups with fresh IDs, as one step: copy i (1..count) is offset by i × (dx, dy, dz).
     * A listed node inside another listed node is copied as part of it. Copies keep their names and their
     * original's parent, and go right after the original's subtree in the list (copy 1, copy 2, ...). Returns the
     * copied roots.
     */
    duplicateNodes(input: z.input<typeof DuplicateNodesSchema>, actor: Actor): SceneNode[] {
      const { ids, dx = 0, dy = 0, dz = 0, count = 1 } = parse(DuplicateNodesSchema, input, "Nothing was copied.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was copied.");

      const roots = topmost(scene.nodes, ids);
      // After which original each root's copies go: the last node of its subtree in the list.
      const copiesAfter = new Map<string, SceneNode[]>();
      const copiedRoots: SceneNode[] = [];
      const subtrees = roots.map((id) => {
        const inside = subtreeIds(scene.nodes, id);
        return { id, nodes: scene.nodes.filter((n) => inside.has(n.id)) };
      });
      for (let i = 1; i <= count; i++) {
        for (const { id, nodes } of subtrees) {
          const copies = relinkCopies(nodes, copyNodes(nodes, newId, { dx: dx * i, dy: dy * i, dz: dz * i })).map((n) => ({ ...n, createdBy: actor }));
          copiedRoots.push(copies[nodes.findIndex((n) => n.id === id)]);
          const last = nodes.at(-1)!.id;
          copiesAfter.set(last, [...(copiesAfter.get(last) ?? []), ...copies]);
        }
      }
      const next = scene.nodes.flatMap((n) => [n, ...(copiesAfter.get(n.id) ?? [])]);
      const added = new Set([...copiesAfter.values()].flat().map((n) => n.id));
      const indices: number[] = [];
      const nodes = next.filter((n, index) => added.has(n.id) && indices.push(index));

      const times = count > 1 ? ` ×${count}` : "";
      commit(label("copy", describeIds(scene.nodes, roots) + times, actor), actor, [{ op: "add", nodes, indices }]);
      return copiedRoots;
    },

    /**
     * Turns boxes and whole groups around the vertical axis through `pivot` (default: the center of their combined
     * bounds), as one step: each center orbits it and the angle is added to each rotation (a free-form's points
     * orbit it). Returns the shapes that turned and the pivot, so turning back by the same pivot restores them.
     */
    rotateNodes(input: z.input<typeof RotateNodesSchema>, actor: Actor): { shapes: Shape[]; pivot: { x: number; z: number } } {
      const { ids, degrees, pivot: given } = parse(RotateNodesSchema, input, "Nothing was rotated.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was rotated.");
      const all = shapesUnder(scene.nodes, ids);
      const boxes = withoutFollowers(ids, all, "turn");
      const b = boundsOf(all);
      const pivot = given ?? { x: round2((b.minX + b.maxX) / 2), z: round2((b.minZ + b.maxZ) / 2) };
      const patches = rotateAround(boxes, pivot, degrees);
      const changes = effectiveShapeChanges(boxes, patches);
      if (changes.length > 0) commit(label("rotate", listIds(ids), actor), actor, [{ op: "update", changes }]);
      const turned = new Set(boxes.map((b) => b.id));
      return { shapes: scene.nodes.filter((n): n is Shape => turned.has(n.id)), pivot };
    },

    /**
     * Pastes a clipboard snapshot as one step: fresh IDs (names and nesting kept), centered on `focus` with the offset
     * rounded to the 0.5 m snap (so it stays on its grid), each box keeping its y. Parent references that point
     * outside the snapshot are dropped, so those nodes become roots, and the roots go into `parent` (null = the top
     * level; inside a group they come last among its children). Returns the pasted roots.
     */
    pasteNodes(input: z.input<typeof PasteNodesSchema>, actor: Actor): SceneNode[] {
      const { nodes: snapshot, focus, parent } = parse(PasteNodesSchema, input, "Nothing was pasted.");
      const errors: string[] = [];
      const seen = new Set<string>();
      snapshot.forEach((n, i) => {
        const inEntity = entityProblem(n);
        if (inEntity) errors.push(`nodes[${i}]: ${inEntity}`);
        if (seen.has(n.id)) errors.push(`nodes[${i}].id: "${n.id}" appears more than once`);
        seen.add(n.id);
      });
      const target = parent ?? undefined;
      if (target !== undefined) {
        const e = parentError(target);
        if (e) errors.push(`parent: ${e}`);
      }
      const groups = new Set(snapshot.filter(isGroup).map((n) => n.id));
      const nodes = snapshot.map((n, i): SceneNode => {
        const { parent: p, ...rest } = n;
        const kept = p !== undefined && groups.has(p) ? { parent: p } : {};
        if (!isShape(n)) return { ...rest, ...kept } as SceneNode;
        if (n.type === "line") {
          return { ...(rest as typeof n), ...kept, thickness: round2(n.thickness), points: checkLinePoints(`nodes[${i}]`, n.points, errors) };
        }
        if (n.type === "ramp") return { ...(rest as typeof n), ...kept, ...checkRamp(`nodes[${i}]`, n, errors) };
        if (n.type === "note") return { ...(rest as typeof n), ...kept, x: round2(n.x), y: round2(n.y), z: round2(n.z) };
        if (n.type === "instance") return { ...(rest as typeof n), ...kept, x: round2(n.x), y: round2(n.y), z: round2(n.z), rotation: normalizeRotation(n.rotation) };
        if (n.type === "array") return { ...(rest as typeof n), ...kept };
        const shape = { ...(rest as ClosedShape), ...kept, height: round2(n.height) } as ClosedShape;
        if (shape.type === "freeform") return { ...shape, points: checkPoints(`nodes[${i}]`, shape.points, errors) };
        return { ...shape, width: round2(shape.width), depth: round2(shape.depth), rotation: normalizeRotation(shape.rotation) };
      });
      nodes.forEach((n, i) => {
        if (isShape(n)) checkSizes(`nodes[${i}]`, snapshot[i] as Partial<Record<"width" | "depth" | "height", number>>, errors);
        if (isCycle(nodes, n.id)) errors.push(`nodes[${i}].parent: "${n.id}" ends up inside itself`);
      });
      const boxes = nodes.filter(isShape);
      if (boxes.length === 0) errors.push("nodes: there are no shapes to paste");
      failIf(errors, "Nothing was pasted.");

      const b = boundsOf(boxes);
      const offset = (to: number, center: number) => round2(Math.round((to - center) / SNAP) * SNAP);
      const dx = offset(focus.x, (b.minX + b.maxX) / 2);
      const dz = offset(focus.z, (b.minZ + b.maxZ) / 2);
      const pasted = relinkCopies(nodes, copyNodes(nodes, newId, { dx, dz })).map((n, i): SceneNode => {
        const root = nodes[i].parent === undefined;
        return { ...n, createdBy: actor, ...(root && target !== undefined ? { parent: target } : {}) };
      });

      const add: Op = { op: "add", nodes: pasted };
      if (target !== undefined) {
        // Right after the last node inside the group, so they come last among its children.
        const inside = subtreeIds(scene.nodes, target);
        const at = scene.nodes.reduce((last, n, i) => (inside.has(n.id) ? i + 1 : last), 0);
        add.indices = pasted.map((_, i) => at + i);
      }
      commit(label("paste", listIds(pasted.map((n) => n.id)), actor), actor, [add]);
      return pasted.filter((_, i) => nodes[i].parent === undefined);
    },

    /**
     * Mirrors boxes and whole groups in place on a world axis, as one step: every center reflects across the center
     * of their combined footprint bounds, and every rotation becomes -rotation. Records nothing if nothing changes
     * (a single unrotated box). Returns the boxes.
     */
    mirrorNodes(input: z.input<typeof MirrorNodesSchema>, actor: Actor): Shape[] {
      const { ids, axis } = parse(MirrorNodesSchema, input, "Nothing was mirrored.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "Nothing was mirrored.");
      const boxes = withoutFollowers(ids, shapesUnder(scene.nodes, ids), "mirror");
      const changes = effectiveShapeChanges(boxes, mirrorAcross(boxes, axis));
      if (changes.length > 0) commit(label("mirror", `${listIds(ids)} on ${axis.toUpperCase()}`, actor), actor, [{ op: "update", changes }]);
      const mirrored = new Set(boxes.map((b) => b.id));
      return scene.nodes.filter((n): n is Shape => mirrored.has(n.id));
    },

    /**
     * Puts nodes in a new group, as one step. The group goes where the first of them was in the list, inside the
     * deepest group that held them all. A node whose ancestor is also listed stays where it is (inside it).
     */
    groupNodes(input: z.input<typeof GroupNodesSchema>, actor: Actor): Group {
      const { ids, name, description, tags } = parse(GroupNodesSchema, input, "Nothing was grouped.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      const groupTags = tagList("group", tags, errors);
      failIf(errors, "Nothing was grouped.");
      const members = topmost(scene.nodes, ids);
      const parent = commonParent(scene.nodes, members);
      const trimmed = name?.trim();
      const described = description?.trim();
      const group: Group = {
        id: newId("group"),
        type: "group",
        ...(trimmed ? { name: trimmed } : {}),
        ...(described ? { description: described } : {}),
        ...withTags(groupTags),
        ...(parent !== undefined ? { parent } : {}),
        createdBy: actor,
      };
      const index = Math.min(...members.map((id) => scene.nodes.findIndex((n) => n.id === id)));
      commit(label("group", `${listIds(members)} as ${group.id}`, actor), actor, [
        { op: "add", nodes: [group], indices: [index] },
        { op: "update", changes: members.map((id) => ({ id, patch: { parent: group.id } })) },
      ]);
      return group;
    },

    /**
     * What Make entity would turn into a definition (plan 08 §7), without changing anything: the nodes (whole
     * subtrees) moved so the pivot, the bottom center of their bounds, is at the origin. A single group is unwrapped:
     * its contents are the definition, and its name, description and tags are offered for the entity (the instance
     * takes the group's place, and behaves like it). Refused for instances and notes. Keeps the nodes' IDs.
     */
    prepareEntity(ids: string[]): PreparedEntity {
      if (document === "entity") throw new SceneError("You're editing an entity: make entities in a scene. No entity was made.");
      if (ids.length === 0) throw new SceneError("ids: at least one ID is required. No entity was made.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      failIf(errors, "No entity was made.");
      const roots = topmost(scene.nodes, ids);
      const inside = new Set(roots.flatMap((id) => [...subtreeIds(scene.nodes, id)]));
      const taken = scene.nodes.filter((n) => inside.has(n.id));
      const bad = taken.filter((n) => n.type === "instance" || n.type === "array" || n.type === "note");
      if (bad.length > 0) {
        const what = bad.some((n) => n.type === "instance") ? "instances (no nested entities)" : bad.some((n) => n.type === "array") ? "arrays (no nested entities)" : "notes";
        throw new SceneError(`An entity can't hold ${what}: ${listIds(bad.map((n) => n.id))}. No entity was made.`);
      }
      const shapes = taken.filter(isShape);
      if (shapes.length === 0) throw new SceneError("There are no shapes in it. No entity was made.");
      const single = roots.length === 1 ? scene.nodes.find((n) => n.id === roots[0]) : undefined;
      const wrapper = single && isGroup(single) ? single : undefined;
      const b = boundsOf(shapes);
      const pivot = { x: round2((b.minX + b.maxX) / 2), y: round2(b.minY), z: round2((b.minZ + b.maxZ) / 2) };
      const top = new Set(wrapper ? scene.nodes.filter((n) => n.parent === wrapper.id).map((n) => n.id) : roots);
      const nodes = taken
        .filter((n) => n.id !== wrapper?.id)
        .map((n) => {
          const moved = isShape(n) ? ({ ...n, ...moveShape(n, -pivot.x, -pivot.y, -pivot.z) } as SceneNode) : n;
          if (!top.has(n.id)) return moved;
          const { parent: _parent, ...rest } = moved;
          return rest as SceneNode;
        });
      return {
        nodes,
        pivot,
        remove: taken.map((n) => n.id),
        parent: commonParent(scene.nodes, roots),
        index: Math.min(...roots.map((id) => scene.nodes.findIndex((n) => n.id === id))),
        ...(wrapper ? { from: { name: wrapper.name, description: wrapper.description, tags: wrapper.tags } } : {}),
      };
    },

    /**
     * The scene half of Make entity, as one step: the prepared nodes are replaced by one instance of `entity` at
     * their pivot, unturned, where the first of them was (or, without `keep`, just removed). The definition must exist by now. Undo puts the nodes back.
     */
    commitEntity(prepared: PreparedEntity, entity: string, label_: string, actor: Actor, keep = true): Instance | null {
      // keep: false (plan 13 §6): the nodes become the entity and leave nothing in their place.
      if (!keep) {
        commit(label("make entity", label_, actor), actor, [{ op: "remove", ids: prepared.remove }]);
        return null;
      }
      const removing = new Set(prepared.remove);
      const instance: Instance = {
        id: newId("instance"),
        type: "instance",
        entity,
        ...(prepared.parent !== undefined ? { parent: prepared.parent } : {}),
        x: prepared.pivot.x,
        y: prepared.pivot.y,
        z: prepared.pivot.z,
        rotation: 0,
        createdBy: actor,
      };
      const index = scene.nodes.slice(0, prepared.index).filter((n) => !removing.has(n.id)).length;
      commit(label("make entity", label_, actor), actor, [
        { op: "remove", ids: prepared.remove },
        { op: "add", nodes: [instance], indices: [index] },
      ]);
      return instance;
    },

    /**
     * The inspector's Array button (plan 10 §4), as one step: an instance becomes an array of its entity, where it
     * was in the list and the tree, with its name. The array starts as a path from the instance's point along its
     * local +x, 4 items 1.5 × the entity's width apart, facing along it, so its first item is the instance.
     */
    makeArray(id: string, actor: Actor): ArrayNode {
      const node = byId().get(id);
      if (!node) throw new SceneError(`id: no node "${id}". No array was made.`);
      if (node.type !== "instance") throw new SceneError(`id: "${id}" is a ${node.type}; an array is made from an instance. No array was made.`);
      if (document === "entity") throw new SceneError("An entity can't hold arrays (no nested entities). No array was made.");
      const spacing = defaultSpacing(node.entity);
      const a = (node.rotation * Math.PI) / 180;
      const length = spacing * 3;
      const array: ArrayNode = {
        id: newId("array"),
        type: "array",
        ...(node.name !== undefined ? { name: node.name } : {}),
        ...(node.parent !== undefined ? { parent: node.parent } : {}),
        ...(node.locked ? { locked: true as const } : {}),
        ...(node.hidden ? { hidden: true as const } : {}),
        entities: [{ entity: node.entity }],
        layout: {
          type: "path",
          points: [
            { x: node.x, y: node.y, z: node.z },
            { x: round2(node.x + Math.cos(a) * length), y: node.y, z: round2(node.z - Math.sin(a) * length) },
          ],
          place: "spacing",
          spacing,
        },
        createdBy: actor,
      };
      const index = scene.nodes.findIndex((n) => n.id === id);
      commit(label("array", id, actor), actor, [
        { op: "remove", ids: [id] },
        { op: "add", nodes: [array], indices: [index] },
      ]);
      return array;
    },

    /**
     * Turns instances into plain groups holding world copies of their entity's shapes (new IDs), and arrays into
     * groups of plain instances where their items were (plan 10 §4), each where it was, as one step. The group is
     * named after the instance or array, else the entity. Returns the groups.
     */
    detachInstances(ids: string[], actor: Actor): Group[] {
      if (ids.length === 0) throw new SceneError("ids: at least one ID is required. Nothing was detached.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      const nodes = byId();
      ids.forEach((id, i) => {
        const n = nodes.get(id);
        if (n && n.type !== "instance" && n.type !== "array") errors.push(`ids[${i}]: "${id}" is a ${n.type}, not an instance or an array`);
        else if (n?.type === "instance" && !definitionOf(n.entity)) errors.push(`ids[${i}]: "${id}"'s entity "${n.entity}" is missing, so there's nothing to detach`);
        else if (n?.type === "array" && arrayItems(n).length === 0) errors.push(`ids[${i}]: "${id}" has no items (every one is skipped), so there's nothing to detach`);
      });
      failIf(errors, "Nothing was detached.");
      const ops: Op[] = [];
      const groups: Group[] = [];
      let current = scene.nodes;
      for (const id of ids) {
        const found = current.find((n) => n.id === id)!;
        if (found.type === "array") {
          const group: Group = {
            id: newId("group"),
            type: "group",
            name: found.name ?? `array of ${entityName(found.entities[0].entity) ?? found.entities[0].entity}`,
            ...(found.parent !== undefined ? { parent: found.parent } : {}),
            createdBy: actor,
          };
          const instances = arrayItems(found).map(
            (item): Instance => ({
              id: newId("instance"),
              type: "instance",
              entity: item.entity,
              parent: group.id,
              x: item.x,
              y: item.y,
              z: item.z,
              rotation: item.rotation,
              createdBy: actor,
            }),
          );
          const index = current.findIndex((n) => n.id === id);
          const step: Op[] = [
            { op: "remove", ids: [id] },
            { op: "add", nodes: [group, ...instances], indices: [group, ...instances].map((_, k) => index + k) },
          ];
          current = runOps(current, step).nodes;
          ops.push(...step);
          groups.push(group);
          continue;
        }
        const inst = found as Instance;
        const [, ...inner] = expandInstance(inst);
        const group: Group = {
          id: newId("group"),
          type: "group",
          name: inst.name ?? entityName(inst.entity) ?? inst.entity,
          ...(inst.parent !== undefined ? { parent: inst.parent } : {}),
          createdBy: actor,
        };
        const idMap = new Map<string, string>([[inst.id, group.id]]);
        for (const n of inner) idMap.set(n.id, newId(n.type));
        const copies = inner.map((n) => ({ ...n, id: idMap.get(n.id)!, parent: idMap.get(n.parent!)!, createdBy: actor }) as SceneNode);
        const index = current.findIndex((n) => n.id === id);
        const step: Op[] = [
          { op: "remove", ids: [id] },
          { op: "add", nodes: [group, ...copies], indices: [group, ...copies].map((_, k) => index + k) },
        ];
        current = runOps(current, step).nodes;
        ops.push(...step);
        groups.push(group);
      }
      commit(label("detach", listIds(ids), actor), actor, ops);
      return groups;
    },

    /** Dissolves groups, as one step: their contents move up to the group's parent. Returns the freed node IDs. */
    ungroup(input: z.input<typeof UngroupSchema>, actor: Actor): string[] {
      const { ids } = parse(UngroupSchema, input, "Nothing was ungrouped.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      const nodes = byId();
      ids.forEach((id, i) => {
        const n = nodes.get(id);
        if (n && !isGroup(n)) errors.push(`ids[${i}]: "${id}" is a box, not a group`);
      });
      failIf(errors, "Nothing was ungrouped.");
      const dissolved = new Set(ids);
      // The nearest ancestor that survives (nested groups can be dissolved together).
      const newParent = (parent: string | undefined): string | undefined => {
        let p = parent;
        while (p !== undefined && dissolved.has(p)) p = nodes.get(p)!.parent;
        return p;
      };
      const freed = scene.nodes.filter((n) => n.parent !== undefined && dissolved.has(n.parent) && !dissolved.has(n.id));
      commit(label("ungroup", listIds(ids), actor), actor, [
        { op: "update", changes: freed.map((n) => ({ id: n.id, patch: { parent: newParent(n.parent) } })) },
        { op: "remove", ids },
      ]);
      return freed.map((n) => n.id);
    },

    /**
     * The outliner's drag and drop, as one step: puts nodes (keeping their list order) inside `parent` (null = the
     * top level), just before its child `before` (null = after its last child). A group can't go inside itself.
     */
    placeNodes(input: z.input<typeof PlaceNodesSchema>, actor: Actor): void {
      const { ids, parent, before } = parse(PlaceNodesSchema, input, "Nothing was moved.");
      const errors: string[] = [];
      checkIds("ids", ids, errors);
      const target = parent ?? undefined;
      if (target !== undefined) {
        const e = parentError(target);
        if (e) errors.push(`parent: ${e}`);
        else {
          ids.forEach((id, i) => {
            if (subtreeIds(scene.nodes, id).has(target)) errors.push(`ids[${i}]: "${target}" is inside "${id}"`);
          });
        }
      }
      if (before !== null) {
        const b = byId().get(before);
        if (!b) errors.push(`before: no node "${before}"`);
        else if (ids.includes(before)) errors.push(`before: "${before}" is one of the nodes being moved`);
        else if (b.parent !== target) errors.push(`before: "${before}" isn't in ${parent ?? "the top level"}`);
      }
      failIf(errors, "Nothing was moved.");

      const moving = new Set(ids);
      const rest = scene.nodes.filter((n) => !moving.has(n.id));
      const movers = scene.nodes.filter((n) => moving.has(n.id));
      let at = rest.length;
      if (before !== null) at = rest.findIndex((n) => n.id === before);
      else if (target !== undefined) {
        // Right after the last node inside the group (so they come last among its children).
        const inside = subtreeIds(scene.nodes, target);
        at = rest.reduce((last, n, i) => (inside.has(n.id) ? i + 1 : last), 0);
      }
      const order = [...rest.slice(0, at), ...movers, ...rest.slice(at)].map((n) => n.id);

      const reparent = movers.filter((n) => n.parent !== target);
      const ops: Op[] = [];
      if (reparent.length > 0) ops.push({ op: "update", changes: reparent.map((n) => ({ id: n.id, patch: { parent: target } })) });
      if (order.some((id, i) => scene.nodes[i].id !== id)) ops.push({ op: "order", ids: order });
      if (ops.length === 0) return;
      const where = reparent.length > 0 ? `${listIds(ids)} into ${parent ?? "the top level"}` : listIds(ids);
      commit(label(reparent.length > 0 ? "move" : "reorder", where, actor), actor, ops);
    },

    /** What the editor currently shows (last reporting tab wins). Not an edit, so no broadcast. */
    setView(view: View): void {
      const { focus, yaw, bounds, isolated, walking } = view;
      scene.view = {
        focus: { x: round2(focus.x), z: round2(focus.z) },
        yaw: round2(yaw),
        bounds: { x: round2(bounds.x), z: round2(bounds.z), width: round2(bounds.width), depth: round2(bounds.depth) },
        ...(isolated !== undefined && scene.nodes.some((n) => n.id === isolated) ? { isolated } : {}),
        ...(walking
          ? {
              walking: {
                preset: walking.preset,
                eye: { x: round2(walking.eye.x), y: round2(walking.eye.y), z: round2(walking.eye.z) },
                yaw: round2(walking.yaw),
                pitch: round2(walking.pitch),
                fov: round2(walking.fov),
              },
            }
          : {}),
      };
    },

    /** What the editor has selected (last reporting tab wins). Unknown IDs are dropped. Not an edit, so no broadcast. */
    setSelection(ids: string[]): void {
      const existing = new Set(scene.nodes.map((n) => n.id));
      scene.selection = [...new Set(ids)].filter((id) => existing.has(id));
    },

    /** Removes every node as one undoable step. Clearing an empty scene records nothing. */
    clear(actor: Actor): void {
      if (scene.nodes.length === 0) return;
      commit("Clear", actor, [{ op: "remove", ids: scene.nodes.map((n) => n.id) }]);
    },

    /** Reverts the latest step, whoever made it. Returns it, or null if there was nothing to undo. */
    undo(): HistoryEntry | null {
      const result = history.undo(scene.nodes);
      if (!result) return null;
      scene.nodes = result.nodes;
      step({ type: "undo", entry: result.entry });
      emit();
      return result.entry;
    },

    redo(): HistoryEntry | null {
      const result = history.redo(scene.nodes);
      if (!result) return null;
      scene.nodes = result.nodes;
      step({ type: "redo", entry: result.entry });
      emit();
      return result.entry;
    },

    /** After every commit, undo and redo, before the broadcast. */
    onStep(listener: (step: Step) => void): () => void {
      stepListeners.add(listener);
      return () => stepListeners.delete(listener);
    },

    onChange(listener: (scene: Scene) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Whether following `id`'s parents ever comes back to `id`. */
function isCycle(nodes: SceneNode[], id: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let p = byId.get(id)?.parent;
  while (p !== undefined) {
    if (p === id || seen.has(p)) return true;
    seen.add(p);
    p = byId.get(p)?.parent;
  }
  return false;
}

export type SceneStore = ReturnType<typeof createSceneStore>;

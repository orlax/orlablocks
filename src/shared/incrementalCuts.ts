import { cutOverlaps, isCutTarget, isHole } from "./holes";
import type { ClosedShape, SceneNode, Solid } from "./scene.types";
import { subtreeIds } from "./tree";

type ByTag<T> = Map<string, Set<T>>;

function changeIndex<T extends Solid>(index: ByTag<T>, shape: T, add: boolean) {
  for (const tag of shape.cutTags ?? []) {
    let bucket = index.get(tag);
    if (add) {
      if (!bucket) index.set(tag, bucket = new Set());
      bucket.add(shape);
    } else if (bucket) {
      bucket.delete(shape);
      if (!bucket.size) index.delete(tag);
    }
  }
}

function candidates<T extends Solid>(index: ByTag<T>, shape: Solid): Set<T> {
  const result = new Set<T>();
  for (const tag of shape.cutTags ?? []) {
    for (const candidate of index.get(tag) ?? []) result.add(candidate);
  }
  return result;
}

const terrainSource = (node?: SceneNode) => node?.type === "terrain" ? node.source : undefined;

/** Per viewport, update both directions of the cut graph for changed shapes. Input nodes are immutable. */
export class IncrementalCuts {
  private records = new Map<string, { node: SceneNode; order: number }>();
  private holes: ByTag<ClosedShape> = new Map();
  private targets: ByTag<Solid> = new Map();
  private sourceIds = new Set<string>();
  private terrainHoles = new Set<string>();
  private targetsByHole = new Map<string, Set<string>>();
  private cuts = new Map<string, ClosedShape[]>();

  update(nodes: SceneNode[]): Map<string, ClosedShape[]> {
    const initializing = this.records.size === 0;
    const changed = new Map<string, { before?: SceneNode; after?: SceneNode }>();
    let topologyChanged = this.records.size !== nodes.length;
    let previousHoleOrder = -1;
    let reordered = false;
    nodes.forEach((node, order) => {
      const record = this.records.get(node.id);
      if (record && isHole(node) && node.cutTags?.length) {
        if (record.order < previousHoleOrder) reordered = true;
        previousHoleOrder = record.order;
      }
      if (record?.node !== node) {
        const before = record?.node;
        changed.set(node.id, { before, after: node });
        if (!before || before.parent !== node.parent || terrainSource(before) !== terrainSource(node)) topologyChanged = true;
      }
      // Mark this record with its current position, also used to detect removals and sort cutter lists.
      if (record) {
        record.node = node;
        record.order = order;
      } else this.records.set(node.id, { node, order });
    });
    if (topologyChanged) {
      for (const [id, { node, order }] of this.records) {
        if (nodes[order]?.id === id) continue;
        changed.set(id, { before: node });
        this.records.delete(id);
      }
    }

    const wasTerrain = this.terrainHoles;
    if (topologyChanged && (this.sourceIds.size || [...changed.values()].some(({ after }) => terrainSource(after)))) {
      this.sourceIds = new Set();
      for (const node of nodes) {
        const source = terrainSource(node);
        if (source) this.sourceIds.add(source);
      }
      this.terrainHoles = new Set();
      for (const source of this.sourceIds) {
        for (const id of subtreeIds(nodes, source)) this.terrainHoles.add(id);
      }
      for (const id of [...wasTerrain, ...this.terrainHoles]) {
        if (changed.has(id) || wasTerrain.has(id) === this.terrainHoles.has(id)) continue;
        const node = this.records.get(id)?.node;
        if (node && isHole(node)) changed.set(id, { before: node, after: node });
      }
    }

    const dirtyTargets = new Set<string>();
    const newHoles: ClosedShape[] = [];
    for (const [id, { before, after }] of changed) {
      const wasTarget = before && isCutTarget(before);
      const isTarget = after && isCutTarget(after);
      if (wasTarget) changeIndex(this.targets, before, false);
      if (isTarget) changeIndex(this.targets, after, true);
      if (wasTarget || isTarget) dirtyTargets.add(id);
      if (before && isHole(before) && !wasTerrain.has(id)) {
        changeIndex(this.holes, before, false);
        for (const target of this.targetsByHole.get(id) ?? []) dirtyTargets.add(target);
      }
      if (after && isHole(after) && after.cutTags?.length && !this.terrainHoles.has(id)) {
        changeIndex(this.holes, after, true);
        if (!initializing) newHoles.push(after);
      }
    }
    for (const hole of newHoles) {
      for (const target of candidates(this.targets, hole)) {
        if (cutOverlaps(hole, target)) dirtyTargets.add(target.id);
      }
    }
    if (reordered) {
      for (const [id, list] of this.cuts) {
        if (list.length > 1) dirtyTargets.add(id);
      }
    }

    let result = this.cuts;
    for (const id of dirtyTargets) {
      const target = this.records.get(id)?.node;
      const old = this.cuts.get(id) ?? [];
      const next = target && isCutTarget(target)
        ? [...candidates(this.holes, target)].filter((hole) => cutOverlaps(hole, target))
          .sort((a, b) => this.records.get(a.id)!.order - this.records.get(b.id)!.order)
        : [];
      if (old.length === next.length && old.every((hole, i) => hole === next[i])) continue;
      for (const hole of old) {
        const targets = this.targetsByHole.get(hole.id)!;
        targets.delete(id);
        if (!targets.size) this.targetsByHole.delete(hole.id);
      }
      for (const hole of next) {
        let targets = this.targetsByHole.get(hole.id);
        if (!targets) this.targetsByHole.set(hole.id, targets = new Set());
        targets.add(id);
      }
      if (result === this.cuts) result = new Map(result);
      if (next.length) result.set(id, next);
      else result.delete(id);
    }
    this.cuts = result;
    return result;
  }
}

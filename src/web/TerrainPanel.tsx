import type { NodeUpdate, SceneNode, ShapeInput, Terrain } from "../shared/scene.types";

/** Minimal 16.1 controls. Geometry editing stays in the existing inspector/outliner. */
export function TerrainPanel({ nodes, selection, create, update, show, toggle, focus, enter }: {
  nodes: SceneNode[]; selection: string[]; create: (shapes: ShapeInput[]) => void;
  update: (changes: NodeUpdate[]) => void; show: boolean; toggle: () => void;
  focus: { x: number; z: number }; enter: (id: string) => void;
}) {
  const selected = nodes.find((n) => selection.length === 1 && n.id === selection[0]);
  const terrain = selected?.type === "terrain" ? selected : undefined;
  const modifier = selected?.type === "box" || selected?.type === "cylinder" ? selected : undefined;
  const numeric = (label: string, value: number, change: (v: number) => void, min?: number) => <label key={label}>{label}<input
    key={`${selected?.id}-${label}-${value}`} type="number" defaultValue={value} step="0.5" min={min}
    onBlur={(e) => { const v = e.currentTarget.valueAsNumber; if (Number.isFinite(v) && v !== value && (min === undefined || v >= min)) change(v); }}
    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>;
  const patch = (p: Omit<NodeUpdate, "id">) => selected && update([{ id: selected.id, ...p }]);
  return <details className="terrain-panel" open={!!terrain || !!modifier?.terrain}>
    <summary>Terrain</summary>
    <button onClick={() => create([
      { type: "group", name: "Terrain assembly", ref: "assembly" },
      { type: "group", name: "Terrain sources", parent: "$assembly", ref: "sources" },
      { type: "terrain", name: "Terrain", parent: "$assembly", source: "$sources", ...focus, width: 40, depth: 40, y: 0, resolution: 129, color: "green" },
    ])}>New terrain</button>
    <label><input type="checkbox" checked={show} onChange={toggle} />Show modifiers</label>
    {terrain && <>
      {numeric("Width", terrain.width, (width) => patch({ width }), 0.5)}
      {numeric("Depth", terrain.depth, (depth) => patch({ depth }), 0.5)}
      {numeric("Base elevation", terrain.y, (y) => patch({ y }))}
      <label>Resolution<select value={terrain.resolution} onChange={(e) => patch({ resolution: Number(e.target.value) as Terrain["resolution"] })}>
        {[129, 257, 513, 1025].map((n) => <option key={n} value={n}>{n} × {n}</option>)}
      </select></label>
      <small>{(terrain.width / (terrain.resolution - 1)).toFixed(2)} × {(terrain.depth / (terrain.resolution - 1)).toFixed(2)} m per cell</small>
      {terrain.source && <button onClick={() => enter(terrain.source!)}>Draw in sources</button>}
      <small>Draw volume boxes or cylinders in the source group. Reorder them in the outliner.</small>
    </>}
    {modifier && <>
      {numeric("Height", modifier.height, (height) => patch({ height }), 0.05)}
      {numeric("Elevation", modifier.y, (y) => patch({ y }))}
      {numeric("Width", modifier.width, (width) => patch({ width }), 0.05)}
      {numeric("Depth", modifier.depth, (depth) => patch({ depth }), 0.05)}
      <label>Operation<select value={modifier.terrain?.operation ?? "raise"} onChange={(e) => patch({ terrain: { fade: modifier.terrain?.fade ?? 0, operation: e.target.value as "raise" | "lower" | "set" } })}>
        <option value="raise">Raise</option><option value="lower">Lower</option><option value="set">Set</option>
      </select></label>
      {numeric("Fade (m)", modifier.terrain?.fade ?? 0, (fade) => patch({ terrain: { operation: modifier.terrain?.operation ?? "raise", fade } }), 0)}
      <small>Applies while this shape is in a terrain source group.</small>
    </>}
  </details>;
}

import { useEffect, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Circle,
  CircleDashed,
  Folder,
  Square,
  SquareDashed,
  Squircle,
  SquircleDashed,
  TriangleAlert,
  Waypoints,
} from "lucide-react";
import { isHole } from "../shared/holes";
import type { SceneNode } from "../shared/scene.types";
import { ancestry, childrenOf, isGroup, subtreeIds } from "../shared/tree";

// A hole uses its shape's solid icon, drawn dotted (the `hole` class).
const SHAPE_ICONS = {
  box: { room: SquareDashed, volume: Square, hole: Square },
  cylinder: { room: CircleDashed, volume: Circle, hole: Circle },
  freeform: { room: SquircleDashed, volume: Squircle, hole: Squircle },
} as const;
/** The icon for a node: a folder for a group, a line's own, a closed shape's by type and kind. */
const iconOf = (node: SceneNode) => (isGroup(node) ? Folder : node.type === "line" ? Waypoints : SHAPE_ICONS[node.type][node.kind]);

type Row = { node: SceneNode; depth: number; hasChildren: boolean };
type Drop = { id: string | null; where: "before" | "after" | "into" | "end" };

/** The visible rows: a depth-first walk of the tree, skipping the insides of collapsed groups. */
function rowsOf(nodes: SceneNode[], collapsed: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const node of childrenOf(nodes, parent)) {
      const hasChildren = isGroup(node) && nodes.some((n) => n.parent === node.id);
      rows.push({ node, depth, hasChildren });
      if (hasChildren && !collapsed.has(node.id)) walk(node.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

/**
 * The outliner: the node tree as a collapsible panel on the left. Click selects (Shift or Cmd/Ctrl toggles),
 * double-click renames, dragging a row drops it before, after or into another (groups only), hovering a row
 * highlights its boxes in the view. Selecting something inside a collapsed group expands its ancestors.
 */
export function Outliner({
  nodes,
  selection,
  onSelect,
  onHover,
  onRename,
  onPlace,
}: {
  nodes: SceneNode[];
  selection: string[];
  /** The new selection, and the group it's in (the view's entered group; null = top level). */
  onSelect: (ids: string[], context: string | null) => void;
  onHover: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onPlace: (ids: string[], parent: string | null, before: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  // Reveal the selection: expand every collapsed group above a selected node.
  const selectionKey = selection.join(",");
  useEffect(() => {
    setCollapsed((c) => {
      const above = new Set(selection.flatMap((id) => ancestry(nodes, id).slice(1)));
      return [...c].some((id) => above.has(id)) ? new Set([...c].filter((id) => !above.has(id))) : c;
    });
    // Only when the selection changes, not on every scene.
  }, [selectionKey]);

  const rows = rowsOf(nodes, collapsed);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const toggleCollapsed = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const onRowClick = (e: MouseEvent, node: SceneNode) => {
    const context = node.parent ?? null;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      onSelect(selection.includes(node.id) ? selection.filter((id) => id !== node.id) : [...selection, node.id], context);
    } else {
      onSelect([node.id], context);
    }
  };

  const commitRename = () => {
    if (!renaming) return;
    const node = byId.get(renaming.id);
    if (node && renaming.value.trim() !== (node.name ?? "")) onRename(renaming.id, renaming.value.trim());
    setRenaming(null);
  };

  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setRenaming(null);
  };

  /** Whether the dragged nodes may land relative to `target` (not onto or inside themselves). */
  const canDropAt = (target: SceneNode) =>
    !!dragging && !dragging.some((id) => subtreeIds(nodes, id).has(target.id));

  const onRowDragOver = (e: DragEvent, row: Row) => {
    if (!canDropAt(row.node)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    const where = isGroup(row.node) ? (f < 0.25 ? "before" : f > 0.75 ? "after" : "into") : f < 0.5 ? "before" : "after";
    if (drop?.id !== row.node.id || drop.where !== where) setDrop({ id: row.node.id, where });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const ids = dragging;
    setDragging(null);
    setDrop(null);
    if (!ids || !drop) return;
    if (drop.where === "end" || drop.id === null) return onPlace(ids, null, null);
    const target = byId.get(drop.id)!;
    if (drop.where === "into") return onPlace(ids, target.id, null);
    const parent = target.parent ?? null;
    if (drop.where === "before") return onPlace(ids, parent, target.id);
    // After: before the next sibling that isn't itself being moved, or last.
    const siblings = childrenOf(nodes, target.parent);
    const next = siblings.slice(siblings.indexOf(target) + 1).find((n) => !ids.includes(n.id));
    onPlace(ids, parent, next?.id ?? null);
  };

  return (
    <div className={open ? "outliner" : "outliner closed"}>
      <div className="outliner-header">
        <button className="outliner-toggle" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Outliner
          <span className="muted">{nodes.length}</span>
        </button>
        {open && (
          <button
            className="outliner-action"
            title="Collapse all groups"
            onClick={() => setCollapsed(new Set(nodes.filter(isGroup).map((n) => n.id)))}
          >
            <ChevronsDownUp size={14} />
          </button>
        )}
      </div>
      {open && (
        <div
          className={drop?.where === "end" ? "outliner-rows drop-end" : "outliner-rows"}
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            if (drop?.where !== "end") setDrop({ id: null, where: "end" });
          }}
          onDrop={onDrop}
          onMouseLeave={() => onHover(null)}
        >
          {rows.length === 0 && <div className="outliner-empty">No boxes yet</div>}
          {rows.map((row) => {
            const { node, depth, hasChildren } = row;
            // Rooms are dashed (hollow), volumes solid: squares for boxes, circles for cylinders, squircles for free-forms.
            const Icon = iconOf(node);
            const classes = ["outliner-row"];
            if (selection.includes(node.id)) classes.push("selected");
            if (drop?.id === node.id) classes.push(`drop-${drop.where}`);
            return (
              <div
                key={node.id}
                className={classes.join(" ")}
                style={{ paddingLeft: 6 + depth * 14 }}
                draggable={renaming?.id !== node.id}
                onClick={(e) => onRowClick(e, node)}
                onDoubleClick={() => setRenaming({ id: node.id, value: node.name ?? "" })}
                onMouseEnter={() => onHover(node.id)}
                onDragStart={(e) => {
                  setDragging(selection.includes(node.id) ? selection : [node.id]);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", node.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDrop(null);
                }}
                onDragOver={(e) => onRowDragOver(e, row)}
                onDrop={onDrop}
              >
                <span
                  className="chevron"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasChildren) toggleCollapsed(node.id);
                  }}
                >
                  {hasChildren && (collapsed.has(node.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />)}
                </span>
                <Icon size={13} className={isHole(node) ? "icon hole" : "icon"} />
                {renaming?.id === node.id ? (
                  <input
                    autoFocus
                    value={renaming.value}
                    placeholder={node.id}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setRenaming({ id: node.id, value: e.target.value })}
                    onKeyDown={onRenameKey}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="label">{node.name ?? node.id}</span>
                    {node.name && <span className="id">{node.id}</span>}
                    {isHole(node) && node.parent === undefined && (
                      <span className="warn" title="Not in a group: this hole cuts nothing">
                        <TriangleAlert size={12} />
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

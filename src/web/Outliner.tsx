import { useEffect, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Circle,
  Eye,
  EyeOff,
  CircleDashed,
  Focus,
  Folder,
  Grid3x3,
  Lock,
  LockOpen,
  Square,
  SquareDashed,
  Squircle,
  SquircleDashed,
  Package,
  StickyNote,
  TriangleAlert,
  Waypoints,
} from "lucide-react";
import { arrayItems } from "../shared/arrays";
import { isHole } from "../shared/holes";
import { Stairs } from "./icons";
import type { SceneNode } from "../shared/scene.types";
import { ancestry, childrenOf, hiddenIds, isGroup, lockedIds, subtreeIds } from "../shared/tree";

// A hole uses its shape's solid icon, drawn dotted (the `hole` class).
const SHAPE_ICONS = {
  box: { room: SquareDashed, volume: Square, hole: Square },
  cylinder: { room: CircleDashed, volume: Circle, hole: Circle },
  freeform: { room: SquircleDashed, volume: Squircle, hole: Squircle },
} as const;
/** The icon for a node: a folder for a group, a line's own, a closed shape's by type and kind. */
const iconOf = (node: SceneNode) =>
  node.type === "terrain" ? Grid3x3 : isGroup(node)
    ? Folder
    : node.type === "line"
      ? Waypoints
      : node.type === "ramp"
        ? Stairs
        : node.type === "note"
          ? StickyNote
          : node.type === "instance"
            ? Package
            : node.type === "array"
              ? Grid3x3
              : SHAPE_ICONS[node.type][node.kind];

/** A row's label: the name, else an instance's entity's name, else a note's label and the start of its text, else the ID. */
const labelOf = (node: SceneNode, entityNames: Record<string, string>) => {
  if (node.name) return node.name;
  if (node.type === "instance") return entityNames[node.entity] ?? `missing entity ${node.entity}`;
  if (node.type === "array") return `array of ${node.entities.map((e) => entityNames[e.entity] ?? e.entity).join(", ")} (${arrayItems(node).length})`;
  if (node.type !== "note") return node.id;
  const text = node.text.split("\n")[0].trim();
  const start = text.length > 28 ? `${text.slice(0, 28)}…` : text;
  return [node.label, start].filter(Boolean).join(" · ") || node.id;
};

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
 * highlights its boxes in the view. Selecting something inside a collapsed group expands its ancestors. Each row
 * has an eye (a hidden node and what's in it aren't drawn), a lock (a locked node and what's in it can't be picked
 * in the view; the outliner still selects them) and an isolate button (only that node and what's in it show),
 * shown on hover or while on; rows that don't show in the view are dimmed.
 */
export function Outliner({
  nodes,
  selection,
  onSelect,
  onHover,
  onRename,
  onPlace,
  isolated,
  visible,
  onIsolate,
  onLock,
  onHide,
  onFrame,
  entityNames = {},
  entityMode = false,
}: {
  nodes: SceneNode[];
  selection: string[];
  /** The new selection, and the group it's in (the view's entered group; null = top level). */
  onSelect: (ids: string[], context: string | null) => void;
  onHover: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onPlace: (ids: string[], parent: string | null, before: string | null) => void;
  /** The isolated node (null = everything shows), and isolating one (or ending it: null). */
  isolated: string | null;
  /** What the view shows while isolated (the isolated node's subtree, and what's new since); null = everything. */
  visible: Set<string> | null;
  onIsolate: (id: string | null) => void;
  onLock: (id: string, locked: boolean) => void;
  onHide: (id: string, hidden: boolean) => void;
  /** Frame a node: the camera flies to it (double-clicking its icon). */
  onFrame: (id: string) => void;
  /** Entity names by ID, for instances' rows. */
  entityNames?: Record<string, string>;
  /** Editing an entity: a top-level hole is fine there (no warning). */
  entityMode?: boolean;
}) {
  const locked = lockedIds(nodes);
  const hidden = hiddenIds(nodes);

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
            if (visible && !visible.has(node.id)) classes.push("outside");
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
                <span
                  className="icon-target"
                  title="Double-click to frame it"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onFrame(node.id);
                  }}
                >
                  <Icon size={13} className={isHole(node) ? "icon hole" : "icon"} />
                </span>
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
                    <span className={node.type === "note" && node.status === "done" ? "label done" : "label"} title={node.type === "group" ? node.description : node.type === "note" ? node.text : undefined}>
                      {labelOf(node, entityNames)}
                    </span>
                    {isHole(node) && node.parent === undefined && !entityMode && (
                      <span className="warn" title="Not in a group: this hole cuts nothing">
                        <TriangleAlert size={12} />
                      </span>
                    )}
                    <span className="row-actions">
                      <button
                        type="button"
                        className={node.hidden ? "row-action on" : hidden.has(node.id) ? "row-action inherited" : "row-action"}
                        title={
                          node.hidden ? "Show: draw it again" : hidden.has(node.id) ? "Hidden by a group it's in" : "Hide: don't draw it (a hidden hole cuts nothing)"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onHide(node.id, !node.hidden);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        {hidden.has(node.id) ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                      <button
                        type="button"
                        className={node.locked ? "row-action on" : locked.has(node.id) ? "row-action inherited" : "row-action"}
                        title={
                          node.locked
                            ? "Unlock: pick it in the view again"
                            : locked.has(node.id)
                              ? "Locked by a group it's in"
                              : "Lock: it can't be picked in the view (the outliner still selects it)"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onLock(node.id, !node.locked);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        {locked.has(node.id) ? <Lock size={12} /> : <LockOpen size={12} />}
                      </button>
                      <button
                        type="button"
                        className={isolated === node.id ? "row-action on" : "row-action"}
                        title={isolated === node.id ? "End isolation: show everything (I)" : "Isolate: show only this and what's in it (I)"}
                        onClick={(e) => {
                          e.stopPropagation();
                          onIsolate(isolated === node.id ? null : node.id);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <Focus size={12} />
                      </button>
                    </span>
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

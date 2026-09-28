import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GripVertical, MousePointerClick, Package, PencilRuler, Search } from "lucide-react";
import { definitionOf } from "../shared/entities";
import { boundsOf } from "../shared/geometry";
import type { Library, LibraryEdit, Uses } from "../shared/library";
import { isShape } from "../shared/tree";
import { useFloating } from "./floating";
import { EntityEditor } from "./Library";
import { searchEntities } from "./search";
import { ENTITY_DRAG } from "./Viewport";

/**
 * The Entities panel (from 08.4): the project's prefabs, a floating panel like the inspector (dragged by its header,
 * collapsible, remembered per viewer), with a fuzzy search by name, tag or skill. Drag a row into the view to place
 * one, or press its place button and click. Clicking a row opens its name, description and tags (every instance
 * carries them) and Delete. Entities are made with Make entity in the inspector.
 */

/** An entity's size, from its definition's bounds: `1.2 × 1.2 × 9 m`. */
function sizeText(id: string) {
  const shapes = (definitionOf(id) ?? []).filter(isShape);
  if (shapes.length === 0) return "no shapes";
  const b = boundsOf(shapes);
  const r = (n: number) => Math.round(n * 100) / 100;
  return `${r(b.maxX - b.minX)} × ${r(b.maxZ - b.minZ)} × ${r(b.maxY - b.minY)} m`;
}

export function EntitiesPanel({
  library,
  uses,
  edit,
  placing,
  onPlace,
  onEdit,
  editing,
}: {
  library: Library;
  uses: Uses;
  edit: (e: LibraryEdit) => void;
  /** The entity being placed (its ID), and starting or stopping placing one. */
  placing: string | null;
  onPlace: (entity: string) => void;
  /** Edit entity: open one's definition. */
  onEdit: (entity: string) => void;
  /** The entity open for editing, if any. */
  editing: string | null;
}) {
  const { ref, header, style, collapsed, toggle } = useFloating("dd.entities", ".entities-header");
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => searchEntities(library, query), [library, query]);
  const searching = query.trim() !== "";

  return (
    <div className={collapsed ? "entities-panel collapsed" : "entities-panel"} ref={ref} style={style}>
      <div className="entities-header" {...header} title="Drag to move the Entities panel · double-click to put it back">
        <GripVertical size={13} className="grip" />
        <span className="entities-title">Entities</span>
        <span className="muted">{searching ? `${shown.length} of ${library.entities.length}` : library.entities.length}</span>
        <button type="button" className="outliner-action" title={collapsed ? "Show the entities" : "Collapse"} onClick={toggle}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      {!collapsed && library.entities.length > 0 && (
        <label className="entities-search" title="Fuzzy search: a name, #tag or @skill (every word must match)">
          <Search size={12} className="icon" />
          <input
            type="search"
            value={query}
            placeholder="Search: name, #tag, @skill"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              if (query !== "") setQuery("");
              else e.currentTarget.blur();
            }}
          />
        </label>
      )}
      {!collapsed && (
        <div className="outliner-rows">
          {library.entities.length === 0 && (
            <div className="outliner-empty">
              None yet: select shapes and press <b>Make entity</b> in the inspector.
            </div>
          )}
          {searching && shown.length === 0 && <div className="outliner-empty">No entity matches.</div>}
          {shown.map((e) => {
            const u = uses.entities[e.id];
            const expanded = openId === e.id;
            return (
              <div key={e.id} className={expanded ? "entity-item open" : "entity-item"}>
                <div
                  className={placing === e.id || editing === e.id ? "outliner-row selected" : "outliner-row"}
                  draggable
                  title={`${e.description ? `${e.description}\n\n` : ""}${sizeText(e.id)} · drag into the view to place one`}
                  onDragStart={(ev) => {
                    ev.dataTransfer.setData(ENTITY_DRAG, e.id);
                    ev.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => setOpenId(expanded ? null : e.id)}
                >
                  <span className="chevron">{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                  <Package size={13} className="icon" />
                  <span className="label">{e.name}</span>
                  <span className="id" title={u ? `in ${u.sceneNames.join(", ")}` : undefined}>
                    {u ? `${u.nodes} placed` : "unused"}
                  </span>
                  <button
                    type="button"
                    className={editing === e.id ? "outliner-action on" : "outliner-action"}
                    title={editing === e.id ? "Being edited" : "Edit entity: change its shapes; every instance follows"}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onEdit(e.id);
                    }}
                  >
                    <PencilRuler size={13} />
                  </button>
                  <button
                    type="button"
                    className={placing === e.id ? "outliner-action on" : "outliner-action"}
                    title={placing === e.id ? "Stop placing (Esc)" : "Place one: click on a surface in the view"}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onPlace(e.id);
                    }}
                  >
                    <MousePointerClick size={13} />
                  </button>
                </div>
                {expanded && (
                  <div className="entity-editor">
                    <EntityEditor meta={e} library={library} edit={edit} />
                    <div className="entity-size">{sizeText(e.id)}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

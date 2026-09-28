import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, MousePointerClick, Package } from "lucide-react";
import { definitionOf } from "../shared/entities";
import { boundsOf } from "../shared/geometry";
import type { Library, LibraryEdit, Uses } from "../shared/library";
import { isShape } from "../shared/tree";
import { EntityEditor } from "./Library";
import { ENTITY_DRAG } from "./Viewport";

/**
 * The Entities panel (from 08.4): the project's prefabs, under the outliner, collapsible like it (remembered per
 * viewer). Drag a row into the view to place one, or press its place button and click. Clicking a row opens its
 * name, description and tags (every instance carries them) and Delete. Entities are made with Make entity in the
 * inspector.
 */

const OPEN_KEY = "dd.entities.open";

const loadOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
};

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
}: {
  library: Library;
  uses: Uses;
  edit: (e: LibraryEdit) => void;
  /** The entity being placed (its ID), and starting or stopping placing one. */
  placing: string | null;
  onPlace: (entity: string) => void;
}) {
  const [open, setOpen] = useState(loadOpen);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      // A convenience only.
    }
  }, [open]);

  return (
    <div className={open ? "outliner entities-panel" : "outliner entities-panel closed"}>
      <div className="outliner-header">
        <button className="outliner-toggle" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Entities
          <span className="muted">{library.entities.length}</span>
        </button>
      </div>
      {open && (
        <div className="outliner-rows">
          {library.entities.length === 0 && (
            <div className="outliner-empty">
              None yet: select shapes and press <b>Make entity</b> in the inspector.
            </div>
          )}
          {library.entities.map((e) => {
            const u = uses.entities[e.id];
            const expanded = openId === e.id;
            return (
              <div key={e.id} className={expanded ? "entity-item open" : "entity-item"}>
                <div
                  className={placing === e.id ? "outliner-row selected" : "outliner-row"}
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

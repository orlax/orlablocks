import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Package, Search } from "lucide-react";
import { boundsOf, round2 } from "../shared/geometry";
import { definitionOf } from "../shared/entities";
import { currentTags, type Library } from "../shared/library";
import { isShape } from "../shared/tree";
import { searchEntities } from "./search";

/** The list's height at most (px), and how far below the button it opens. */
const LIST_MAX = 320;
const GAP = 4;

/** An entity's size, `1.2 × 0.6 × 2 m`, from its definition (empty for one with no shapes). */
function sizeOf(id: string): string {
  const shapes = (definitionOf(id) ?? []).filter(isShape);
  if (shapes.length === 0) return "";
  const b = boundsOf(shapes);
  return `${round2(b.maxX - b.minX)} × ${round2(b.maxZ - b.minZ)} × ${round2(b.maxY - b.minY)} m`;
}

/**
 * Picks an entity from the project library: a button with the entity's name that opens a searchable list (the
 * Entities panel's fuzzy search: a name, #tag or @skill), for libraries far past what a plain select can show. ↑ / ↓
 * move through the matches, Enter picks, Esc or a click outside closes. The list floats over everything (a portal),
 * so the inspector's scrolling doesn't clip it.
 */
export function EntityPicker({ value, library, title, onPick }: { value: string; library: Library; title: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => searchEntities(library, query), [library, query]);
  const current = library.entities.find((e) => e.id === value);

  // Under the button, or above it when there's no room below; as wide as the button, at least 260 px.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = Math.max(r.width, 260);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    const up = window.innerHeight - r.bottom < LIST_MAX + 60 && r.top > window.innerHeight - r.bottom;
    setPlace({ left, top: up ? r.top - GAP : r.bottom + GAP, width, up });
  }, [open]);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  // The active row stays in view.
  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const show = () => {
    setQuery("");
    setActive(Math.max(0, library.entities.findIndex((e) => e.id === value)));
    setOpen(true);
  };
  const pick = (id: string) => {
    setOpen(false);
    if (id !== value) onPick(id);
  };

  return (
    <>
      <button ref={button} type="button" className="entity-button" title={title} onClick={() => (open ? setOpen(false) : show())}>
        <Package size={13} className="icon" />
        <span className="name">{current ? current.name : `missing: ${value}`}</span>
        <ChevronDown size={13} className="icon" />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panel}
            className="entity-list"
            style={{ left: place.left, width: place.width, ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }) }}
          >
            <label className="entities-search">
              <Search size={12} className="icon" />
              <input
                autoFocus
                type="search"
                value={query}
                placeholder={`Search ${library.entities.length} entities: name, #tag, @skill`}
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const step = e.key === "ArrowDown" ? 1 : -1;
                    setActive((a) => Math.min(shown.length - 1, Math.max(0, a + step)));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (shown[active]) pick(shown[active].id);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                    button.current?.focus();
                  }
                }}
              />
            </label>
            <div ref={list} className="entity-list-rows" style={{ maxHeight: LIST_MAX }}>
              {shown.length === 0 && <div className="outliner-empty">No entity matches.</div>}
              {shown.map((e, i) => {
                const tags = currentTags(library, e.tags);
                return (
                  <div
                    key={e.id}
                    className={["entity-option", i === active ? "active" : "", e.id === value ? "current" : ""].join(" ").trim()}
                    title={e.description || e.name}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => pick(e.id)}
                  >
                    <Package size={13} className="icon" />
                    <span className="name">{e.name}</span>
                    {tags.length > 0 && <span className="tags">{tags.map((t) => `#${t}`).join(" ")}</span>}
                    <span className="size">{sizeOf(e.id)}</span>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

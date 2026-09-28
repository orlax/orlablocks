import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Floating panels (the inspector, the Entities panel): dragged by their header, collapsible, and remembered per
 * viewer under `storeKey`.
 */

type Placement = { x?: number; y?: number; collapsed?: boolean };

function loadPlacement(key: string): Placement {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? "{}");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
function savePlacement(key: string, p: Placement) {
  try {
    localStorage.setItem(key, JSON.stringify(p));
  } catch {
    // No storage (a private window, blocked site data): the placement lasts for this tab only.
  }
}

/**
 * A panel's placement: where the header (the element matching `headerSelector`) was dragged to (none = its place in
 * the stylesheet), and whether it's collapsed. The header always stays inside the window, also when the window
 * shrinks. Double-clicking the header puts the panel back.
 */
export function useFloating(storeKey: string, headerSelector: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>(() => loadPlacement(storeKey));
  const grab = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

  const clamp = (x: number, y: number) => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.querySelector<HTMLElement>(headerSelector)?.offsetHeight ?? 32;
    return { x: Math.round(Math.min(Math.max(0, x), Math.max(0, innerWidth - w))), y: Math.round(Math.min(Math.max(0, y), Math.max(0, innerHeight - h))) };
  };

  // Back on screen after a resize (or a placement saved on a bigger window).
  useLayoutEffect(() => {
    const fit = () =>
      setPlacement((p) => {
        if (p.x === undefined || p.y === undefined) return p;
        const c = clamp(p.x, p.y);
        return c.x === p.x && c.y === p.y ? p : { ...p, ...c };
      });
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, []);
  // Saved as it changes (a drag writes a few small values per frame).
  useEffect(() => savePlacement(storeKey, placement), [storeKey, placement]);

  const header = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
      const r = ref.current!.getBoundingClientRect();
      grab.current = { pointerId: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = grab.current;
      if (!g || g.pointerId !== e.pointerId) return;
      setPlacement((p) => ({ ...p, ...clamp(e.clientX - g.dx, e.clientY - g.dy) }));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (grab.current?.pointerId === e.pointerId) grab.current = null;
    },
    onPointerCancel: () => void (grab.current = null),
    onDoubleClick: (e: ReactMouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("button, input")) return;
      setPlacement({ collapsed: placement.collapsed });
    },
  };
  const style = placement.x !== undefined && placement.y !== undefined ? { left: placement.x, top: placement.y, right: "auto", bottom: "auto" } : undefined;
  return { ref, header, style, collapsed: !!placement.collapsed, toggle: () => setPlacement({ ...placement, collapsed: !placement.collapsed }) };
}

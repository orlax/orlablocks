import { useCallback, useLayoutEffect, useMemo, useState } from "react";

export const PANEL_ROW_HEIGHT = 24;
const OVERSCAN = 5;
type Expanded = { index: number; extra: number };

export function rowTop(index: number, expanded?: Expanded) {
  return index * PANEL_ROW_HEIGHT + (expanded && index > expanded.index ? expanded.extra : 0);
}

function rowAt(offset: number, expanded?: Expanded) {
  if (expanded && offset >= (expanded.index + 1) * PANEL_ROW_HEIGHT) {
    return Math.max(expanded.index, Math.floor((offset - expanded.extra) / PANEL_ROW_HEIGHT));
  }
  return Math.floor(offset / PANEL_ROW_HEIGHT);
}

export function visibleRows(count: number, scroll: number, height: number, pins: number[], expanded?: Expanded): number[] {
  if (!count) return [];
  const top = Math.max(0, Math.min(scroll, rowTop(count, expanded) - height));
  const first = Math.max(0, rowAt(top, expanded) - OVERSCAN);
  const stop = Math.min(count, rowAt(top + height, expanded) + OVERSCAN + 1);
  const rows = new Set(Array.from({ length: Math.max(0, stop - first) }, (_, i) => first + i));
  for (const pin of pins) if (pin >= 0 && pin < count) rows.add(pin);
  return [...rows].sort((a, b) => a - b);
}

/** Both panels keep the full scroll height while mounting the viewport, overscan, and active rows. */
export function useVirtualRows(count: number, pins: number[], expanded?: Expanded) {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const read = () => {
      setHeight(element.clientHeight);
      setScroll(element.scrollTop);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const totalHeight = rowTop(count, expanded);
  const indices = visibleRows(count, scroll, height, pins, expanded);
  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScroll(event.currentTarget.scrollTop);
  }, []);
  const reveal = useCallback((index: number) => {
    if (!element || index < 0) return;
    const top = rowTop(index, expanded);
    const bottom = top + PANEL_ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    setScroll(element.scrollTop);
  }, [element, expanded]);
  return { ref, element, indices, totalHeight, onScroll, reveal };
}

export function useMeasuredRow() {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<{ element: HTMLDivElement; height: number }>();
  useLayoutEffect(() => {
    if (!element) return;
    const read = () => setMeasured((previous) => {
      const height = element.offsetHeight;
      return previous?.element === element && previous.height === height ? previous : { element, height };
    });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return useMemo(() => ({ ref, height: measured?.element === element ? measured?.height ?? 0 : 0 }), [ref, measured, element]);
}

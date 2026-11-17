import { useLayoutEffect, useRef } from "react";

/** Reuse the committed list when a new snapshot delivers the same ordered inputs. */
export function useStableList<T>(next: T[], equal: (a: T, b: T) => boolean = Object.is): T[] {
  const previous = useRef(next);
  const result = previous.current.length === next.length && next.every((entry, i) => equal(entry, previous.current[i]))
    ? previous.current : next;
  useLayoutEffect(() => { previous.current = result; }, [result]);
  return result;
}

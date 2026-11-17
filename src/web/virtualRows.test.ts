import { expect, it } from "vitest";
import { PANEL_ROW_HEIGHT, rowTop, visibleRows } from "./virtualRows";

it("mounts a bounded window and keeps focused, dragged and renamed rows available", () => {
  const rows = visibleRows(2_000, 1_000 * PANEL_ROW_HEIGHT, 240, [2, 1_995, 1_002, -1]);
  expect(rows[0]).toBe(2);
  expect(rows.at(-1)).toBe(1_995);
  expect(rows).toContain(1_000);
  expect(rows).toContain(1_009);
  expect(rows.length).toBeLessThan(25);
  expect(rows.filter((row) => row === 1_002)).toHaveLength(1);
});

it("maps the measured entity editor into scroll offsets and handles a list that shrinks", () => {
  const expanded = { index: 14, extra: 336 };
  expect(rowTop(14, expanded)).toBe(336);
  expect(rowTop(15, expanded)).toBe(696);
  expect(visibleRows(500, 510, 100, [], expanded)).toContain(14);
  expect(visibleRows(2, 9_000, 100, [], undefined)).toEqual([0, 1]);
  expect(visibleRows(0, 0, 240, [0])).toEqual([]);
});

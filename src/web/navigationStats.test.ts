import { describe, expect, it } from "vitest";
import { NavigationStats, beginCaptureTiming, endCaptureTiming, captureTiming } from "./navigationStats";
describe("navigation pacing", () => {
  it("excludes idle and the first resumed frame", () => {
    const s = new NavigationStats();
    s.frame(0, true); s.frame(20, true); expect(s.snapshot()?.fps).toBe(50);
    s.frame(40, false); s.frame(10000, true); expect(s.snapshot()).toBeNull();
    s.frame(10020, true); expect(s.snapshot()?.ms).toBe(20);
  });
  it("excludes a released-input pause even when no idle frame was rendered", () => {
    const s = new NavigationStats();
    s.frame(0, true, 0); s.frame(16, true, 0);
    s.frame(200, true, 1); expect(s.snapshot()).toBeNull();
    s.frame(216, true, 1); expect(s.snapshot()?.ms).toBe(16);
  });
  it("aggregates elapsed time, bounds the window and retains sustained hitches", () => {
    const s = new NavigationStats(20, 3);
    [0, 10, 30, 60, 1060].forEach(t => s.frame(t, true));
    expect(s.snapshot()).toEqual({ fps: 1000 / 350, ms: 350, median: 30, p95: 1000, slow: 2, samples: 3 });
  });
  it("resets background/pause/capture boundaries without adding an interval", () => {
    const s = new NavigationStats(); s.frame(1, true); s.frame(17, true);
    s.reset(); s.frame(5000, true); expect(s.snapshot()).toBeNull();
    const before = captureTiming().epoch;
    beginCaptureTiming(); beginCaptureTiming(); expect(captureTiming().active).toBe(true);
    endCaptureTiming(); expect(captureTiming().active).toBe(true);
    endCaptureTiming(); expect(captureTiming()).toEqual({ active: false, epoch: before + 4 });
  });
});

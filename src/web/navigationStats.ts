/** Frame pacing for explicitly active navigation, never demand-render idle time. */
export class NavigationStats {
  private epoch = 0;
  private previous: number | null = null;
  private intervals: number[] = [];
  constructor(readonly budget = 1000 / 60, readonly capacity = 120) {}
  reset() { this.previous = null; this.intervals = []; }
  frame(now: number, active: boolean, epoch = 0) {
    if (epoch !== this.epoch) { this.reset(); this.epoch = epoch; }
    if (!active) { this.reset(); return; }
    if (this.previous !== null && now > this.previous) {
      this.intervals.push(now - this.previous);
      if (this.intervals.length > this.capacity) this.intervals.shift();
    }
    this.previous = now;
  }
  snapshot() {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    if (!sorted.length) return null;
    const ms = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
    return { fps: 1000 / ms, ms, median: sorted[Math.ceil(sorted.length * .5) - 1],
      p95: sorted[Math.ceil(sorted.length * .95) - 1], slow: sorted.filter(n => n > this.budget).length, samples: sorted.length };
  }
}

// Capture contexts are separate renderers, but their CPU/GPU work can interrupt the editor.
let captures = 0;
let epoch = 0;
export const captureTiming = () => ({ active: captures > 0, epoch });
export function beginCaptureTiming() { captures++; epoch++; }
export function endCaptureTiming() { captures--; epoch++; }

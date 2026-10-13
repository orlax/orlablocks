import { describe, expect, it, vi } from "vitest";
import { valueStore } from "./valueStore";

describe("local readout store", () => {
  it("publishes a coherent snapshot to independent readouts, without redundant notifications", () => {
    const store = valueStore<number | null>(null);
    const seen: (number | null)[] = [];
    const first = store.subscribe(() => seen.push(store.get()));
    const second = vi.fn();
    const unsubscribe = store.subscribe(second);
    store.set(1);
    store.set(1);
    unsubscribe();
    store.set(2);
    expect(seen).toEqual([1, 2]);
    expect(second).toHaveBeenCalledTimes(1);
    first();
    store.set(3);
    expect(store.get()).toBe(3);
    expect(seen).toEqual([1, 2]);
  });
  it("retains the latest frame even with no mounted readout (toggle/remount)", () => {
    const store = valueStore({ calls: 10 });
    const latest = { calls: 20 };
    store.set(latest);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.get()).toBe(latest);
    expect(listener).not.toHaveBeenCalled();
  });
});

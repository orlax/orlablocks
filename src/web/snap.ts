import { useState } from "react";
import { SNAP, HEIGHT_SNAP } from "../shared/scene.types";

export const DEFAULT_SNAP = { translation: SNAP, elevation: HEIGHT_SNAP, rotation: 15, arrayDistance: 0.25, arrayRotation: 5 };
export type SnapSettings = typeof DEFAULT_SNAP;
export const SNAP_KEY = "orlablocks.snap";
/** Geometry and angles retain two decimal places. Steps use the same precision. */
export function validSnap(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.01 && value <= 10000 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}
export function resolveSnap(value: unknown): SnapSettings {
  const input = value && typeof value === "object" ? value as Partial<SnapSettings> : {};
  return Object.fromEntries(Object.entries(DEFAULT_SNAP).map(([key, fallback]) => [key, validSnap(input[key as keyof SnapSettings]) ? input[key as keyof SnapSettings] : fallback])) as SnapSettings;
}
export function useSnapSettings() {
  const [settings, setSettings] = useState(() => {
    try { return resolveSnap(JSON.parse(localStorage.getItem(SNAP_KEY) ?? "null")); } catch { return { ...DEFAULT_SNAP }; }
  });
  return [settings, (next: SnapSettings) => {
    const resolved = resolveSnap(next);
    setSettings(resolved);
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(resolved)); } catch { /* Storage is optional. */ }
  }] as const;
}

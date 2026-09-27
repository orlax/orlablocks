import { useSyncExternalStore } from "react";

/**
 * The editor's error log: everything that went wrong in this tab (a render crash caught by an error boundary, an
 * uncaught error or rejected promise, an error the server sent back), so nothing fails silently. The error panel
 * shows it. Kept in memory for the tab's lifetime; the same message again just counts up.
 */

export type ErrorSource = "view" | "editor" | "script" | "promise" | "server";
export type LoggedError = { id: number; at: number; source: ErrorSource; message: string; detail?: string; count: number };

const MAX_ERRORS = 50;
let errors: LoggedError[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const describe = (error: unknown) => {
  if (error instanceof Error) return { message: error.message || error.name, detail: error.stack };
  return { message: typeof error === "string" ? error : JSON.stringify(error) ?? String(error) };
};

/** Logs an error. `detail` adds to the error's own stack (a React component stack, say). */
export function reportError(source: ErrorSource, error: unknown, detail?: string) {
  const d = describe(error);
  const full = [d.detail, detail].filter(Boolean).join("\n") || undefined;
  const last = errors.at(-1);
  if (last && last.source === source && last.message === d.message) {
    errors = [...errors.slice(0, -1), { ...last, at: Date.now(), count: last.count + 1 }];
  } else {
    errors = [...errors, { id: nextId++, at: Date.now(), source, message: d.message, detail: full, count: 1 }].slice(-MAX_ERRORS);
  }
  listeners.forEach((l) => l());
}

export function clearErrors() {
  errors = [];
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useErrors = () => useSyncExternalStore(subscribe, () => errors);

/** Logs uncaught errors and unhandled promise rejections (from event handlers, the render loop, timers). */
export function installGlobalErrorLog() {
  window.addEventListener("error", (e) => reportError("script", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => reportError("promise", e.reason));
}

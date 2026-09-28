/**
 * The editor's theme (plan 12): System (the default) follows the OS, Light and Dark override it. The choice is per
 * browser, in localStorage, and shows as `data-theme` on `<html>` (none for System), which `src/ui/theme.css` reads.
 * The 3D view isn't part of it.
 */
export type ThemeChoice = "system" | "light" | "dark";

/** localStorage key: the theme toggle's choice. */
const THEME_KEY = "orlablocks.theme";

const ORDER: ThemeChoice[] = ["system", "light", "dark"];

/** The toggle's next choice: System → Light → Dark → System. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
}

/** A stored value as a choice (anything else, or nothing, is System). */
export function parseTheme(value: string | null | undefined): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

export function readTheme(): ThemeChoice {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** Shows a choice on `<html>` and stores it. */
export function applyTheme(choice: ThemeChoice, store = true): void {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  if (!store) return;
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // A private window: the choice lasts until the tab closes.
  }
}

/** Whether the OS asks for dark right now (what System shows). */
export function systemIsDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

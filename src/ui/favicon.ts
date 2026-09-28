/// <reference types="vite/client" />
import appleTouchIcon from "./apple-touch-icon.png";
import favicon from "./favicon.png";

/**
 * The app icon as the tab's icon (plan 12). Set from the entry script rather than the HTML: Vite resolves an
 * imported asset in dev and in the build alike, while an HTML link outside the app's root only works built.
 */
export function installFavicon(): void {
  for (const [rel, href] of [
    ["icon", favicon],
    ["apple-touch-icon", appleTouchIcon],
  ]) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = href;
    document.head.appendChild(link);
  }
}

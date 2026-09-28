import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorPanel";
import { installGlobalErrorLog, reportError } from "./errors";
import { applyTheme, readTheme } from "./theme";
import "../ui/fonts.css";
import "../ui/theme.css";
import { installFavicon } from "../ui/favicon";

installGlobalErrorLog();
// The stored theme before the first paint, so a dark choice never flashes light.
applyTheme(readTheme(), false);
installFavicon();

createRoot(document.getElementById("root")!, {
  // What no error boundary caught (the boundaries log their own).
  onUncaughtError: (error, info) => reportError("editor", error, info.componentStack ?? undefined),
}).render(
  <StrictMode>
    <ErrorBoundary scope="editor">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

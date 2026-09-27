import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorPanel";
import { installGlobalErrorLog, reportError } from "./errors";

installGlobalErrorLog();

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

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "../ui/fonts.css";
import "../ui/theme.css";
import "./styles.css";
import { installFavicon } from "../ui/favicon";

installFavicon();

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

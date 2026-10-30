import React from "react";
import ReactDOM from "react-dom/client";
// Fonts are bundled locally — the app never touches the network.
import "@fontsource-variable/inter";
import "@fontsource/lora/400.css";
import "@fontsource/lora/400-italic.css";
import "@fontsource/lora/600.css";
import "@fontsource/kalam/latin-400.css";
import "@fontsource/kalam/devanagari-400.css";
import "./styles.css";
import App from "./App";
import { applyColours, applyPageFont, watchSystemTheme } from "./lib/preferences";

applyPageFont();
applyColours();
watchSystemTheme();

// In a plain browser during development, fake the Rust backend.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

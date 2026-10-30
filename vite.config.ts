import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite config tuned for Tauri: fixed port, no screen clearing so Rust
// errors stay visible, and src-tauri excluded from the file watcher.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "safari15",
    outDir: "dist",
    // Everything is loaded from disk, so bundle size warnings are irrelevant.
    chunkSizeWarningLimit: 2000,
  },
});

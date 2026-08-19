import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// GitHub Pages serves the app from /<repo>/, so assets need that prefix. Any
// other static host serves from the root, hence the env override.
const base = process.env.VITE_BASE ?? "/PBI-data-quality/";

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});

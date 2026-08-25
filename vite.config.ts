import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * GitHub Pages serves a project site from `/<repo>/`, so every asset needs that
 * prefix or the page loads and then fetches nothing.
 *
 * The repo name is read from `GITHUB_REPOSITORY`, which Actions always sets,
 * rather than hardcoded. This repository is mirrored to more than one GitHub
 * account under names that differ in capitalisation, and Pages URLs are
 * case-sensitive even though repository names are not — a hardcoded prefix is
 * therefore wrong in every copy but one, and fails as a blank page rather than
 * an error. `VITE_BASE` still overrides for hosts that serve from the root.
 */
const repository = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.VITE_BASE ?? (repository ? `/${repository}/` : "/PBI-data-quality/");

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built as a relative bundle so the state service can serve `dist/` from any path (ADR 0024).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  clearScreen: false,
  server: { port: 1430, strictPort: true },
  envPrefix: ["VITE_"],
  build: { target: "es2022", outDir: "dist", sourcemap: false },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = `http://127.0.0.1:${process.env.GHOSTSIGN_API_PORT ?? 8787}`;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: API, changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});

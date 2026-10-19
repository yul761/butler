import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ["node-pty"] } },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
});

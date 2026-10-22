import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { applyCsp } from "./src/renderer/csp";

/** 把 index.html 里的 %BUTLER_CSP% 换成 CSP：开发服务器用放宽的版本，构建用严格的版本。 */
function csp(): Plugin {
  let dev = false;
  return {
    name: "butler-csp",
    configResolved(config) {
      dev = config.command === "serve";
    },
    transformIndexHtml: { order: "pre", handler: (html) => applyCsp(html, dev) },
  };
}

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ["node-pty"] } },
  },
  preload: {},
  renderer: {
    plugins: [react(), csp()],
  },
});

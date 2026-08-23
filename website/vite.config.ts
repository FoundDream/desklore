import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  publicDir: false,
  build: {
    outDir: "../site-dist",
    emptyOutDir: true,
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite-plus";

export default defineConfig({
  plugins: [react()],
  electron: {
    main: { entry: "src/main/index.ts" },
    preload: { entry: "src/preload/index.ts" },
    renderer: { root: "src/renderer" },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});

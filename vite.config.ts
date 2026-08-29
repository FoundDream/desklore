import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite-plus";

export default defineConfig({
  plugins: [react()],
  electron: {
    main: {
      entry: {
        index: "src/main/index.ts",
        "server-core-process": "src/server/server-core-process.ts",
      },
      ssr: {
        noExternal: [
          "@earendil-works/pi-agent-core",
          "@earendil-works/pi-ai",
          "@earendil-works/pi-telemetry",
          "openai",
          "typebox",
        ],
      },
    },
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

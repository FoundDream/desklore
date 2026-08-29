import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite-plus";

export default defineConfig({
  plugins: [react()],
  electron: {
    main: {
      entry: {
        index: "src/desktop/main/index.ts",
        "server-core-process": "src/server/runtime/process-entry.ts",
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
    preload: { entry: "src/desktop/preload/index.ts" },
    renderer: { root: "src/desktop/renderer" },
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

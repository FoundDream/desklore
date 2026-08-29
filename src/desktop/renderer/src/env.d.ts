import type { DeskLoreAPI } from "../../../shared/contracts/index.js";

declare global {
  interface Window {
    desklore: DeskLoreAPI;
  }
}

export {};

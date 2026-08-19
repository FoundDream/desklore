import type { ComputerHistoryAPI } from "../../shared/contracts.js";

declare global {
  interface Window {
    computerHistory: ComputerHistoryAPI;
  }
}

export {};

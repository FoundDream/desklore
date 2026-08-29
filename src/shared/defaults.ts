import type { ObservationPolicy } from "./contracts/index.js";

export const defaultObservationPolicy: ObservationPolicy = {
  defaultApplicationBehavior: "observe",
  defaultURLBehavior: "observe",
  allowedBundleIdentifiers: [],
  blockedBundleIdentifiers: [],
  allowedDomains: [],
  blockedDomains: [],
  blockedWindowTitles: [],
};

import path from "node:path";

export function collectorExecutableCandidates(
  appPath: string,
  resourcesPath: string,
  projectRoot: string,
): string[] {
  const relative = path.join("DeskLore Collector.app", "Contents", "MacOS", "DeskLoreCollector");
  return [
    process.env.DESKLORE_COLLECTOR_PATH,
    path.join(resourcesPath, "native", relative),
    path.join(projectRoot, "dist", relative),
    path.join(appPath, "dist", relative),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

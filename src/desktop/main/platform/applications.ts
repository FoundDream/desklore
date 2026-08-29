import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface InstalledApplicationRecord {
  bundleIdentifier: string;
  name: string;
  applicationPath: string;
  iconPath?: string;
}

interface ApplicationMetadata {
  bundleIdentifier: string;
  name: string;
  iconPath?: string;
}

interface ApplicationBundleInfo {
  bundleIdentifier?: string;
  displayName?: string;
  iconFile?: string;
  iconName?: string;
}

interface DiscoverInstalledApplicationsOptions {
  roots?: string[];
  readMetadata?: (applicationPath: string) => Promise<ApplicationMetadata | undefined>;
}

const defaultApplicationRoots = [
  "/Applications",
  "/System/Applications",
  path.join(os.homedir(), "Applications"),
];
const excludedBundleIdentifiers = new Set(["com.desklore.desktop", "com.desklore.collector"]);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const preferredICNSImageTypes = [
  "icp6",
  "ic11",
  "ic12",
  "ic07",
  "ic13",
  "ic08",
  "ic09",
  "ic10",
  "icp5",
  "icp4",
];

function executeFile(executable: string, arguments_: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export function parseMDLSApplicationMetadata(
  output: string,
  applicationPath: string,
): ApplicationMetadata | undefined {
  const [bundleIdentifier, displayName, fileSystemName] = output
    .split("\0")
    .map((value) => value.trim());
  if (
    !bundleIdentifier ||
    bundleIdentifier.length > 512 ||
    !/^[A-Za-z0-9.-]+$/.test(bundleIdentifier)
  ) {
    return undefined;
  }
  const fallbackName = path.basename(applicationPath, ".app");
  const name = displayName || path.basename(fileSystemName || "", ".app") || fallbackName;
  return { bundleIdentifier, name };
}

function plistString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validBundleIdentifier(value: string | undefined): value is string {
  return Boolean(value && value.length <= 512 && /^[A-Za-z0-9.-]+$/.test(value));
}

async function readApplicationBundleInfo(
  applicationPath: string,
): Promise<ApplicationBundleInfo | undefined> {
  try {
    const output = await executeFile("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      path.join(applicationPath, "Contents", "Info.plist"),
    ]);
    const value = JSON.parse(output) as Record<string, unknown>;
    return {
      bundleIdentifier: plistString(value.CFBundleIdentifier),
      displayName: plistString(value.CFBundleDisplayName) ?? plistString(value.CFBundleName),
      iconFile: plistString(value.CFBundleIconFile),
      iconName: plistString(value.CFBundleIconName),
    };
  } catch {
    return undefined;
  }
}

export async function resolveApplicationIconPath(
  applicationPath: string,
  iconNames: Array<string | undefined>,
): Promise<string | undefined> {
  const resourcesPath = path.join(applicationPath, "Contents", "Resources");
  let entries: string[];
  try {
    entries = await readdir(resourcesPath);
  } catch {
    return undefined;
  }
  const iconFiles = entries.filter((entry) => path.extname(entry).toLowerCase() === ".icns");
  const byLowercaseName = new Map(iconFiles.map((entry) => [entry.toLowerCase(), entry]));
  for (const iconName of iconNames) {
    if (!iconName) continue;
    const leafName = path.basename(iconName);
    const candidateNames = path.extname(leafName) ? [leafName] : [`${leafName}.icns`, leafName];
    for (const candidateName of candidateNames) {
      const match = byLowercaseName.get(candidateName.toLowerCase());
      if (match) return path.join(resourcesPath, match);
    }
  }

  const applicationName = path.basename(applicationPath, ".app").toLowerCase();
  for (const fallbackName of [`${applicationName}.icns`, "appicon.icns", "icon.icns"]) {
    const match = byLowercaseName.get(fallbackName);
    if (match) return path.join(resourcesPath, match);
  }
  if (iconFiles.length === 1) return path.join(resourcesPath, iconFiles[0]!);
  return undefined;
}

export async function readICNSIconDataURL(iconPath: string): Promise<string | undefined> {
  const data = await readFile(iconPath);
  if (data.length < 8 || data.toString("ascii", 0, 4) !== "icns") return undefined;

  const images = new Map<string, Buffer>();
  let offset = 8;
  while (offset + 8 <= data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > data.length) break;
    const payload = data.subarray(offset + 8, offset + length);
    const signatureOffset = payload.indexOf(pngSignature);
    if (signatureOffset >= 0) images.set(type, payload.subarray(signatureOffset));
    offset += length;
  }

  const image = preferredICNSImageTypes
    .map((type) => images.get(type))
    .find((candidate) => candidate !== undefined);
  return image ? `data:image/png;base64,${image.toString("base64")}` : undefined;
}

async function readApplicationMetadata(
  applicationPath: string,
): Promise<ApplicationMetadata | undefined> {
  let spotlightMetadata: ApplicationMetadata | undefined;
  try {
    const output = await executeFile("/usr/bin/mdls", [
      "-raw",
      "-nullMarker",
      "",
      "-name",
      "kMDItemCFBundleIdentifier",
      "-name",
      "kMDItemDisplayName",
      "-name",
      "kMDItemFSName",
      applicationPath,
    ]);
    spotlightMetadata = parseMDLSApplicationMetadata(output, applicationPath);
  } catch {
    // Fall through to bundle metadata for applications missing Spotlight metadata.
  }
  const bundleInfo = await readApplicationBundleInfo(applicationPath);
  const bundleIdentifier = spotlightMetadata?.bundleIdentifier ?? bundleInfo?.bundleIdentifier;
  if (!validBundleIdentifier(bundleIdentifier)) return undefined;
  const iconPath = bundleInfo
    ? await resolveApplicationIconPath(applicationPath, [bundleInfo.iconFile, bundleInfo.iconName])
    : undefined;
  return {
    bundleIdentifier,
    name:
      spotlightMetadata?.name ?? bundleInfo?.displayName ?? path.basename(applicationPath, ".app"),
    iconPath,
  };
}

async function applicationBundlesIn(directory: string, remainingDepth = 4): Promise<string[]> {
  if (remainingDepth < 0) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const applications: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.name.toLowerCase().endsWith(".app")) {
        applications.push(entryPath);
        return;
      }
      if (entry.isDirectory()) {
        applications.push(...(await applicationBundlesIn(entryPath, remainingDepth - 1)));
      }
    }),
  );
  return applications;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: values.length }) as R[];
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await transform(values[index]!);
      }
    }),
  );
  return results;
}

export async function discoverInstalledApplications(
  options: DiscoverInstalledApplicationsOptions = {},
): Promise<InstalledApplicationRecord[]> {
  const roots = options.roots ?? defaultApplicationRoots;
  const metadataReader = options.readMetadata ?? readApplicationMetadata;
  const paths = [
    ...new Set((await Promise.all(roots.map((root) => applicationBundlesIn(root)))).flat()),
  ].sort((lhs, rhs) => lhs.localeCompare(rhs));
  const records = await mapWithConcurrency(paths, 8, async (applicationPath) => {
    const metadata = await metadataReader(applicationPath);
    return metadata ? { ...metadata, applicationPath } : undefined;
  });
  const byBundleIdentifier = new Map<string, InstalledApplicationRecord>();
  for (const record of records) {
    if (
      record &&
      !excludedBundleIdentifiers.has(record.bundleIdentifier) &&
      !byBundleIdentifier.has(record.bundleIdentifier)
    ) {
      byBundleIdentifier.set(record.bundleIdentifier, record);
    }
  }
  return [...byBundleIdentifier.values()].sort(
    (lhs, rhs) =>
      lhs.name.localeCompare(rhs.name, undefined, { sensitivity: "base" }) ||
      lhs.bundleIdentifier.localeCompare(rhs.bundleIdentifier),
  );
}

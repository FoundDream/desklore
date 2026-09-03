import type { SemanticSurfaceKind } from "../contracts.js";
import { domainFromURL } from "../policy/policy.js";
import type { AXRegionPartition } from "./regions.js";

/**
 * Surface classification answers "what kind of thing is this window" so the frame
 * extractor can shape its output. Order of evidence: the application itself, then the
 * page's domain, then the structure of the content region.
 */

const bundleSurfaces = new Map<string, SemanticSurfaceKind>([
  ["com.apple.Terminal", "terminal"],
  ["com.googlecode.iterm2", "terminal"],
  ["dev.warp.Warp-Stable", "terminal"],
  ["dev.warp.Warp", "terminal"],
  ["com.github.wez.wezterm", "terminal"],
  ["net.kovidgoyal.kitty", "terminal"],
  ["org.alacritty", "terminal"],
  ["com.mitchellh.ghostty", "terminal"],
  ["com.microsoft.VSCode", "editor"],
  ["com.microsoft.VSCodeInsiders", "editor"],
  ["com.todesktop.230313mzl4w4u92", "editor"],
  ["com.apple.dt.Xcode", "editor"],
  ["com.sublimetext.4", "editor"],
  ["dev.zed.Zed", "editor"],
  ["com.apple.mail", "mail"],
  ["com.readdle.smartemail-macOS", "mail"],
  ["com.tinyspeck.slackmacgap", "chat"],
  ["com.hnc.Discord", "chat"],
  ["com.apple.MobileSMS", "chat"],
  ["com.tencent.xinWeChat", "chat"],
  ["com.bytedance.macos.feishu", "chat"],
  ["com.microsoft.teams2", "chat"],
  ["com.openai.chat", "chat"],
  ["com.anthropic.claudefordesktop", "chat"],
  ["com.apple.Notes", "document"],
  ["com.apple.TextEdit", "document"],
  ["com.apple.iWork.Pages", "document"],
  ["com.microsoft.Word", "document"],
  ["md.obsidian", "document"],
  ["notion.id", "document"],
  ["com.apple.iWork.Numbers", "table"],
  ["com.microsoft.Excel", "table"],
]);

const bundlePrefixSurfaces: ReadonlyArray<readonly [string, SemanticSurfaceKind]> = [
  ["com.jetbrains.", "editor"],
  ["com.google.android.studio", "editor"],
];

/** Suffix matches against the page hostname. */
const domainSurfaces: ReadonlyArray<readonly [string, SemanticSurfaceKind]> = [
  ["mail.google.com", "mail"],
  ["outlook.live.com", "mail"],
  ["outlook.office.com", "mail"],
  ["mail.proton.me", "mail"],
  ["slack.com", "chat"],
  ["discord.com", "chat"],
  ["web.telegram.org", "chat"],
  ["web.whatsapp.com", "chat"],
  ["teams.microsoft.com", "chat"],
  ["chatgpt.com", "chat"],
  ["chat.openai.com", "chat"],
  ["claude.ai", "chat"],
  ["docs.google.com", "document"],
  ["notion.so", "document"],
  ["sheets.google.com", "table"],
  ["airtable.com", "table"],
  ["github.com", "web_app"],
  ["gitlab.com", "web_app"],
  ["linear.app", "web_app"],
  ["atlassian.net", "web_app"],
  ["figma.com", "web_app"],
];

const proseRoles = new Set(["AXStaticText", "AXParagraph", "AXLink"]);
const tabularRoles = new Set(["AXTable", "AXOutline", "AXRow", "AXCell", "AXColumn"]);

export interface SurfaceInput {
  bundleIdentifier: string;
  url?: string;
  partition: AXRegionPartition;
}

export function classifySurface(input: SurfaceInput): SemanticSurfaceKind {
  const byApplication = surfaceForBundle(input.bundleIdentifier);
  if (byApplication) return byApplication;
  const url = input.url;
  const domain = url && !url.startsWith("file:") ? domainFromURL(url) : undefined;
  if (domain) {
    for (const [suffix, kind] of domainSurfaces) {
      if (domain === suffix || domain.endsWith(`.${suffix}`)) return kind;
    }
    return webSurface(input.partition);
  }
  return nativeSurface(input.partition);
}

export function surfaceForBundle(bundleIdentifier: string): SemanticSurfaceKind | undefined {
  const exact = bundleSurfaces.get(bundleIdentifier);
  if (exact) return exact;
  return bundlePrefixSurfaces.find(([prefix]) => bundleIdentifier.startsWith(prefix))?.[1];
}

function webSurface(partition: AXRegionPartition): SemanticSurfaceKind {
  let headings = 0;
  let prose = 0;
  for (const node of partition.content) {
    if (node.role === "AXHeading") headings += 1;
    else if (proseRoles.has(node.role) && (node.value ?? node.title)?.trim()) prose += 1;
  }
  return headings >= 1 && prose >= 5 ? "web_article" : "web_app";
}

function nativeSurface(partition: AXRegionPartition): SemanticSurfaceKind {
  if (partition.content.some((node) => node.role === "AXTextArea")) return "document";
  // Region rules file tables under navigation; for a native window whose non-chrome
  // structure is mostly tabular, the table is the content.
  const nonChrome = [...partition.content, ...partition.navigation];
  const tabular = nonChrome.filter((node) => tabularRoles.has(node.role)).length;
  if (tabular > 0 && tabular * 2 >= nonChrome.length) return "table";
  return "unknown";
}

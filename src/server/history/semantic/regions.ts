import type { AXTreeNode, AXTreeSnapshot } from "../contracts.js";

/**
 * Region partition: splits a window's Accessibility tree into what the user reads or edits
 * (content), what they use to move between things (navigation), and the application's own
 * frame (chrome). Everything downstream that decides "what to keep in detail" starts here.
 *
 * Rules are structural and generic. Application-specific behaviour is expressed as rule
 * overrides keyed by bundle identifier, so extractors can be added without touching the
 * classifier itself.
 */

export type AXRegionKind = "content" | "navigation" | "chrome";

export interface AXRegionRules {
  /** A subtree under one of these roles is content, whatever surrounds it. */
  contentRoles: ReadonlySet<string>;
  /** Navigation unless already inside content or chrome. */
  navigationRoles: ReadonlySet<string>;
  /** Chrome unless already inside content. */
  chromeRoles: ReadonlySet<string>;
  chromeSubroles: ReadonlySet<string>;
}

export interface AXRegionPartition {
  kinds: ReadonlyMap<string, AXRegionKind>;
  content: AXTreeNode[];
  navigation: AXTreeNode[];
  chrome: AXTreeNode[];
  /**
   * Nodes where a region starts: their parent is missing or classified differently. An
   * explicit content container (for example AXWebArea) is a root even when the window
   * around it defaulted to content, so extractors can target the real content area.
   */
  roots: Record<AXRegionKind, AXTreeNode[]>;
}

export const genericRegionRules: AXRegionRules = {
  contentRoles: new Set(["AXWebArea", "AXDocument", "AXTextArea"]),
  navigationRoles: new Set(["AXOutline", "AXBrowser", "AXList", "AXTable"]),
  chromeRoles: new Set([
    "AXToolbar",
    "AXTabGroup",
    "AXMenuBar",
    "AXMenuBarItem",
    "AXMenu",
    "AXMenuItem",
    "AXStatusItem",
  ]),
  chromeSubroles: new Set(["AXTabButton"]),
};

const regionRuleOverrides = new Map<string, Partial<AXRegionRules>>();

export function regionRulesFor(bundleIdentifier: string | undefined): AXRegionRules {
  const override = bundleIdentifier ? regionRuleOverrides.get(bundleIdentifier) : undefined;
  return override ? { ...genericRegionRules, ...override } : genericRegionRules;
}

export function registerRegionRules(
  bundleIdentifier: string,
  override: Partial<AXRegionRules>,
): void {
  regionRuleOverrides.set(bundleIdentifier, override);
}

export function partitionAXRegions(
  snapshot: AXTreeSnapshot,
  rules: AXRegionRules = genericRegionRules,
): AXRegionPartition {
  const nodesByID = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const explicit = new Map<string, AXRegionKind | undefined>();

  const resolve = (node: AXTreeNode, visiting: Set<string>): AXRegionKind | undefined => {
    if (explicit.has(node.id)) return explicit.get(node.id);
    if (visiting.has(node.id)) return undefined;
    visiting.add(node.id);
    const parent = node.parentID === undefined ? undefined : nodesByID.get(node.parentID);
    const inherited = parent ? resolve(parent, visiting) : undefined;
    const own = classify(node, inherited, rules);
    explicit.set(node.id, own);
    return own;
  };

  const kinds = new Map<string, AXRegionKind>();
  for (const node of snapshot.nodes) {
    kinds.set(node.id, resolve(node, new Set()) ?? "content");
  }

  const partition: AXRegionPartition = {
    kinds,
    content: [],
    navigation: [],
    chrome: [],
    roots: { content: [], navigation: [], chrome: [] },
  };
  for (const node of snapshot.nodes) {
    const kind = kinds.get(node.id)!;
    partition[kind].push(node);
    // Roots are compared on the explicit classification so an explicit content marker
    // such as AXWebArea starts its own region even inside default-content ancestors.
    const parent = node.parentID === undefined ? undefined : nodesByID.get(node.parentID);
    if (!parent || explicit.get(parent.id) !== explicit.get(node.id)) {
      partition.roots[kind].push(node);
    }
  }
  return partition;
}

function classify(
  node: AXTreeNode,
  inherited: AXRegionKind | undefined,
  rules: AXRegionRules,
): AXRegionKind | undefined {
  if (rules.contentRoles.has(node.role)) return "content";
  if (inherited === "content" || inherited === "chrome") return inherited;
  if (rules.chromeRoles.has(node.role)) return "chrome";
  if (node.subrole !== undefined && rules.chromeSubroles.has(node.subrole)) return "chrome";
  if (rules.navigationRoles.has(node.role)) return "navigation";
  return inherited;
}

export interface AXRegionSummary {
  nodes: Record<AXRegionKind, number>;
  textNodes: Record<AXRegionKind, number>;
  textCharacters: Record<AXRegionKind, number>;
}

function nodeText(node: AXTreeNode): string {
  return [node.title, node.value, node.description, node.placeholder]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
}

/** Cheap per-region volume figures for evaluators and capture diagnostics. */
export function summarizeAXRegions(partition: AXRegionPartition): AXRegionSummary {
  const summary: AXRegionSummary = {
    nodes: { content: 0, navigation: 0, chrome: 0 },
    textNodes: { content: 0, navigation: 0, chrome: 0 },
    textCharacters: { content: 0, navigation: 0, chrome: 0 },
  };
  for (const kind of ["content", "navigation", "chrome"] as const) {
    for (const node of partition[kind]) {
      summary.nodes[kind] += 1;
      const text = nodeText(node);
      if (!text) continue;
      summary.textNodes[kind] += 1;
      summary.textCharacters[kind] += text.length;
    }
  }
  return summary;
}

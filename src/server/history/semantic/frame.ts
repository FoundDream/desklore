import type {
  AXTreeDelta,
  AXTreeNode,
  AXTreeSnapshot,
  SemanticFocus,
  SemanticFrame,
  SemanticOutlineEntry,
} from "../contracts.js";
import { domainFromURL } from "../policy/policy.js";
import {
  partitionAXRegions,
  regionRulesFor,
  summarizeAXRegions,
  type AXRegionPartition,
} from "./regions.js";
import { classifySurface } from "./surface.js";

/**
 * Frame extraction turns a full, sanitized Accessibility snapshot into a `SemanticFrame`.
 * It is a pure function so recorded snapshots can be replayed through newer extractors.
 */

export interface FrameLimits {
  bodyCharacters: number;
  outlineEntries: number;
  outlineCharacters: number;
  recentEntries: number;
  recentCharacters: number;
  focusCharacters: number;
  focusPathDepth: number;
}

export const defaultFrameLimits: FrameLimits = {
  bodyCharacters: 4_000,
  outlineEntries: 24,
  outlineCharacters: 160,
  recentEntries: 8,
  recentCharacters: 200,
  focusCharacters: 500,
  focusPathDepth: 6,
};

export interface FrameInput {
  bundleIdentifier: string;
  windowTitle?: string;
  url?: string;
  snapshot: AXTreeSnapshot;
  limits?: FrameLimits;
}

/** Surfaces where the newest material sits at the bottom, so the body keeps its tail. */
const tailSurfaces = new Set(["terminal", "chat", "mail"]);

const controlRoles = new Set([
  "AXButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXMenuButton",
  "AXSlider",
  "AXImage",
  "AXDisclosureTriangle",
  "AXIncrementor",
  "AXScrollBar",
  "AXSplitter",
]);

export function extractSemanticFrame(input: FrameInput): SemanticFrame {
  const limits = input.limits ?? defaultFrameLimits;
  const ordered = documentOrder(input.snapshot);
  const orderedSnapshot: AXTreeSnapshot = { ...input.snapshot, nodes: ordered };
  const partition = partitionAXRegions(orderedSnapshot, regionRulesFor(input.bundleIdentifier));
  const surface = classifySurface({
    bundleIdentifier: input.bundleIdentifier,
    url: input.url,
    partition,
  });
  const content = partition.content;
  // Multi-line values (terminal buffers, editors) become individual lines so tail
  // trimming and recency work on the visible text rather than on one giant node.
  const lines = content
    .filter((node) => !controlRoles.has(node.role) && node.role !== "AXWindow")
    .map(nodeText)
    .filter((text): text is string => text !== undefined)
    .flatMap((text) => text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const body = boundedBody(lines, limits.bodyCharacters, tailSurfaces.has(surface));
  const summary = summarizeAXRegions(partition);

  return {
    version: 1,
    surface,
    identity: identityOf(input),
    outline: outlineOf(content, limits),
    body: body.text,
    bodyTruncated: body.truncated,
    focus: focusOf(input.snapshot, ordered, partition, limits),
    recent: lines.slice(-limits.recentEntries).map((line) => clip(line, limits.recentCharacters)),
    regions: summary.textCharacters,
  };
}

/** Deterministic traversal by sibling index; unreachable nodes trail in their stored order. */
export function documentOrder(snapshot: AXTreeSnapshot): AXTreeNode[] {
  const byID = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const children = new Map<string | undefined, AXTreeNode[]>();
  for (const node of snapshot.nodes) {
    const parent =
      node.parentID !== undefined && byID.has(node.parentID) ? node.parentID : undefined;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((lhs, rhs) => lhs.siblingIndex - rhs.siblingIndex);
  }
  const ordered: AXTreeNode[] = [];
  const seen = new Set<string>();
  const visit = (node: AXTreeNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    ordered.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  for (const root of children.get(undefined) ?? []) visit(root);
  for (const node of snapshot.nodes) if (!seen.has(node.id)) visit(node);
  return ordered;
}

/** Replays a collector delta on top of the previous full snapshot of the same window. */
export function applyAXTreeDelta(base: AXTreeSnapshot, delta: AXTreeDelta): AXTreeSnapshot {
  const byID = new Map(base.nodes.map((node) => [node.id, node]));
  for (const node of delta.removed) byID.delete(node.id);
  for (const node of [...delta.added, ...delta.updated, ...delta.moved]) byID.set(node.id, node);
  return {
    nodes: [...byID.values()],
    visitedNodeCount: Math.max(base.visitedNodeCount, byID.size),
    wasTruncated: base.wasTruncated,
  };
}

export function nodeText(node: AXTreeNode): string | undefined {
  const text = (node.value ?? node.title ?? node.description)?.trim();
  return text ? text : undefined;
}

function identityOf(input: FrameInput): SemanticFrame["identity"] {
  const identity: SemanticFrame["identity"] = {};
  if (input.windowTitle?.trim()) identity.title = input.windowTitle.trim();
  if (input.url) {
    identity.url = input.url;
    if (input.url.startsWith("file:")) {
      try {
        identity.path = decodeURIComponent(new URL(input.url).pathname);
      } catch {
        identity.path = input.url.slice("file://".length);
      }
    } else {
      const domain = domainFromURL(input.url);
      if (domain) identity.domain = domain;
    }
  }
  return identity;
}

function outlineOf(content: AXTreeNode[], limits: FrameLimits): SemanticOutlineEntry[] {
  const outline: SemanticOutlineEntry[] = [];
  for (const node of content) {
    if (node.role !== "AXHeading") continue;
    const text = nodeText(node);
    if (!text) continue;
    outline.push({ level: node.disclosureLevel ?? 1, text: clip(text, limits.outlineCharacters) });
    if (outline.length >= limits.outlineEntries) break;
  }
  return outline;
}

function focusOf(
  snapshot: AXTreeSnapshot,
  ordered: AXTreeNode[],
  partition: AXRegionPartition,
  limits: FrameLimits,
): SemanticFocus | undefined {
  const focused =
    ordered.find((node) => node.focused === true && partition.kinds.get(node.id) === "content") ??
    ordered.find((node) => node.focused === true);
  if (!focused) return undefined;
  const byID = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  const visited = new Set<string>([focused.id]);
  let current = focused.parentID === undefined ? undefined : byID.get(focused.parentID);
  while (current && !visited.has(current.id) && path.length < limits.focusPathDepth) {
    visited.add(current.id);
    const label = (current.title ?? current.description)?.trim();
    if (label) path.unshift(clip(label, limits.outlineCharacters));
    current = current.parentID === undefined ? undefined : byID.get(current.parentID);
  }
  const focus: SemanticFocus = { role: focused.role, path };
  const text = nodeText(focused);
  if (text) focus.text = clip(text, limits.focusCharacters);
  return focus;
}

function boundedBody(
  lines: string[],
  limit: number,
  keepTail: boolean,
): { text: string; truncated: boolean } {
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= limit + 1) return { text: lines.join("\n"), truncated: false };
  const kept: string[] = [];
  let used = 0;
  const source = keepTail ? [...lines].reverse() : lines;
  for (const line of source) {
    if (used + line.length + 1 > limit) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (keepTail) kept.reverse();
  return { text: kept.join("\n"), truncated: true };
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export interface FrameSummaryLimits {
  outlineEntries: number;
  outlineCharacters: number;
  focusCharacters: number;
  recentEntries: number;
  recentCharacters: number;
}

export const defaultFrameSummaryLimits: FrameSummaryLimits = {
  outlineEntries: 6,
  outlineCharacters: 80,
  focusCharacters: 160,
  recentEntries: 3,
  recentCharacters: 120,
};

/**
 * The list-view form of a frame: everything except the body, trimmed. `bodyTruncated`
 * is true whenever a body existed so consumers know a drill-down would add material.
 */
export function summarizeSemanticFrame(
  frame: SemanticFrame,
  limits: FrameSummaryLimits = defaultFrameSummaryLimits,
): SemanticFrame {
  const summary: SemanticFrame = {
    version: frame.version,
    surface: frame.surface,
    identity: frame.identity,
    outline: frame.outline
      .slice(0, limits.outlineEntries)
      .map((entry) => ({ level: entry.level, text: clip(entry.text, limits.outlineCharacters) })),
    body: "",
    bodyTruncated: frame.body.length > 0 || frame.bodyTruncated,
    recent: frame.recent
      .slice(-limits.recentEntries)
      .map((line) => clip(line, limits.recentCharacters)),
    regions: frame.regions,
  };
  if (frame.focus) {
    summary.focus = { role: frame.focus.role, path: frame.focus.path };
    if (frame.focus.text !== undefined) {
      summary.focus.text = clip(frame.focus.text, limits.focusCharacters);
    }
  }
  return summary;
}

/** Everything in a frame worth matching a search query against. */
export function semanticSearchText(frame: SemanticFrame): string {
  return [
    frame.identity.title,
    frame.identity.url,
    frame.identity.domain,
    frame.identity.path,
    ...frame.outline.map((entry) => entry.text),
    frame.body,
    frame.focus?.text,
    ...frame.recent,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

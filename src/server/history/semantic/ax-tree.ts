import {
  defaultAccessibilityTextLimit,
  hasAccessibilityStructure,
  renderedAccessibilityContext,
  type AccessibilityContext,
  type AXTreeDelta,
  type AXTreeNode,
  type AXTreeSnapshot,
  type HistoryEvent,
} from "../contracts.js";
import { cleanText } from "../policy/policy.js";

/**
 * Semantic-layer helpers over structured Accessibility trees. Normalization, rendering, and
 * the on-disk form live in `contracts.ts` (which must stay free of runtime imports for the
 * offline evaluators); this module holds everything that operates on already-normalized
 * contexts: merging, presentation, and sanitization.
 */
export {
  accessibilityContextForDisk,
  defaultAccessibilityTextLimit,
  hasAccessibilityStructure,
  isAccessibilityMode,
  maximumAccessibilityNodes,
  normalizeAccessibilityContext,
  normalizeAXTreeDelta,
  normalizeAXTreeNode,
  normalizeAXTreeSnapshot,
  renderAccessibilityText,
  renderAXTreeDeltaText,
  renderAXTreeText,
  renderedAccessibilityContext,
} from "../contracts.js";

export function mergeAXTreeDeltas(
  previous: AXTreeDelta | undefined,
  latest: AXTreeDelta | undefined,
): AXTreeDelta | undefined {
  if (!previous) return latest;
  if (!latest) return previous;
  return {
    added: [...previous.added, ...latest.added],
    removed: [...previous.removed, ...latest.removed],
    updated: [...previous.updated, ...latest.updated],
    moved: [...previous.moved, ...latest.moved],
  };
}

/** Model- and renderer-facing consumers receive rendered text only. */
export function accessibilityTextOnly(
  context: AccessibilityContext,
  characterLimit?: number,
): AccessibilityContext {
  const text = characterLimit === undefined ? context.text : context.text.slice(0, characterLimit);
  return { mode: context.mode, text };
}

export type NodeTextCleaner = (value: string | undefined, limit: number) => string | undefined;

function compactNode(node: AXTreeNode): AXTreeNode {
  return Object.fromEntries(
    Object.entries(node).filter(([, value]) => value !== undefined),
  ) as unknown as AXTreeNode;
}

export function sanitizeAXTreeNode(node: AXTreeNode, clean: NodeTextCleaner): AXTreeNode {
  return compactNode({
    ...node,
    id: clean(node.id, 128) ?? node.id,
    parentID: clean(node.parentID, 128),
    role: clean(node.role, 64) ?? node.role,
    subrole: clean(node.subrole, 128),
    identifier: clean(node.identifier, 256),
    title: clean(node.title, 512),
    description: clean(node.description, 512),
    help: clean(node.help, 512),
    placeholder: clean(node.placeholder, 512),
    value: clean(node.value, 1_024),
  });
}

export function sanitizeAXTreeSnapshot(
  snapshot: AXTreeSnapshot,
  clean: NodeTextCleaner,
): AXTreeSnapshot {
  return { ...snapshot, nodes: snapshot.nodes.map((node) => sanitizeAXTreeNode(node, clean)) };
}

export function sanitizeAXTreeDelta(delta: AXTreeDelta, clean: NodeTextCleaner): AXTreeDelta {
  const sanitize = (nodes: AXTreeNode[]) => nodes.map((node) => sanitizeAXTreeNode(node, clean));
  return {
    added: sanitize(delta.added),
    removed: sanitize(delta.removed),
    updated: sanitize(delta.updated),
    moved: sanitize(delta.moved),
  };
}

/**
 * Persistence path only: re-attach the structured Accessibility nodes that
 * `sanitizeEvent` dropped, after cleaning every node string with the same secret
 * redaction, and re-render the text so it stays in sync with the retained nodes.
 */
export function withSanitizedAccessibilityTree(
  sanitized: HistoryEvent,
  source: HistoryEvent,
  characterLimit = defaultAccessibilityTextLimit,
): HistoryEvent {
  const context = source.accessibility;
  if (!sanitized.accessibility || !context || !hasAccessibilityStructure(context)) {
    return sanitized;
  }
  return {
    ...sanitized,
    accessibility: renderedAccessibilityContext(
      {
        mode: sanitized.accessibility.mode,
        tree: context.tree ? sanitizeAXTreeSnapshot(context.tree, cleanText) : undefined,
        delta: context.delta ? sanitizeAXTreeDelta(context.delta, cleanText) : undefined,
      },
      characterLimit,
    ),
  };
}

import type { ModelProtocol } from "../../shared/model.js";

export type HistoryEventKind =
  | "window.changed"
  | "mouse.click"
  | "mouse.context_menu"
  | "mouse.drag"
  | "keyboard.text_input"
  | "keyboard.shortcut"
  | "keyboard.submit"
  | "selection.changed";

export type HistoryCaptureReason =
  | "application_activation"
  | "window_focus"
  | "title_change"
  | "focus_change"
  | "poll"
  | "ax_value"
  | "ax_selection"
  | "mouse"
  | "keyboard";

export interface HistoryApplication {
  bundleIdentifier: string;
  name: string;
}

export type UsageState = "foreground" | "excluded" | "unavailable";

export type UsageStateReason =
  | "application_activation"
  | "policy_changed"
  | "pause"
  | "resume"
  | "screen_sleep"
  | "screen_wake"
  | "system_sleep"
  | "system_wake"
  | "session_inactive"
  | "session_active"
  | "screen_saver_started"
  | "screen_saver_stopped"
  | "collector_disconnected";

export interface UsageStateEvent {
  timestamp: string;
  state: UsageState;
  reason: UsageStateReason;
  application?: HistoryApplication;
}

export interface HistoryEvent {
  id: string;
  timestamp: string;
  kind: HistoryEventKind;
  captureReason?: HistoryCaptureReason;
  coalescedCaptureReasons?: HistoryCaptureReason[];
  occurrenceCount?: number;
  application: HistoryApplication;
  window?: {
    title?: string;
    url?: string;
    isPrivateBrowsing: boolean;
    runtimeIdentifier?: number;
  };
  target?: {
    role?: string;
    subrole?: string;
    identifier?: string;
    title?: string;
    description?: string;
    placeholder?: string;
    value?: string;
  };
  interaction?: {
    text?: string;
    selectedText?: string;
    keyEquivalent?: string;
    modifiers?: string[];
    mouseButton?: string;
    clickCount?: number;
    mouseOrigin?: { x: number; y: number };
    mouseDestination?: { x: number; y: number };
  };
  accessibility?: AccessibilityContext;
  evidence?: EventEvidence;
}

export interface AXTreeNode {
  id: string;
  parentID?: string;
  depth: number;
  siblingIndex: number;
  role: string;
  subrole?: string;
  identifier?: string;
  title?: string;
  description?: string;
  help?: string;
  placeholder?: string;
  value?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disclosureLevel?: number;
  childCount: number;
}

export interface AXTreeSnapshot {
  nodes: AXTreeNode[];
  visitedNodeCount: number;
  wasTruncated: boolean;
}

export interface AXTreeDelta {
  added: AXTreeNode[];
  removed: AXTreeNode[];
  updated: AXTreeNode[];
  moved: AXTreeNode[];
}

/**
 * `text` is the rendered form every current consumer reads. When the collector supplied
 * structured nodes, `tree` (full snapshot) and/or `delta` (changes since the previous
 * snapshot in the same window stream) are retained and `text` is derived from them.
 */
export interface AccessibilityContext {
  mode: "fullTree" | "diffFromPrevious";
  text: string;
  tree?: AXTreeSnapshot;
  delta?: AXTreeDelta;
}

export type AXSufficiencyDecision = "enough" | "needs_visual" | "uncertain";
export type AXSufficiencySource = "rules" | "luna" | "luna_fallback";

export interface AXSufficiencyEvidence {
  decision: AXSufficiencyDecision;
  source: AXSufficiencySource;
  confidence: number;
  reasons: string[];
  missingEvidence: string[];
  judgedAt: string;
}

export type VisualEvidenceStatus = "captured" | "discarded" | "unavailable" | "blocked" | "failed";

export interface VisualEvidence {
  requestID: string;
  status: VisualEvidenceStatus;
  provider: string;
  reason?: string;
  capturedAt?: string;
  windowRuntimeIdentifier?: number;
  width?: number;
  height?: number;
  ocrText?: string;
  understanding?: string;
  confidence?: number;
  privacy: "not_captured" | "local_ocr" | "redacted_remote";
}

export interface EventEvidence {
  axSufficiency?: AXSufficiencyEvidence;
  visual?: VisualEvidence;
}

export interface EventEvidenceEnrichment extends EventEvidence {
  schemaVersion: 1;
  eventID: string;
  eventTimestamp: string;
  assessmentStartedAt?: string;
  createdAt: string;
}

export interface SegmentMetadata {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  suppressedEventCount: number;
  capturedEventCount: number;
  policyBlockedEventCount: number;
  deduplicatedEventCount: number;
  burstCoalescedEventCount: number;
  eventsFile: string;
}

export interface ClosedSegment {
  metadata: SegmentMetadata;
  directoryPath: string;
  eventsPath: string;
}

export interface TimelineDocumentRecord {
  schemaVersion: 4;
  id: string;
  sourceSegmentID: string;
  startedAt: string;
  endedAt: string;
  title: string;
  description: string;
  continuationHint?: string;
  claims: TimelineClaim[];
  applications: HistoryApplication[];
  evidenceEventIDs: string[];
  generator: {
    type: string;
    version: number;
    model?: string;
    failureReason?: string;
  };
  createdAt: string;
  body: string;
  filePath?: string;
}

export interface TimelineClaim {
  text: string;
  evidenceEventIDs: string[];
}

export type TimelineRollupKind = "6h" | "day";

export interface TimelineRollupRecord {
  schemaVersion: 1;
  id: string;
  kind: TimelineRollupKind;
  status: "provisional" | "final";
  startedAt: string;
  endedAt: string;
  title: string;
  description: string;
  continuationHint?: string;
  applications: HistoryApplication[];
  sourceDocumentIDs: string[];
  sourceSegmentIDs: string[];
  sourceDigest: string;
  generator: {
    type: "deterministic" | "llm";
    version: number;
    model?: string;
    failureReason?: string;
  };
  createdAt: string;
  body: string;
  filePath?: string;
}

export type {
  HistorySearchMatch,
  HistorySearchResponse,
  ObservationPolicy,
  VisualSettings,
  WindowTitleExclusionRule,
} from "../../shared/contracts/index.js";

export interface TimelineLLMSettings {
  enabled: boolean;
  rollupSynthesisEnabled: boolean;
  protocol: ModelProtocol;
  model: string;
  endpoint: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function point(value: unknown): { x: number; y: number } | undefined {
  const source = record(value);
  const x = number(source?.x);
  const y = number(source?.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Structured Accessibility payloads arrive from the collector as bounded node lists.
 * ServerCore owns the textual rendering so later semantic extraction can work on the same
 * nodes instead of re-parsing rendered text. These helpers stay free of runtime imports so
 * the offline evaluators can load this module directly.
 */

export const defaultAccessibilityTextLimit = 48_000;
export const maximumAccessibilityNodes = 2_000;

function compactNode(node: AXTreeNode): AXTreeNode {
  return Object.fromEntries(
    Object.entries(node).filter(([, value]) => value !== undefined),
  ) as unknown as AXTreeNode;
}

export function normalizeAXTreeNode(value: unknown): AXTreeNode | undefined {
  const source = Array.isArray(value) ? undefined : record(value);
  const id = string(source?.id);
  const role = string(source?.role);
  if (!id || !role) return undefined;
  return compactNode({
    id,
    parentID: string(source?.parentID),
    depth: number(source?.depth) ?? 0,
    siblingIndex: number(source?.siblingIndex) ?? 0,
    role,
    subrole: string(source?.subrole),
    identifier: string(source?.identifier),
    title: string(source?.title),
    description: string(source?.description),
    help: string(source?.help),
    placeholder: string(source?.placeholder),
    value: string(source?.value),
    enabled: boolean(source?.enabled),
    focused: boolean(source?.focused),
    selected: boolean(source?.selected),
    expanded: boolean(source?.expanded),
    disclosureLevel: number(source?.disclosureLevel),
    childCount: number(source?.childCount) ?? 0,
  });
}

function normalizeNodeList(value: unknown): AXTreeNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .slice(0, maximumAccessibilityNodes)
    .map(normalizeAXTreeNode)
    .filter((node): node is AXTreeNode => node !== undefined);
}

export function normalizeAXTreeSnapshot(value: unknown): AXTreeSnapshot | undefined {
  const source = Array.isArray(value) ? undefined : record(value);
  const nodes = normalizeNodeList(source?.nodes);
  if (!source || !nodes) return undefined;
  return {
    nodes,
    visitedNodeCount: number(source.visitedNodeCount) ?? nodes.length,
    wasTruncated: source.wasTruncated === true,
  };
}

export function normalizeAXTreeDelta(value: unknown): AXTreeDelta | undefined {
  const source = Array.isArray(value) ? undefined : record(value);
  if (!source) return undefined;
  const added = normalizeNodeList(source.added);
  const removed = normalizeNodeList(source.removed);
  const updated = normalizeNodeList(source.updated);
  const moved = normalizeNodeList(source.moved);
  if (!added || !removed || !updated || !moved) return undefined;
  return { added, removed, updated, moved };
}

export function isAccessibilityMode(value: unknown): value is AccessibilityContext["mode"] {
  return value === "fullTree" || value === "diffFromPrevious";
}

/**
 * Accepts the collector wire form (`tree` / `delta`), the on-disk form (same), and the
 * legacy text-only form. Structured payloads always win and their text is derived.
 */
export function normalizeAccessibilityContext(value: unknown): AccessibilityContext {
  const source = Array.isArray(value) ? undefined : record(value);
  const mode = source?.mode;
  if (!source || !isAccessibilityMode(mode)) {
    throw new Error("Invalid history accessibility context");
  }
  const tree = source.tree === undefined ? undefined : normalizeAXTreeSnapshot(source.tree);
  const delta = source.delta === undefined ? undefined : normalizeAXTreeDelta(source.delta);
  if ((source.tree !== undefined && !tree) || (source.delta !== undefined && !delta)) {
    throw new Error("Invalid history accessibility context");
  }
  if (tree || delta) return renderedAccessibilityContext({ mode, tree, delta });
  const text = string(source.text);
  if (text === undefined) throw new Error("Invalid history accessibility context");
  return { mode, text };
}

export function hasAccessibilityStructure(context: AccessibilityContext | undefined): boolean {
  return Boolean(context && (context.tree || context.delta));
}

export function renderedAccessibilityContext(
  context: { mode: AccessibilityContext["mode"]; tree?: AXTreeSnapshot; delta?: AXTreeDelta },
  characterLimit = defaultAccessibilityTextLimit,
): AccessibilityContext {
  const result: AccessibilityContext = {
    mode: context.mode,
    text: renderAccessibilityText(context, characterLimit),
  };
  if (context.tree) result.tree = context.tree;
  if (context.delta) result.delta = context.delta;
  return result;
}

export function renderAccessibilityText(
  context: { tree?: AXTreeSnapshot; delta?: AXTreeDelta },
  characterLimit = defaultAccessibilityTextLimit,
): string {
  const parts: string[] = [];
  if (context.tree) parts.push(renderAXTreeText(context.tree, characterLimit));
  if (context.delta) parts.push(renderAXTreeDeltaText(context.delta, characterLimit));
  return parts.join("\n").slice(0, characterLimit);
}

export function renderAXTreeText(
  snapshot: AXTreeSnapshot,
  characterLimit = defaultAccessibilityTextLimit,
): string {
  const header =
    `AXTree v2 nodes=${snapshot.nodes.length} ` +
    `visited=${snapshot.visitedNodeCount} ` +
    `truncated=${snapshot.wasTruncated}`;
  return boundedLines([header, ...snapshot.nodes.map(renderAXTreeNode)], characterLimit);
}

export function renderAXTreeDeltaText(
  delta: AXTreeDelta,
  characterLimit = defaultAccessibilityTextLimit,
): string {
  const lines = [
    `AXTreeDiff v2 added=${delta.added.length} ` +
      `removed=${delta.removed.length} ` +
      `updated=${delta.updated.length} ` +
      `moved=${delta.moved.length}`,
    ...delta.removed.map((node) => `- ${node.id} ${node.role} parent=${node.parentID ?? "root"}`),
    ...delta.added.map((node) => `+ ${renderAXTreeNode(node)}`),
    ...delta.updated.map((node) => `~ ${renderAXTreeNode(node)}`),
    ...delta.moved.map((node) => `> ${renderAXTreeNode(node)}`),
  ];
  return boundedLines(lines, characterLimit);
}

export function accessibilityContextForDisk(context: AccessibilityContext): UnknownRecord {
  if (!hasAccessibilityStructure(context)) return { mode: context.mode, text: context.text };
  const stored: UnknownRecord = { mode: context.mode };
  if (context.tree) stored.tree = context.tree;
  if (context.delta) stored.delta = context.delta;
  return stored;
}

function renderAXTreeNode(node: AXTreeNode): string {
  const indentation = "  ".repeat(Math.min(node.depth, 24));
  const components = [`${node.id} ${node.role}`];
  if (node.subrole !== undefined) components.push(`subrole=${quotedAXValue(node.subrole)}`);
  if (node.identifier !== undefined) {
    components.push(`identifier=${quotedAXValue(node.identifier)}`);
  }
  if (node.childCount > 0) components.push(`children=${node.childCount}`);
  if (node.enabled === false) components.push("disabled");
  if (node.focused === true) components.push("focused");
  if (node.selected === true) components.push("selected");
  if (node.expanded !== undefined) components.push(node.expanded ? "expanded" : "collapsed");
  if (node.disclosureLevel !== undefined) components.push(`level=${node.disclosureLevel}`);
  if (node.title !== undefined) components.push(`title=${quotedAXValue(node.title)}`);
  if (node.description !== undefined) {
    components.push(`description=${quotedAXValue(node.description)}`);
  }
  if (node.placeholder !== undefined) {
    components.push(`placeholder=${quotedAXValue(node.placeholder)}`);
  }
  if (node.help !== undefined) components.push(`help=${quotedAXValue(node.help)}`);
  if (node.value !== undefined) components.push(`value=${quotedAXValue(node.value)}`);
  if (node.parentID !== undefined) components.push(`parent=${node.parentID}`);
  return indentation + components.join(" ");
}

function quotedAXValue(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

function boundedLines(lines: string[], characterLimit: number): string {
  if (characterLimit <= 0) return "";
  let result = "";
  let omitted = 0;
  for (const [index, line] of lines.entries()) {
    const candidate = result.length === 0 ? line : `\n${line}`;
    if (result.length + candidate.length > characterLimit) {
      omitted = lines.length - index;
      break;
    }
    result += candidate;
  }
  if (omitted === 0) return result;
  const marker = `\n… truncated ${omitted} AX tree lines`;
  if (result.length + marker.length <= characterLimit) result += marker;
  return result;
}

export function normalizeHistoryEvent(value: unknown): HistoryEvent {
  const source = record(value);
  const application = record(source?.application);
  const id = string(source?.id);
  const timestamp = string(source?.timestamp);
  const kind = string(source?.kind) as HistoryEventKind | undefined;
  const captureReason = string(source?.captureReason) as HistoryCaptureReason | undefined;
  const coalescedCaptureReasons = stringArray(source?.coalescedCaptureReasons) as
    | HistoryCaptureReason[]
    | undefined;
  const bundleIdentifier = string(application?.bundleIdentifier);
  const name = string(application?.name);
  const kinds: HistoryEventKind[] = [
    "window.changed",
    "mouse.click",
    "mouse.context_menu",
    "mouse.drag",
    "keyboard.text_input",
    "keyboard.shortcut",
    "keyboard.submit",
    "selection.changed",
  ];
  const captureReasons: HistoryCaptureReason[] = [
    "application_activation",
    "window_focus",
    "title_change",
    "focus_change",
    "poll",
    "ax_value",
    "ax_selection",
    "mouse",
    "keyboard",
  ];
  if (
    !id ||
    !timestamp ||
    !kind ||
    !kinds.includes(kind) ||
    (captureReason !== undefined && !captureReasons.includes(captureReason)) ||
    (source?.coalescedCaptureReasons !== undefined &&
      (coalescedCaptureReasons === undefined ||
        coalescedCaptureReasons.some((reason) => !captureReasons.includes(reason)))) ||
    !bundleIdentifier ||
    !name
  ) {
    throw new Error("Invalid history event");
  }

  const window = record(source?.window);
  const target = record(source?.target);
  const interaction = record(source?.interaction);
  const accessibility = record(source?.accessibility);
  const evidence = record(source?.evidence);
  const modifiers = interaction?.modifiers;
  if (window && typeof window.isPrivateBrowsing !== "boolean") {
    throw new Error("Invalid history event window");
  }
  if (modifiers !== undefined && stringArray(modifiers) === undefined) {
    throw new Error("Invalid history event modifiers");
  }
  return {
    id: id.toLowerCase(),
    timestamp,
    kind,
    captureReason,
    coalescedCaptureReasons,
    occurrenceCount: number(source?.occurrenceCount),
    application: { bundleIdentifier, name },
    window: window
      ? {
          title: string(window.title),
          url: string(window.url),
          isPrivateBrowsing: window.isPrivateBrowsing === true,
          runtimeIdentifier: number(window.runtimeIdentifier),
        }
      : undefined,
    target: target
      ? {
          role: string(target.role),
          subrole: string(target.subrole),
          identifier: string(target.identifier),
          title: string(target.title),
          description: string(target.description),
          placeholder: string(target.placeholder),
          value: string(target.value),
        }
      : undefined,
    interaction: interaction
      ? {
          text: string(interaction.text),
          selectedText: string(interaction.selectedText),
          keyEquivalent: string(interaction.keyEquivalent),
          modifiers: stringArray(modifiers),
          mouseButton: string(interaction.mouseButton),
          clickCount: number(interaction.clickCount),
          mouseOrigin: point(interaction.mouseOrigin),
          mouseDestination: point(interaction.mouseDestination),
        }
      : undefined,
    accessibility: accessibility ? normalizeAccessibilityContext(accessibility) : undefined,
    evidence: normalizeEventEvidence(evidence),
  };
}

export function normalizeUsageStateEvent(value: unknown): UsageStateEvent {
  const source = record(value);
  const application = record(source?.application);
  const timestamp = string(source?.timestamp);
  const state = string(source?.state) as UsageState | undefined;
  const reason = string(source?.reason) as UsageStateReason | undefined;
  const states: UsageState[] = ["foreground", "excluded", "unavailable"];
  const reasons: UsageStateReason[] = [
    "application_activation",
    "policy_changed",
    "pause",
    "resume",
    "screen_sleep",
    "screen_wake",
    "system_sleep",
    "system_wake",
    "session_inactive",
    "session_active",
    "screen_saver_started",
    "screen_saver_stopped",
    "collector_disconnected",
  ];
  const bundleIdentifier = string(application?.bundleIdentifier);
  const name = string(application?.name);
  if (
    !timestamp ||
    !Number.isFinite(Date.parse(timestamp)) ||
    !state ||
    !states.includes(state) ||
    !reason ||
    !reasons.includes(reason) ||
    (state === "foreground" && (!bundleIdentifier || !name)) ||
    (state !== "foreground" && source?.application !== undefined)
  ) {
    throw new Error("Invalid usage state event");
  }
  return {
    timestamp,
    state,
    reason,
    application:
      state === "foreground" && bundleIdentifier && name ? { bundleIdentifier, name } : undefined,
  };
}

export function normalizeEventEvidence(value: unknown): EventEvidence | undefined {
  const source = record(value);
  if (!source) return undefined;
  const ax = record(source.axSufficiency);
  const visual = record(source.visual);
  const axDecision = string(ax?.decision) as AXSufficiencyDecision | undefined;
  const axSource = string(ax?.source) as AXSufficiencySource | undefined;
  const visualStatus = string(visual?.status) as VisualEvidenceStatus | undefined;
  const normalized: EventEvidence = {};
  if (ax) {
    const confidence = number(ax.confidence);
    const reasons = stringArray(ax.reasons);
    const missingEvidence = stringArray(ax.missingEvidence);
    const judgedAt = string(ax.judgedAt);
    if (
      !["enough", "needs_visual", "uncertain"].includes(axDecision ?? "") ||
      !["rules", "luna", "luna_fallback"].includes(axSource ?? "") ||
      confidence === undefined ||
      reasons === undefined ||
      missingEvidence === undefined ||
      !judgedAt
    ) {
      throw new Error("Invalid AX sufficiency evidence");
    }
    normalized.axSufficiency = {
      decision: axDecision!,
      source: axSource!,
      confidence,
      reasons,
      missingEvidence,
      judgedAt,
    };
  }
  if (visual) {
    const requestID = string(visual.requestID);
    const provider = string(visual.provider);
    const privacy = string(visual.privacy);
    if (
      !["captured", "discarded", "unavailable", "blocked", "failed"].includes(visualStatus ?? "") ||
      !requestID ||
      !provider ||
      !["not_captured", "local_ocr", "redacted_remote"].includes(privacy ?? "")
    ) {
      throw new Error("Invalid visual evidence");
    }
    normalized.visual = {
      requestID,
      status: visualStatus!,
      provider,
      reason: string(visual.reason),
      capturedAt: string(visual.capturedAt),
      windowRuntimeIdentifier: number(visual.windowRuntimeIdentifier),
      width: number(visual.width),
      height: number(visual.height),
      ocrText: string(visual.ocrText),
      understanding: string(visual.understanding),
      confidence: number(visual.confidence),
      privacy: privacy as VisualEvidence["privacy"],
    };
  }
  return normalized.axSufficiency || normalized.visual ? normalized : undefined;
}

export function normalizeEventEvidenceEnrichment(value: unknown): EventEvidenceEnrichment {
  const source = record(value);
  const eventID = string(source?.eventID);
  const eventTimestamp = string(source?.eventTimestamp);
  const assessmentStartedAt = string(source?.assessmentStartedAt);
  const createdAt = string(source?.createdAt);
  if (source?.schemaVersion !== 1 || !eventID || !eventTimestamp || !createdAt) {
    throw new Error("Invalid event evidence enrichment");
  }
  return {
    schemaVersion: 1,
    eventID: eventID.toLowerCase(),
    eventTimestamp,
    assessmentStartedAt,
    createdAt,
    ...normalizeEventEvidence(source),
  };
}

export function evidenceEnrichmentForDisk(enrichment: EventEvidenceEnrichment): UnknownRecord {
  return compact({
    schemaVersion: 1,
    eventID: enrichment.eventID,
    eventTimestamp: enrichment.eventTimestamp,
    assessmentStartedAt: enrichment.assessmentStartedAt,
    createdAt: enrichment.createdAt,
    axSufficiency: enrichment.axSufficiency
      ? compact({
          decision: enrichment.axSufficiency.decision,
          source: enrichment.axSufficiency.source,
          confidence: enrichment.axSufficiency.confidence,
          reasons: enrichment.axSufficiency.reasons,
          missingEvidence: enrichment.axSufficiency.missingEvidence,
          judgedAt: enrichment.axSufficiency.judgedAt,
        })
      : undefined,
    visual: enrichment.visual
      ? compact({
          requestID: enrichment.visual.requestID,
          status: enrichment.visual.status,
          provider: enrichment.visual.provider,
          reason: enrichment.visual.reason,
          capturedAt: enrichment.visual.capturedAt,
          windowRuntimeIdentifier: enrichment.visual.windowRuntimeIdentifier,
          width: enrichment.visual.width,
          height: enrichment.visual.height,
          ocrText: enrichment.visual.ocrText,
          understanding: enrichment.visual.understanding,
          confidence: enrichment.visual.confidence,
          privacy: enrichment.visual.privacy,
        })
      : undefined,
  });
}

export function eventForDisk(event: HistoryEvent): UnknownRecord {
  return compact({
    id: event.id,
    timestamp: event.timestamp,
    kind: event.kind,
    captureReason: event.captureReason,
    coalescedCaptureReasons: event.coalescedCaptureReasons,
    occurrenceCount: event.occurrenceCount,
    application: {
      bundleIdentifier: event.application.bundleIdentifier,
      name: event.application.name,
    },
    window: event.window
      ? compact({
          title: event.window.title,
          url: event.window.url,
          isPrivateBrowsing: event.window.isPrivateBrowsing,
          runtimeIdentifier: event.window.runtimeIdentifier,
        })
      : undefined,
    target: event.target ? compact(event.target) : undefined,
    interaction: event.interaction
      ? compact({
          text: event.interaction.text,
          selectedText: event.interaction.selectedText,
          keyEquivalent: event.interaction.keyEquivalent,
          modifiers: event.interaction.modifiers,
          mouseButton: event.interaction.mouseButton,
          clickCount: event.interaction.clickCount,
          mouseOrigin: event.interaction.mouseOrigin,
          mouseDestination: event.interaction.mouseDestination,
        })
      : undefined,
    accessibility: event.accessibility
      ? accessibilityContextForDisk(event.accessibility)
      : undefined,
    evidence: event.evidence,
  });
}

export function metadataForDisk(metadata: SegmentMetadata): UnknownRecord {
  return compact({
    schemaVersion: 1,
    id: metadata.id,
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    eventCount: metadata.eventCount,
    suppressedEventCount: metadata.suppressedEventCount,
    capturedEventCount: metadata.capturedEventCount,
    policyBlockedEventCount: metadata.policyBlockedEventCount,
    deduplicatedEventCount: metadata.deduplicatedEventCount,
    burstCoalescedEventCount: metadata.burstCoalescedEventCount,
    eventsFile: metadata.eventsFile,
  });
}

export function normalizeMetadata(value: unknown): SegmentMetadata {
  const source = record(value);
  const id = string(source?.id);
  const startedAt = string(source?.startedAt);
  const eventCount = number(source?.eventCount);
  const suppressedEventCount = number(source?.suppressedEventCount);
  const capturedEventCount = number(source?.capturedEventCount);
  const policyBlockedEventCount = number(source?.policyBlockedEventCount);
  const deduplicatedEventCount = number(source?.deduplicatedEventCount);
  const burstCoalescedEventCount = number(source?.burstCoalescedEventCount);
  const eventsFile = string(source?.eventsFile);
  if (
    source?.schemaVersion !== 1 ||
    !id ||
    !startedAt ||
    eventCount === undefined ||
    suppressedEventCount === undefined ||
    capturedEventCount === undefined ||
    policyBlockedEventCount === undefined ||
    deduplicatedEventCount === undefined ||
    burstCoalescedEventCount === undefined ||
    !eventsFile
  ) {
    throw new Error("Invalid segment metadata");
  }
  return {
    schemaVersion: 1,
    id,
    startedAt,
    endedAt: string(source?.endedAt),
    eventCount,
    suppressedEventCount,
    capturedEventCount,
    policyBlockedEventCount,
    deduplicatedEventCount,
    burstCoalescedEventCount,
    eventsFile,
  };
}

function compact<T extends UnknownRecord>(value: T): UnknownRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

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

export interface HistoryEvent {
  id: string;
  timestamp: string;
  kind: HistoryEventKind;
  captureReason?: HistoryCaptureReason;
  occurrenceCount?: number;
  application: HistoryApplication;
  window?: {
    title?: string;
    url?: string;
    isPrivateBrowsing: boolean;
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
  accessibility?: {
    mode: "fullTree" | "diffFromPrevious";
    text: string;
  };
}

export interface SegmentMetadata {
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

export type MemoryBucketKind = "6h" | "day";

export interface MemoryRollupRecord {
  schemaVersion: 2;
  id: string;
  kind: MemoryBucketKind;
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

export interface HistorySearchMatch {
  id: string;
  kind: "10min" | MemoryBucketKind;
  startedAt: string;
  endedAt: string;
  title: string;
  description: string;
  score: number;
  sourceDocumentIDs: string[];
  sourceSegmentIDs: string[];
}

export interface HistorySearchResponse {
  query: string;
  answer: string;
  matches: HistorySearchMatch[];
}

export interface ObservationPolicy {
  defaultApplicationBehavior: "observe" | "do_not_observe";
  defaultURLBehavior: "observe" | "do_not_observe";
  allowedBundleIdentifiers: string[];
  blockedBundleIdentifiers: string[];
  allowedDomains: string[];
  blockedDomains: string[];
}

export interface TimelineLLMSettings {
  enabled: boolean;
  memorySynthesisEnabled: boolean;
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

function point(value: unknown): { x: number; y: number } | undefined {
  const source = record(value);
  const x = number(source?.x);
  const y = number(source?.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

/** Accepts both the native camelCase wire shape and legacy snake_case JSONL. */
export function normalizeHistoryEvent(value: unknown): HistoryEvent {
  const source = record(value);
  const application = record(source?.application);
  const id = string(source?.id);
  const timestamp = string(source?.timestamp);
  const kind = string(source?.kind) as HistoryEventKind | undefined;
  const captureReason = string(source?.captureReason ?? source?.capture_reason) as
    | HistoryCaptureReason
    | undefined;
  const bundleIdentifier = string(application?.bundleIdentifier ?? application?.bundle_identifier);
  const name = string(application?.name);
  if (!id || !timestamp || !kind || !bundleIdentifier || !name) {
    throw new Error("Invalid history event");
  }

  const window = record(source?.window);
  const target = record(source?.target);
  const interaction = record(source?.interaction);
  const accessibility = record(source?.accessibility);
  const modifiers = interaction?.modifiers;

  return {
    id: id.toLowerCase(),
    timestamp,
    kind,
    captureReason,
    occurrenceCount: number(source?.occurrenceCount ?? source?.occurrence_count),
    application: { bundleIdentifier, name },
    window: window
      ? {
          title: string(window.title),
          url: string(window.url),
          isPrivateBrowsing: (window.isPrivateBrowsing ?? window.is_private_browsing) === true,
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
          selectedText: string(interaction.selectedText ?? interaction.selected_text),
          keyEquivalent: string(interaction.keyEquivalent ?? interaction.key_equivalent),
          modifiers: Array.isArray(modifiers)
            ? modifiers.filter((item): item is string => typeof item === "string")
            : undefined,
          mouseButton: string(interaction.mouseButton ?? interaction.mouse_button),
          clickCount: number(interaction.clickCount ?? interaction.click_count),
          mouseOrigin: point(interaction.mouseOrigin ?? interaction.mouse_origin),
          mouseDestination: point(interaction.mouseDestination ?? interaction.mouse_destination),
        }
      : undefined,
    accessibility: accessibility
      ? {
          mode: accessibility.mode === "diffFromPrevious" ? "diffFromPrevious" : "fullTree",
          text: string(accessibility.text) ?? "",
        }
      : undefined,
  };
}

export function eventForDisk(event: HistoryEvent): UnknownRecord {
  return compact({
    id: event.id,
    timestamp: event.timestamp,
    kind: event.kind,
    capture_reason: event.captureReason,
    occurrence_count: event.occurrenceCount,
    application: {
      bundle_identifier: event.application.bundleIdentifier,
      name: event.application.name,
    },
    window: event.window
      ? compact({
          title: event.window.title,
          url: event.window.url,
          is_private_browsing: event.window.isPrivateBrowsing,
        })
      : undefined,
    target: event.target ? compact(event.target) : undefined,
    interaction: event.interaction
      ? compact({
          text: event.interaction.text,
          selected_text: event.interaction.selectedText,
          key_equivalent: event.interaction.keyEquivalent,
          modifiers: event.interaction.modifiers,
          mouse_button: event.interaction.mouseButton,
          click_count: event.interaction.clickCount,
          mouse_origin: event.interaction.mouseOrigin,
          mouse_destination: event.interaction.mouseDestination,
        })
      : undefined,
    accessibility: event.accessibility,
  });
}

export function metadataForDisk(metadata: SegmentMetadata): UnknownRecord {
  return compact({
    id: metadata.id,
    started_at: metadata.startedAt,
    ended_at: metadata.endedAt,
    event_count: metadata.eventCount,
    suppressed_event_count: metadata.suppressedEventCount,
    captured_event_count: metadata.capturedEventCount,
    policy_blocked_event_count: metadata.policyBlockedEventCount,
    deduplicated_event_count: metadata.deduplicatedEventCount,
    burst_coalesced_event_count: metadata.burstCoalescedEventCount,
    events_file: metadata.eventsFile,
  });
}

export function normalizeMetadata(value: unknown): SegmentMetadata {
  const source = record(value);
  const id = string(source?.id);
  const startedAt = string(source?.startedAt ?? source?.started_at);
  if (!id || !startedAt) throw new Error("Invalid segment metadata");
  return {
    id,
    startedAt,
    endedAt: string(source?.endedAt ?? source?.ended_at),
    eventCount: number(source?.eventCount ?? source?.event_count) ?? 0,
    suppressedEventCount:
      number(source?.suppressedEventCount ?? source?.suppressed_event_count) ?? 0,
    capturedEventCount:
      number(source?.capturedEventCount ?? source?.captured_event_count) ??
      number(source?.eventCount ?? source?.event_count) ??
      0,
    policyBlockedEventCount:
      number(source?.policyBlockedEventCount ?? source?.policy_blocked_event_count) ??
      number(source?.suppressedEventCount ?? source?.suppressed_event_count) ??
      0,
    deduplicatedEventCount:
      number(source?.deduplicatedEventCount ?? source?.deduplicated_event_count) ?? 0,
    burstCoalescedEventCount:
      number(source?.burstCoalescedEventCount ?? source?.burst_coalesced_event_count) ?? 0,
    eventsFile: string(source?.eventsFile ?? source?.events_file) ?? "events.jsonl",
  };
}

function compact<T extends UnknownRecord>(value: T): UnknownRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

import type { HistoryEvent } from "../contracts.js";
import {
  hasAccessibilityStructure,
  mergeAXTreeDeltas,
  renderedAccessibilityContext,
} from "../semantic/ax-tree.js";

const knownNonEditableTextRoles = new Set([
  "AXButton",
  "AXCell",
  "AXGroup",
  "AXHeading",
  "AXImage",
  "AXLink",
  "AXList",
  "AXOutline",
  "AXRow",
  "AXSlider",
  "AXStaticText",
  "AXTabGroup",
]);
const structuralSelectionRoles = new Set([
  "AXCell",
  "AXColumn",
  "AXList",
  "AXMenu",
  "AXMenuItem",
  "AXOutline",
  "AXRadioButton",
  "AXRadioGroup",
  "AXRow",
  "AXTabGroup",
  "AXTable",
]);

export function classifyKeyboardEvent(event: HistoryEvent): HistoryEvent {
  if (event.kind !== "keyboard.shortcut") return event;
  const key = event.interaction?.keyEquivalent?.toLowerCase() ?? "";
  if (!["return", "enter", "numpad-enter"].includes(key)) return event;
  const modifiers = new Set(event.interaction?.modifiers ?? []);
  if (modifiers.has("shift") || modifiers.has("option")) return event;
  const role = event.target?.role ?? "";
  const label = [
    event.target?.identifier,
    event.target?.title,
    event.target?.description,
    event.target?.placeholder,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const submitMarkers = [
    "message",
    "chat",
    "prompt",
    "reply",
    "send",
    "ask",
    "消息",
    "聊天",
    "提问",
    "发送",
    "回复",
    "输入问题",
  ];
  const knownSubmitApplications = [
    "com.openai.codex",
    "com.openai.chat",
    "com.bytedance.macos.feishu",
    "com.tencent.xinWeChat",
  ];
  const submits =
    modifiers.has("cmd") ||
    modifiers.has("ctrl") ||
    ["AXTextField", "AXSearchField", "AXComboBox"].includes(role) ||
    submitMarkers.some((marker) => label.includes(marker)) ||
    knownSubmitApplications.includes(event.application.bundleIdentifier);
  return submits ? { ...event, kind: "keyboard.submit" } : event;
}

function elapsedSeconds(lhs: HistoryEvent, rhs: HistoryEvent): number {
  return (Date.parse(lhs.timestamp) - Date.parse(rhs.timestamp)) / 1_000;
}

function payload(event: HistoryEvent): string {
  return JSON.stringify({
    kind: event.kind,
    application: event.application,
    window: event.window,
    target: event.target,
    interaction: event.interaction,
    accessibility: event.accessibility,
  });
}

function windowIdentity(event: HistoryEvent): string {
  return JSON.stringify({ application: event.application, window: event.window });
}

function semanticTargetIdentity(event: HistoryEvent): string {
  return JSON.stringify({
    role: event.target?.role,
    subrole: event.target?.subrole,
    identifier: event.target?.identifier,
    title: event.target?.title,
    description: event.target?.description,
    placeholder: event.target?.placeholder,
  });
}

function isKnownNonEditableTextTarget(event: HistoryEvent): boolean {
  return knownNonEditableTextRoles.has(event.target?.role ?? "");
}

export class EventCoalescer {
  private readonly lastAcceptedByStream = new Map<string, HistoryEvent>();
  private readonly lastAcceptedTextByStream = new Map<string, string>();

  process(event: HistoryEvent): HistoryEvent | undefined {
    const stream = this.streamKey(event);
    const previous = this.lastAcceptedByStream.get(stream);
    const elapsed = previous ? elapsedSeconds(event, previous) : Number.POSITIVE_INFINITY;

    if (event.kind === "selection.changed") {
      const trimmedSelection = event.interaction?.selectedText?.trim();
      const selection = trimmedSelection ? trimmedSelection : undefined;
      if (elapsed < 0.08) return undefined;
      if (previous) {
        const trimmedPreviousSelection = previous.interaction?.selectedText?.trim();
        const previousSelection = trimmedPreviousSelection ? trimmedPreviousSelection : undefined;
        if (selection !== undefined && selection === previousSelection && elapsed < 1.5) {
          return undefined;
        }
        if (
          selection === undefined &&
          previousSelection === undefined &&
          semanticTargetIdentity(event) === semanticTargetIdentity(previous) &&
          elapsed < 0.4
        ) {
          return undefined;
        }
      }
      if (selection === undefined) {
        const role = event.target?.role ?? "";
        if (!structuralSelectionRoles.has(role)) return undefined;
      }
    }

    if (event.kind === "window.changed" && previous) {
      if (
        event.captureReason !== "application_activation" &&
        event.captureReason === previous.captureReason &&
        elapsed <= 2 &&
        windowIdentity(event) === windowIdentity(previous)
      ) {
        return undefined;
      }
    }

    let normalized = event;
    if (event.kind === "keyboard.text_input") {
      if (isKnownNonEditableTextTarget(event)) return undefined;
      const currentText = event.interaction?.text ?? event.target?.value;
      if (currentText === undefined || elapsed < 0.2) return undefined;
      const previousText = elapsed > 30 ? undefined : this.lastAcceptedTextByStream.get(stream);
      if (currentText.length === 0 && previousText === undefined) return undefined;
      if (previousText === currentText) return undefined;
      normalized = this.replacingText(event, this.textDelta(previousText, currentText));
      this.lastAcceptedTextByStream.set(stream, currentText);
    }

    if (
      event.kind !== "mouse.click" &&
      event.kind !== "window.changed" &&
      event.kind !== "keyboard.shortcut" &&
      event.kind !== "keyboard.submit" &&
      previous &&
      elapsed <= 0.4 &&
      payload(normalized) === payload(previous)
    ) {
      return undefined;
    }

    this.lastAcceptedByStream.set(stream, normalized);
    return normalized;
  }

  reset(): void {
    this.lastAcceptedByStream.clear();
    this.lastAcceptedTextByStream.clear();
  }

  private streamKey(event: HistoryEvent): string {
    const components = [event.kind, event.application.bundleIdentifier];
    if (event.kind === "keyboard.text_input") {
      components.push(
        event.window?.url ?? "",
        event.target?.identifier ?? "",
        event.target?.role ?? "",
        event.target?.title ?? "",
        event.target?.description ?? "",
        event.target?.placeholder ?? "",
      );
    } else if (event.kind === "selection.changed") {
      components.push(
        event.window?.url ?? "",
        event.target?.identifier ?? "",
        event.target?.role ?? "",
        event.target?.subrole ?? "",
        event.target?.title ?? "",
        event.target?.description ?? "",
        event.target?.placeholder ?? "",
      );
    }
    return components.join("\u001f").slice(0, 768);
  }

  private replacingText(event: HistoryEvent, text: string): HistoryEvent {
    return {
      ...event,
      target: event.target ? { ...event.target, value: undefined } : undefined,
      interaction: { ...event.interaction, text },
    };
  }

  private textDelta(previous: string | undefined, current: string): string {
    if (previous === undefined) return current;
    if (current.startsWith(previous)) return current.slice(previous.length) || current;
    if (previous.startsWith(current)) return `<deleted:${previous.length - current.length}>`;
    return current;
  }
}

function burstWindow(event: HistoryEvent): number | undefined {
  if (event.kind === "mouse.click") return 0.8;
  if (event.kind === "window.changed") {
    if (event.captureReason === "title_change") return 2;
    return 1;
  }
  return undefined;
}

function shouldCoalesceBurst(previous: HistoryEvent, latest: HistoryEvent): boolean {
  const elapsed = elapsedSeconds(latest, previous);
  if (elapsed < 0) return false;
  if (latest.kind !== "window.changed" || previous.kind !== "window.changed") {
    const window = burstWindow(latest);
    return window !== undefined && elapsed <= window;
  }
  if (latest.captureReason !== previous.captureReason) return elapsed <= 1;
  if (latest.captureReason === "title_change") return elapsed <= 2;
  return elapsed <= 0.75 && windowIdentity(latest) === windowIdentity(previous);
}

export class EventBurstCoalescer {
  private readonly pendingByStream = new Map<string, HistoryEvent>();

  ingest(event: HistoryEvent): { ready: HistoryEvent[]; coalescedCount: number } {
    const window = burstWindow(event);
    if (window === undefined) return { ready: [event], coalescedCount: 0 };
    const key = this.streamKey(event);
    const previous = this.pendingByStream.get(key);
    if (!previous) {
      this.pendingByStream.set(key, event);
      return { ready: [], coalescedCount: 0 };
    }
    if (shouldCoalesceBurst(previous, event)) {
      this.pendingByStream.set(key, this.merge(previous, event));
      return { ready: [], coalescedCount: event.occurrenceCount ?? 1 };
    }
    this.pendingByStream.set(key, event);
    return { ready: [previous], coalescedCount: 0 };
  }

  flushExpired(date = new Date()): HistoryEvent[] {
    const ready: HistoryEvent[] = [];
    for (const [key, event] of this.pendingByStream) {
      const window = burstWindow(event);
      if (
        window !== undefined &&
        (date.getTime() - Date.parse(event.timestamp)) / 1_000 >= window
      ) {
        ready.push(event);
        this.pendingByStream.delete(key);
      }
    }
    return ready.sort((lhs, rhs) => Date.parse(lhs.timestamp) - Date.parse(rhs.timestamp));
  }

  flushAll(): HistoryEvent[] {
    const ready = [...this.pendingByStream.values()].sort(
      (lhs, rhs) => Date.parse(lhs.timestamp) - Date.parse(rhs.timestamp),
    );
    this.pendingByStream.clear();
    return ready;
  }

  reset(): void {
    this.pendingByStream.clear();
  }

  private streamKey(event: HistoryEvent): string {
    const components = [event.kind, event.application.bundleIdentifier];
    if (event.kind === "window.changed") {
      // All reasons for the same application share one pending transition. The
      // coalescing predicate still protects distinct same-reason window events.
    } else {
      components.push(event.window?.title ?? "", event.window?.url ?? "");
    }
    if (event.kind === "mouse.click") {
      components.push(
        event.target?.role ?? "",
        event.target?.subrole ?? "",
        event.target?.identifier ?? "",
        event.target?.title ?? "",
        event.target?.description ?? "",
        event.interaction?.mouseButton ?? "",
      );
    }
    return components.join("\u001f").slice(0, 1_024);
  }

  private merge(previous: HistoryEvent, latest: HistoryEvent): HistoryEvent {
    const previousAX = previous.accessibility;
    const latestAX = latest.accessibility;
    let accessibility = latestAX ?? previousAX;
    if (previousAX && latestAX && JSON.stringify(previousAX) !== JSON.stringify(latestAX)) {
      const mode =
        previousAX.mode === "fullTree" || latestAX.mode === "fullTree"
          ? "fullTree"
          : "diffFromPrevious";
      if (hasAccessibilityStructure(previousAX) || hasAccessibilityStructure(latestAX)) {
        // A newer full snapshot supersedes everything before it; otherwise the newer
        // delta is applied on top of the retained full snapshot or earlier deltas.
        const tree = latestAX.tree ?? previousAX.tree;
        const delta = latestAX.tree
          ? undefined
          : mergeAXTreeDeltas(previousAX.tree ? undefined : previousAX.delta, latestAX.delta);
        accessibility = renderedAccessibilityContext({ mode, tree, delta });
      } else {
        accessibility = { mode, text: `${previousAX.text}\n${latestAX.text}`.slice(0, 48_000) };
      }
    }
    const captureReasons = [
      ...(previous.coalescedCaptureReasons ?? [previous.captureReason]),
      ...(latest.coalescedCaptureReasons ?? [latest.captureReason]),
    ].filter(
      (reason): reason is NonNullable<HistoryEvent["captureReason"]> => reason !== undefined,
    );
    const uniqueCaptureReasons = [...new Set(captureReasons)];
    return {
      ...latest,
      coalescedCaptureReasons:
        uniqueCaptureReasons.length > 1 ? uniqueCaptureReasons : latest.coalescedCaptureReasons,
      occurrenceCount: (previous.occurrenceCount ?? 1) + (latest.occurrenceCount ?? 1),
      accessibility,
    };
  }
}

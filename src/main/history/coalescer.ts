import type { HistoryEvent, HistoryEventKind } from "./types.js";

export function classifyKeyboardEvent(event: HistoryEvent): HistoryEvent {
  if (event.kind !== "keyboard.shortcut") return event;
  const key = event.interaction?.keyEquivalent?.toLowerCase() ?? "";
  if (!["return", "enter", "numpad-enter"].includes(key)) return event;
  const modifiers = new Set(event.interaction?.modifiers ?? []);
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
  const submits =
    modifiers.has("cmd") ||
    modifiers.has("ctrl") ||
    ["AXTextField", "AXSearchField", "AXComboBox"].includes(role) ||
    submitMarkers.some((marker) => label.includes(marker));
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

export class EventCoalescer {
  private readonly lastAcceptedByStream = new Map<string, HistoryEvent>();
  private readonly lastAcceptedTextByStream = new Map<string, string>();

  process(event: HistoryEvent): HistoryEvent | undefined {
    const stream = this.streamKey(event);
    const previous = this.lastAcceptedByStream.get(stream);
    const elapsed = previous ? elapsedSeconds(event, previous) : Number.POSITIVE_INFINITY;

    if (event.kind === "selection.changed") {
      const selection = event.interaction?.selectedText?.trim();
      if (!selection || elapsed < 0.2) return undefined;
      if (previous?.interaction?.selectedText === event.interaction?.selectedText) return undefined;
    }

    if (event.kind === "window.changed" && previous) {
      const sameWindow =
        payload({
          ...event,
          target: undefined,
          interaction: undefined,
          accessibility: undefined,
        }) ===
        payload({
          ...previous,
          target: undefined,
          interaction: undefined,
          accessibility: undefined,
        });
      if (sameWindow) {
        if (elapsed <= 0.4) return undefined;
        const hasNewAXContext =
          event.accessibility !== undefined &&
          JSON.stringify(event.accessibility) !== JSON.stringify(previous.accessibility);
        if (!hasNewAXContext) return undefined;
      }
    }

    let normalized = event;
    if (event.kind === "keyboard.text_input") {
      const currentText = event.interaction?.text ?? event.target?.value;
      if (currentText === undefined || elapsed < 0.35) return undefined;
      const previousText = this.lastAcceptedTextByStream.get(stream);
      if (previousText === currentText) return undefined;
      normalized = this.replacingText(event, this.textDelta(previousText, currentText));
      this.lastAcceptedTextByStream.set(stream, currentText);
    }

    if (
      event.kind !== "mouse.click" &&
      event.kind !== "window.changed" &&
      previous &&
      elapsed <= 0.4 &&
      payload(normalized) === payload(previous)
    ) {
      return undefined;
    }

    this.lastAcceptedByStream.set(stream, normalized);
    return normalized;
  }

  private streamKey(event: HistoryEvent): string {
    const components = [event.kind, event.application.bundleIdentifier];
    if (event.kind === "keyboard.text_input" || event.kind === "selection.changed") {
      components.push(
        event.window?.title ?? "",
        event.target?.identifier ?? "",
        event.target?.role ?? "",
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

function burstWindow(kind: HistoryEventKind): number | undefined {
  if (kind === "mouse.click") return 0.8;
  if (kind === "window.changed") return 0.75;
  return undefined;
}

export class EventBurstCoalescer {
  private readonly pendingByStream = new Map<string, HistoryEvent>();

  ingest(event: HistoryEvent): HistoryEvent[] {
    const window = burstWindow(event.kind);
    if (window === undefined) return [event];
    const key = this.streamKey(event);
    const previous = this.pendingByStream.get(key);
    if (!previous) {
      this.pendingByStream.set(key, event);
      return [];
    }
    if (elapsedSeconds(event, previous) <= window) {
      this.pendingByStream.set(key, this.merge(previous, event));
      return [];
    }
    this.pendingByStream.set(key, event);
    return [previous];
  }

  flushExpired(date = new Date()): HistoryEvent[] {
    const ready: HistoryEvent[] = [];
    for (const [key, event] of this.pendingByStream) {
      const window = burstWindow(event.kind);
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

  private streamKey(event: HistoryEvent): string {
    const components = [
      event.kind,
      event.application.bundleIdentifier,
      event.window?.title ?? "",
      event.window?.url ?? "",
    ];
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
      accessibility = {
        mode:
          previousAX.mode === "fullTree" || latestAX.mode === "fullTree"
            ? "fullTree"
            : "diffFromPrevious",
        text: `${previousAX.text}\n${latestAX.text}`.slice(0, 48_000),
      };
    }
    return {
      ...latest,
      occurrenceCount: (previous.occurrenceCount ?? 1) + (latest.occurrenceCount ?? 1),
      accessibility,
    };
  }
}

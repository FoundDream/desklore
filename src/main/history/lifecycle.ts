import type { HistoryEvent, HistoryEventKind } from "./types.js";

interface PreparedEvent {
  event: HistoryEvent;
  timestamp: number;
  accessibilitySize: number;
  priority: number;
}

function semanticPriority(kind: HistoryEventKind): number {
  const priorities: Record<HistoryEventKind, number> = {
    "keyboard.submit": 8,
    "keyboard.shortcut": 7,
    "keyboard.text_input": 6,
    "selection.changed": 5,
    "mouse.drag": 4,
    "mouse.context_menu": 4,
    "mouse.click": 3,
    "window.changed": 1,
  };
  return priorities[kind];
}

function prepare(events: HistoryEvent[]): PreparedEvent[] {
  return events
    .map((event) => {
      const accessibilitySize = event.accessibility?.text.length ?? 0;
      return {
        event,
        timestamp: Date.parse(event.timestamp),
        accessibilitySize,
        priority:
          semanticPriority(event.kind) * 10 + Math.min(9, Math.floor(accessibilitySize / 512)),
      };
    })
    .sort((lhs, rhs) => lhs.timestamp - rhs.timestamp || lhs.event.id.localeCompare(rhs.event.id));
}

function orderedGroups<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const group = groups.get(value) ?? [];
    group.push(item);
    groups.set(value, group);
  }
  return [...groups.values()];
}

export function sampleTimelineEvents(
  events: HistoryEvent[],
  requestedLimit: number,
): HistoryEvent[] {
  const prepared = prepare(events);
  const limit = Math.max(1, requestedLimit);
  if (prepared.length <= limit) return prepared.map((item) => item.event);

  const selected = new Map<string, PreparedEvent>();
  const add = (item: PreparedEvent | undefined): void => {
    if (item && selected.size < limit) selected.set(item.event.id, item);
  };
  add(prepared[0]);
  add(prepared.at(-1));

  const accessibilityBudget = Math.max(2, Math.min(24, Math.floor(limit / 4)));
  prepared
    .filter((item) => item.accessibilitySize > 0)
    .sort(
      (lhs, rhs) => rhs.accessibilitySize - lhs.accessibilitySize || rhs.priority - lhs.priority,
    )
    .slice(0, accessibilityBudget)
    .forEach(add);

  const appGroups = orderedGroups(prepared, (item) => item.event.application.bundleIdentifier);
  appGroups.forEach((group) => add(group[0]));
  appGroups.forEach((group) => add(group.at(-1)));
  appGroups.forEach((group) =>
    add(group.reduce((lhs, rhs) => (rhs.priority > lhs.priority ? rhs : lhs))),
  );

  const kindGroups = orderedGroups(prepared, (item) => item.event.kind);
  kindGroups.forEach((group) => {
    add(group[0]);
    add(group.at(-1));
  });

  const transitions = prepared.filter(
    (item, index) =>
      index > 0 &&
      prepared[index - 1]?.event.application.bundleIdentifier !==
        item.event.application.bundleIdentifier,
  );
  addEvenly(transitions, selected, limit);
  addEvenly(prepared, selected, limit);
  return [...selected.values()]
    .sort((lhs, rhs) => lhs.timestamp - rhs.timestamp || lhs.event.id.localeCompare(rhs.event.id))
    .map((item) => item.event);
}

function addEvenly(
  source: PreparedEvent[],
  selected: Map<string, PreparedEvent>,
  limit: number,
): void {
  if (!source.length || selected.size >= limit) return;
  const count = Math.min(source.length, limit - selected.size);
  for (let index = 0; index < count; index += 1) {
    const sourceIndex =
      count === 1
        ? Math.floor(source.length / 2)
        : Math.floor((index * (source.length - 1)) / (count - 1));
    const item = source[sourceIndex];
    if (item) selected.set(item.event.id, item);
  }
  for (const item of source) {
    if (selected.size >= limit) break;
    selected.set(item.event.id, item);
  }
}

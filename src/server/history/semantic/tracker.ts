import type { AXTreeSnapshot, HistoryEvent } from "../contracts.js";
import { applyAXTreeDelta, extractSemanticFrame, type FrameLimits } from "./frame.js";

const maximumTrackedStreams = 64;

/**
 * Keeps the latest full Accessibility snapshot per window stream so delta-only events can
 * still yield a frame. Runs on the persistence path after sanitization and burst
 * coalescing; the collector restarts each stream with a full snapshot at segment
 * boundaries, so a delta without a known base simply produces no frame.
 */
export class SemanticFrameTracker {
  private readonly snapshots = new Map<string, AXTreeSnapshot>();

  constructor(private readonly limits?: FrameLimits) {}

  process(event: HistoryEvent): HistoryEvent {
    const context = event.accessibility;
    if (!context || (!context.tree && !context.delta)) return event;
    const key = streamKey(event);
    let snapshot = context.tree ?? this.snapshots.get(key);
    if (!snapshot) return event;
    if (context.delta) snapshot = applyAXTreeDelta(snapshot, context.delta);
    this.remember(key, snapshot);
    return {
      ...event,
      semantic: extractSemanticFrame({
        bundleIdentifier: event.application.bundleIdentifier,
        windowTitle: event.window?.title,
        url: event.window?.url,
        snapshot,
        limits: this.limits,
      }),
    };
  }

  reset(): void {
    this.snapshots.clear();
  }

  private remember(key: string, snapshot: AXTreeSnapshot): void {
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
    while (this.snapshots.size > maximumTrackedStreams) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
  }
}

function streamKey(event: HistoryEvent): string {
  return [
    event.application.bundleIdentifier,
    event.window?.runtimeIdentifier ?? event.window?.title ?? "",
  ].join("");
}

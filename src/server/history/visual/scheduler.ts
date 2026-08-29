import { createHash } from "node:crypto";
import type { HistoryEvent } from "../contracts.js";
import type { VisualCapturePayload } from "./service.js";
import {
  VisualCapturePolicyScheduler,
  visualCaptureLimits,
  type VisualCaptureGateDecision,
} from "./policy.js";

export {
  visualCaptureLimits,
  type VisualCaptureGateDecision,
  type VisualCaptureGateReason,
} from "./policy.js";

export interface CachedVisualUnderstanding {
  understanding: string;
  confidence: number;
  createdAtMilliseconds: number;
}

export function visualWindowKey(event: HistoryEvent, resolvedRuntimeIdentifier?: number): string {
  const runtimeIdentifier = resolvedRuntimeIdentifier ?? event.window?.runtimeIdentifier;
  const windowIdentity = runtimeIdentifier !== undefined ? `id:${runtimeIdentifier}` : "unresolved";
  return `${event.application.bundleIdentifier}\u001f${windowIdentity}`;
}

export function visualPayloadSignature(payload: VisualCapturePayload): string | undefined {
  if (!payload.imageBase64) return undefined;
  return createHash("sha256").update(payload.imageBase64).digest("base64url");
}

export class VisualCaptureScheduler {
  private readonly policy = new VisualCapturePolicyScheduler();

  reserve(event: HistoryEvent, nowMilliseconds = Date.now()): VisualCaptureGateDecision {
    const windowKey = visualWindowKey(event);
    const applicationKey = event.application.bundleIdentifier;
    const hasStableWindowIdentity = event.window?.runtimeIdentifier !== undefined;
    return this.policy.reserve(
      { applicationKey, windowKey, hasStableWindowIdentity },
      nowMilliseconds,
    );
  }

  recordProviderSuccess(): void {
    this.policy.recordProviderSuccess();
  }

  recordProviderFailure(nowMilliseconds = Date.now()): number {
    return this.policy.recordProviderFailure(nowMilliseconds);
  }
}

export class VisualUnderstandingCache {
  private readonly entries = new Map<string, CachedVisualUnderstanding & { signature: string }>();

  get(
    windowKey: string,
    signature: string,
    nowMilliseconds = Date.now(),
  ): CachedVisualUnderstanding | undefined {
    const entry = this.entries.get(windowKey);
    if (!entry) return undefined;
    if (nowMilliseconds - entry.createdAtMilliseconds >= visualCaptureLimits.cacheTTLMilliseconds) {
      this.entries.delete(windowKey);
      return undefined;
    }
    if (entry.signature !== signature) return undefined;
    return {
      understanding: entry.understanding,
      confidence: entry.confidence,
      createdAtMilliseconds: entry.createdAtMilliseconds,
    };
  }

  set(windowKey: string, signature: string, understanding: CachedVisualUnderstanding): void {
    for (const [key, entry] of this.entries) {
      if (
        understanding.createdAtMilliseconds - entry.createdAtMilliseconds >=
        visualCaptureLimits.cacheTTLMilliseconds
      ) {
        this.entries.delete(key);
      }
    }
    this.entries.set(windowKey, { signature, ...understanding });
  }

  clear(): void {
    this.entries.clear();
  }
}

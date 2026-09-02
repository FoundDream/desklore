// Chosen by replaying recorded capture traces: the settle delay collapses a window's burst into one
// candidate, and the per-window cooldown bounds repeats without a global capture quota. Both trade
// screenshot volume against how quickly a changed window is observed again.
export const visualCaptureLimits = {
  settleMilliseconds: 500,
  windowCooldownMilliseconds: 12_000,
  cacheTTLMilliseconds: 30 * 60_000,
  providerBackoffMilliseconds: [30_000, 2 * 60_000, 10 * 60_000] as const,
};

export interface VisualCapturePolicyIdentity {
  applicationKey: string;
  windowKey: string;
  hasStableWindowIdentity: boolean;
}

export type VisualCaptureGateReason = "capture_allowed" | "window_cooldown" | "provider_backoff";

export interface VisualCaptureGateDecision {
  allowed: boolean;
  reason: VisualCaptureGateReason;
  windowKey: string;
  retryAfterMilliseconds?: number;
}

export interface VisualCapturePolicyLimits {
  windowCooldownMilliseconds: number;
  cacheTTLMilliseconds: number;
  providerBackoffMilliseconds: readonly number[];
}

export class VisualCapturePolicyScheduler {
  private readonly limits: VisualCapturePolicyLimits;
  private readonly lastAttemptByWindow = new Map<string, number>();
  private readonly lastAttemptByApplication = new Map<string, number>();
  private readonly lastUnresolvedAttemptByApplication = new Map<string, number>();
  private providerFailureCount = 0;
  private providerBlockedUntil = 0;

  constructor(limits: VisualCapturePolicyLimits = visualCaptureLimits) {
    this.limits = limits;
  }

  reserve(
    identity: VisualCapturePolicyIdentity,
    nowMilliseconds = Date.now(),
  ): VisualCaptureGateDecision {
    this.prune(nowMilliseconds);

    if (nowMilliseconds < this.providerBlockedUntil) {
      return {
        allowed: false,
        reason: "provider_backoff",
        windowKey: identity.windowKey,
        retryAfterMilliseconds: this.providerBlockedUntil - nowMilliseconds,
      };
    }

    const lastWindowAttempt = identity.hasStableWindowIdentity
      ? this.lastAttemptByWindow.get(identity.windowKey)
      : this.lastAttemptByApplication.get(identity.applicationKey);
    const lastUnresolvedAttempt = identity.hasStableWindowIdentity
      ? this.lastUnresolvedAttemptByApplication.get(identity.applicationKey)
      : undefined;
    const cooldownReference = Math.max(
      lastWindowAttempt ?? Number.NEGATIVE_INFINITY,
      lastUnresolvedAttempt ?? Number.NEGATIVE_INFINITY,
    );
    if (
      Number.isFinite(cooldownReference) &&
      nowMilliseconds - cooldownReference < this.limits.windowCooldownMilliseconds
    ) {
      return {
        allowed: false,
        reason: "window_cooldown",
        windowKey: identity.windowKey,
        retryAfterMilliseconds:
          this.limits.windowCooldownMilliseconds - (nowMilliseconds - cooldownReference),
      };
    }

    this.lastAttemptByWindow.set(identity.windowKey, nowMilliseconds);
    this.lastAttemptByApplication.set(identity.applicationKey, nowMilliseconds);
    if (!identity.hasStableWindowIdentity) {
      this.lastUnresolvedAttemptByApplication.set(identity.applicationKey, nowMilliseconds);
    }
    return { allowed: true, reason: "capture_allowed", windowKey: identity.windowKey };
  }

  recordProviderSuccess(): void {
    this.providerFailureCount = 0;
    this.providerBlockedUntil = 0;
  }

  recordProviderFailure(nowMilliseconds = Date.now()): number {
    const index = Math.min(
      this.providerFailureCount,
      this.limits.providerBackoffMilliseconds.length - 1,
    );
    const delay = this.limits.providerBackoffMilliseconds[index]!;
    this.providerFailureCount += 1;
    this.providerBlockedUntil = Math.max(this.providerBlockedUntil, nowMilliseconds + delay);
    return delay;
  }

  private prune(nowMilliseconds: number): void {
    const staleWindowAge = this.limits.cacheTTLMilliseconds;
    for (const [key, attemptedAt] of this.lastAttemptByWindow) {
      if (nowMilliseconds - attemptedAt >= staleWindowAge) this.lastAttemptByWindow.delete(key);
    }
    for (const [key, attemptedAt] of this.lastAttemptByApplication) {
      if (nowMilliseconds - attemptedAt >= staleWindowAge) {
        this.lastAttemptByApplication.delete(key);
      }
    }
    for (const [key, attemptedAt] of this.lastUnresolvedAttemptByApplication) {
      if (nowMilliseconds - attemptedAt >= staleWindowAge) {
        this.lastUnresolvedAttemptByApplication.delete(key);
      }
    }
  }
}

import type { HistoryEvent, ObservationPolicy, WindowTitleExclusionRule } from "../contracts.js";

const sensitiveLabels = [
  "password",
  "passwd",
  "passcode",
  "secret",
  "api key",
  "token",
  "密码",
  "口令",
  "验证码",
  "密钥",
];

const secretPatterns = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:\d[ -]?){13,19}\b/g,
];

const alwaysBlockedBundleIdentifiers = new Set([
  "com.apple.loginwindow",
  "com.apple.SecurityAgent",
  "com.apple.ScreenSaver.Engine",
]);

export type ObservationDecisionReason =
  | "allowed"
  | "protected_surface"
  | "private_browsing"
  | "sensitive_target"
  | "application_excluded"
  | "domain_excluded"
  | "window_title_excluded";

export interface ObservationDecision {
  allowed: boolean;
  reason: ObservationDecisionReason;
  ruleID?: string;
}

export const observationPolicyLimits = {
  maximumBundleIdentifierLength: 512,
  maximumDomainLength: 253,
  maximumWindowTitleRules: 50,
  minimumWindowTitlePatternLength: 3,
  maximumWindowTitlePatternLength: 128,
  maximumWindowTitleMatchLength: 1_024,
} as const;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function normalizeBundleIdentifier(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > observationPolicyLimits.maximumBundleIdentifierLength ||
    !/^[A-Za-z0-9.-]+$/.test(normalized)
  ) {
    throw new Error("Invalid application bundle identifier");
  }
  return normalized;
}

export function normalizeDomainRule(value: string): string {
  const raw = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !raw ||
    raw.length > observationPolicyLimits.maximumDomainLength ||
    raw.includes("://") ||
    /[/?#@]/.test(raw)
  ) {
    throw new Error("Invalid observation domain");
  }
  try {
    const parsed = new URL(`https://${raw}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || parsed.port || hostname.length > observationPolicyLimits.maximumDomainLength) {
      throw new Error("Invalid observation domain");
    }
    return hostname;
  } catch {
    throw new Error("Invalid observation domain");
  }
}

function normalizeWindowTitlePattern(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < observationPolicyLimits.minimumWindowTitlePatternLength ||
    normalized.length > observationPolicyLimits.maximumWindowTitlePatternLength
  ) {
    throw new Error("Invalid window title exclusion pattern");
  }
  return normalized;
}

export function normalizeWindowTitleRule(value: unknown): WindowTitleExclusionRule {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid window title exclusion rule");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.pattern !== "string" ||
    (candidate.match !== "contains" && candidate.match !== "exact") ||
    (candidate.bundleIdentifier !== undefined && typeof candidate.bundleIdentifier !== "string")
  ) {
    throw new Error("Invalid window title exclusion rule");
  }
  const id = candidate.id.trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9-]+$/.test(id)) {
    throw new Error("Invalid window title exclusion rule ID");
  }
  return {
    id,
    pattern: normalizeWindowTitlePattern(candidate.pattern),
    match: candidate.match,
    bundleIdentifier: candidate.bundleIdentifier
      ? normalizeBundleIdentifier(candidate.bundleIdentifier)
      : undefined,
  };
}

export function normalizeObservationPolicy(policy: ObservationPolicy): ObservationPolicy {
  if (!policy || typeof policy !== "object") throw new Error("Invalid observation policy");
  if (!(["observe", "do_not_observe"] as const).includes(policy.defaultApplicationBehavior)) {
    throw new Error("Invalid default application behavior");
  }
  if (!(["observe", "do_not_observe"] as const).includes(policy.defaultURLBehavior)) {
    throw new Error("Invalid default URL behavior");
  }
  const stringList = (value: unknown, normalize: (item: string) => string): string[] => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error("Invalid observation policy rule list");
    }
    return unique(value.map(normalize));
  };
  if (
    !Array.isArray(policy.blockedWindowTitles) ||
    policy.blockedWindowTitles.length > observationPolicyLimits.maximumWindowTitleRules
  ) {
    throw new Error("Invalid window title exclusion rules");
  }
  const blockedWindowTitles = policy.blockedWindowTitles.map(normalizeWindowTitleRule);
  if (new Set(blockedWindowTitles.map((rule) => rule.id)).size !== blockedWindowTitles.length) {
    throw new Error("Duplicate window title exclusion rule ID");
  }
  return {
    defaultApplicationBehavior: policy.defaultApplicationBehavior,
    defaultURLBehavior: policy.defaultURLBehavior,
    allowedBundleIdentifiers: stringList(
      policy.allowedBundleIdentifiers,
      normalizeBundleIdentifier,
    ),
    blockedBundleIdentifiers: stringList(
      policy.blockedBundleIdentifiers,
      normalizeBundleIdentifier,
    ),
    allowedDomains: stringList(policy.allowedDomains, normalizeDomainRule),
    blockedDomains: stringList(policy.blockedDomains, normalizeDomainRule),
    blockedWindowTitles,
  };
}

export function cleanText(value: string | undefined, limit: number): string | undefined {
  if (!value) return value;
  let result = value;
  for (const pattern of secretPatterns) result = result.replace(pattern, "[REDACTED]");
  return result.slice(0, Math.max(0, limit));
}

export function isSensitiveTarget(target: HistoryEvent["target"]): boolean {
  if (!target) return false;
  if (target.role === "AXSecureTextField") return true;
  const label = [
    target.role,
    target.subrole,
    target.identifier,
    target.title,
    target.description,
    target.placeholder,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return sensitiveLabels.some((value) => label.includes(value));
}

export function sanitizeURL(value: string | undefined, limit = 2_048): string | undefined {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return cleanText(parsed.toString(), limit);
  } catch {
    return cleanText(value, limit);
  }
}

/**
 * Produces the presentation-safe form of an event: cleaned text, and rendered
 * Accessibility text only. Structured Accessibility nodes are re-attached solely on the
 * persistence path by `withSanitizedAccessibilityTree` in the semantic module. This module
 * stays free of runtime imports because the offline evaluators load it directly.
 */
export function sanitizeEvent(
  event: HistoryEvent,
  textLimit = 4_096,
  accessibilityTextLimit = 48_000,
): HistoryEvent {
  const sensitive = isSensitiveTarget(event.target);
  return {
    ...event,
    window: event.window
      ? {
          title: cleanText(event.window.title, 1_024),
          url: sanitizeURL(event.window.url),
          isPrivateBrowsing: event.window.isPrivateBrowsing,
          runtimeIdentifier: event.window.runtimeIdentifier,
        }
      : undefined,
    target: event.target
      ? {
          role: cleanText(event.target.role, 256),
          subrole: cleanText(event.target.subrole, 256),
          identifier: cleanText(event.target.identifier, 512),
          title: cleanText(event.target.title, 1_024),
          description: cleanText(event.target.description, 1_024),
          placeholder: cleanText(event.target.placeholder, 1_024),
          value: sensitive ? undefined : cleanText(event.target.value, textLimit),
        }
      : undefined,
    interaction: event.interaction
      ? {
          ...event.interaction,
          text: sensitive ? undefined : cleanText(event.interaction.text, textLimit),
          selectedText: sensitive
            ? undefined
            : cleanText(event.interaction.selectedText, textLimit),
          keyEquivalent: cleanText(event.interaction.keyEquivalent, 128),
          modifiers: event.interaction.modifiers
            ?.map((value) => cleanText(value, 32))
            .filter((value): value is string => value !== undefined),
          mouseButton: cleanText(event.interaction.mouseButton, 64),
        }
      : undefined,
    accessibility: event.accessibility
      ? {
          mode: event.accessibility.mode,
          text: cleanText(event.accessibility.text, accessibilityTextLimit) ?? "",
        }
      : undefined,
    evidence: event.evidence
      ? {
          axSufficiency: event.evidence.axSufficiency,
          visual: event.evidence.visual
            ? {
                ...event.evidence.visual,
                ocrText: cleanText(event.evidence.visual.ocrText, accessibilityTextLimit),
                understanding: cleanText(event.evidence.visual.understanding, textLimit),
              }
            : undefined,
        }
      : undefined,
  };
}

export function domainFromURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function domainMatches(domain: string, rules: string[]): boolean {
  const normalized = domain.toLowerCase();
  return rules.some((rule) => normalized === rule || normalized.endsWith(`.${rule}`));
}

function normalizedWindowTitle(value: string): string {
  return value
    .slice(0, observationPolicyLimits.maximumWindowTitleMatchLength)
    .normalize("NFKC")
    .toLowerCase();
}

export function matchingWindowTitleRule(
  policy: ObservationPolicy,
  event: HistoryEvent,
): WindowTitleExclusionRule | undefined {
  const title = event.window?.title;
  if (!title) return undefined;
  const normalizedTitle = normalizedWindowTitle(title);
  return policy.blockedWindowTitles.find((rule) => {
    if (rule.bundleIdentifier && rule.bundleIdentifier !== event.application.bundleIdentifier) {
      return false;
    }
    const pattern = normalizedWindowTitle(rule.pattern);
    return rule.match === "exact" ? normalizedTitle === pattern : normalizedTitle.includes(pattern);
  });
}

export function allowsApplication(policy: ObservationPolicy, bundleIdentifier: string): boolean {
  if (
    !bundleIdentifier ||
    alwaysBlockedBundleIdentifiers.has(bundleIdentifier) ||
    policy.blockedBundleIdentifiers.includes(bundleIdentifier)
  ) {
    return false;
  }
  return (
    policy.allowedBundleIdentifiers.includes(bundleIdentifier) ||
    policy.defaultApplicationBehavior === "observe"
  );
}

export function allowsDomain(policy: ObservationPolicy, domain: string): boolean {
  if (domainMatches(domain, policy.blockedDomains)) return false;
  return domainMatches(domain, policy.allowedDomains) || policy.defaultURLBehavior === "observe";
}

export function applyObservationPolicy(
  policy: ObservationPolicy,
  event: HistoryEvent,
): HistoryEvent | undefined {
  return observationDecision(policy, event).allowed ? sanitizeEvent(event) : undefined;
}

export function observationDecision(
  policy: ObservationPolicy,
  event: HistoryEvent,
): ObservationDecision {
  if (
    event.application.bundleIdentifier === "com.desklore.desktop" ||
    (event.application.bundleIdentifier === "com.github.Electron" &&
      event.window?.title === "DeskLore")
  ) {
    return { allowed: false, reason: "protected_surface" };
  }
  if (alwaysBlockedBundleIdentifiers.has(event.application.bundleIdentifier)) {
    return { allowed: false, reason: "protected_surface" };
  }
  if (event.window?.isPrivateBrowsing) return { allowed: false, reason: "private_browsing" };
  if (isSensitiveTarget(event.target)) return { allowed: false, reason: "sensitive_target" };
  if (!allowsApplication(policy, event.application.bundleIdentifier)) {
    return { allowed: false, reason: "application_excluded" };
  }
  const domain = domainFromURL(event.window?.url);
  if (domain && !allowsDomain(policy, domain)) {
    return { allowed: false, reason: "domain_excluded" };
  }
  const titleRule = matchingWindowTitleRule(policy, event);
  if (titleRule) {
    return { allowed: false, reason: "window_title_excluded", ruleID: titleRule.id };
  }
  return { allowed: true, reason: "allowed" };
}

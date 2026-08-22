import type { HistoryEvent, ObservationPolicy } from "./types.js";

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

export const defaultObservationPolicy: ObservationPolicy = {
  defaultApplicationBehavior: "observe",
  defaultURLBehavior: "observe",
  allowedBundleIdentifiers: [],
  blockedBundleIdentifiers: [],
  allowedDomains: [],
  blockedDomains: [],
};

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
          ...event.accessibility,
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
  if (!allowsApplication(policy, event.application.bundleIdentifier)) return undefined;
  if (
    event.application.bundleIdentifier === "com.ziwen.computer-history.desktop" ||
    (event.application.bundleIdentifier === "com.github.Electron" &&
      event.window?.title === "Computer History")
  ) {
    return undefined;
  }
  if (event.window?.isPrivateBrowsing || isSensitiveTarget(event.target)) return undefined;
  const domain = domainFromURL(event.window?.url);
  if (domain && !allowsDomain(policy, domain)) return undefined;
  return sanitizeEvent(event);
}

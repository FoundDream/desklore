import { useEffect, useState, type ReactNode } from "react";
import type { TimelineApplication, TimelineDocument } from "../../../../shared/contracts/index.js";
import type { MessageKey } from "../../../../shared/i18n/index.js";
import { Icon } from "./Icon.js";
import { useI18n } from "../app/i18n.js";

const summaryFailureLabels: Record<string, MessageKey> = {
  api_key_missing: "summary.apiKeyMissing",
  invalid_json: "summary.invalidJson",
  invalid_fields: "summary.invalidFields",
  invalid_evidence_ids: "summary.invalidEvidenceIds",
  agent_invalid_evidence_ids: "summary.invalidEvidenceIds",
  agent_invalid_claims: "summary.invalidEvidenceIds",
  empty_fields: "summary.emptyFields",
  agent_empty_fields: "summary.emptyFields",
  content_too_long: "summary.contentTooLong",
  agent_content_too_long: "summary.contentTooLong",
  agent_missing_final: "summary.incomplete",
  agent_turn_limit: "summary.incomplete",
  missing_output: "summary.missingOutput",
  incomplete_max_output_tokens: "summary.maxOutputTokens",
  incomplete_content_filter: "summary.contentFilter",
  incomplete_unknown: "summary.incomplete",
  model_refusal: "summary.refusal",
  response_failed: "summary.responseFailed",
  network_timeout: "summary.networkTimeout",
  network_dns_failed: "summary.dnsFailed",
  network_cannot_connect: "summary.cannotConnect",
  network_request_failed: "summary.networkFailed",
  unexpected_error: "summary.unexpectedError",
};

export type Translate = ReturnType<typeof useI18n>["t"];

export function summaryFailureLabel(reason: string, t: Translate): string {
  if (reason.startsWith("http_status_")) {
    return t("summary.httpStatus", { status: reason.slice("http_status_".length) });
  }
  if (reason.startsWith("quality_gate_failed:")) return t("summary.legacyQualityGate");
  const key = summaryFailureLabels[reason];
  return key ? t(key) : t("summary.failed");
}

const applicationIconCache = new Map<string, string | null>();
const pendingApplicationIcons = new Map<string, Promise<string | undefined>>();

function loadApplicationIcon(iconPath: string): Promise<string | undefined> {
  const cached = applicationIconCache.get(iconPath);
  if (cached !== undefined) return Promise.resolve(cached ?? undefined);

  const pending = pendingApplicationIcons.get(iconPath);
  if (pending) return pending;

  const request = window.desklore
    .getApplicationIcon(iconPath)
    .then((source) => {
      applicationIconCache.set(iconPath, source ?? null);
      return source;
    })
    .catch(() => {
      applicationIconCache.set(iconPath, null);
      return undefined;
    })
    .finally(() => pendingApplicationIcons.delete(iconPath));
  pendingApplicationIcons.set(iconPath, request);
  return request;
}

export function ApplicationIcon({ application }: { application: TimelineApplication }) {
  const iconPath = application.iconPath;
  const [source, setSource] = useState<string>();

  useEffect(() => {
    let active = true;
    if (!iconPath) {
      setSource(undefined);
      return;
    }

    const cached = applicationIconCache.get(iconPath);
    if (cached !== undefined) {
      setSource(cached ?? undefined);
      return;
    }

    void loadApplicationIcon(iconPath).then((icon) => {
      if (active) setSource(icon);
    });
    return () => {
      active = false;
    };
  }, [iconPath]);

  return (
    <span className={`app-token-icon ${source ? "loaded" : ""}`} aria-hidden="true">
      {source && <img src={source} alt="" />}
    </span>
  );
}

export function ApplicationList({
  applications,
  trailing,
  limit = 6,
}: {
  applications: TimelineApplication[];
  trailing?: ReactNode;
  limit?: number;
}) {
  const visible = applications.slice(0, limit);
  const remaining = applications.length - visible.length;
  return (
    <div className="app-list">
      {visible.map((application) => (
        <span
          className="app-token"
          title={application.bundleIdentifier}
          key={application.bundleIdentifier}
        >
          <ApplicationIcon application={application} />
          {application.name}
        </span>
      ))}
      {remaining > 0 && <span className="app-overflow">+{remaining}</span>}
      {trailing}
    </div>
  );
}

export function ContinuationHint({ item }: { item?: string }) {
  const { t } = useI18n();
  if (!item) return null;
  return (
    <aside className="continuation-hints">
      <span>{t("timeline.continuationHint")}</span>
      <p>{item}</p>
    </aside>
  );
}

export function PageHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <header className="content-header">
      <div>
        <span className="section-kicker">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {action}
    </header>
  );
}

export function dateKey(value: string): string {
  return new Date(value).toDateString();
}

export function dayLabel(value: string, locale: "en" | "zh-CN", t: Translate): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const prefix =
    date.toDateString() === today.toDateString()
      ? t("common.today")
      : date.toDateString() === yesterday.toDateString()
        ? t("common.yesterday")
        : new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  return `${prefix} · ${new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
  }).format(date)}`;
}

export function timeLabel(value: string, locale: "en" | "zh-CN"): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function durationLabel(document: TimelineDocument, t: Translate): string {
  const minutes = Math.max(
    1,
    Math.round((Date.parse(document.endedAt) - Date.parse(document.startedAt)) / 60_000),
  );
  return t("common.minutes", { count: minutes });
}

export interface DatedGroup {
  date: string;
  startedAt: string;
}

export function DaySwitcher({
  days,
  selectedDate,
  onSelect,
}: {
  days: DatedGroup[];
  selectedDate: string;
  onSelect: (date: string) => void;
}) {
  const { locale, t } = useI18n();
  const selectedIndex = Math.max(
    0,
    days.findIndex((day) => day.date === selectedDate),
  );
  const selectedDay = days[selectedIndex];
  const olderDay = days[selectedIndex + 1];
  const newerDay = days[selectedIndex - 1];

  return (
    <div className="day-switcher" role="group" aria-label={t("timeline.switchDate")}>
      <button
        type="button"
        disabled={!olderDay}
        onClick={() => olderDay && onSelect(olderDay.date)}
        aria-label={t("timeline.olderDate")}
        title={t("timeline.olderDate")}
      >
        <Icon name="chevron-left" />
      </button>
      <div className="day-switcher-current">
        <select
          aria-label={t("timeline.selectDate")}
          value={selectedDay.date}
          onChange={(event) => onSelect(event.target.value)}
        >
          {days.map((day) => (
            <option key={day.date} value={day.date}>
              {dayLabel(day.startedAt, locale, t)}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={!newerDay}
        onClick={() => newerDay && onSelect(newerDay.date)}
        aria-label={t("timeline.newerDate")}
        title={t("timeline.newerDate")}
      >
        <Icon name="chevron-right" />
      </button>
    </div>
  );
}

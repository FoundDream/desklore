import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import appIcon from "./assets/app-icon.png";
import { Icon } from "./Icon.js";
import { I18nProvider, useI18n } from "./i18n.js";
import { SettingsView as SettingsPage } from "./SettingsView.js";
import type {
  HistorySnapshot,
  DesktopSnapshot,
  HistorySearchResponse,
  MemoryRollup,
  TimelineApplication,
  TimelineDocument,
} from "../../shared/contracts.js";
import type { MessageKey } from "../../shared/i18n.js";
import { translate } from "../../shared/i18n.js";

type View = "timeline" | "memory" | "diagnostics" | "settings";
type PrimaryView = "timeline" | "memory";
type RunAction = (action: () => Promise<DesktopSnapshot>) => Promise<boolean>;

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

type Translate = ReturnType<typeof useI18n>["t"];

function summaryFailureLabel(reason: string, t: Translate): string {
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

  const request = window.computerHistory
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

function ApplicationIcon({ application }: { application: TimelineApplication }) {
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

function ApplicationList({
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

function ContinuationHint({ item }: { item?: string }) {
  const { t } = useI18n();
  if (!item) return null;
  return (
    <aside className="continuation-hints">
      <span>{t("timeline.continuationHint")}</span>
      <p>{item}</p>
    </aside>
  );
}

function PageHeader({
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

function dateKey(value: string): string {
  return new Date(value).toDateString();
}

function dayLabel(value: string, locale: "en" | "zh-CN", t: Translate): string {
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

function timeLabel(value: string, locale: "en" | "zh-CN"): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function durationLabel(document: TimelineDocument, t: Translate): string {
  const minutes = Math.max(
    1,
    Math.round((Date.parse(document.endedAt) - Date.parse(document.startedAt)) / 60_000),
  );
  return t("common.minutes", { count: minutes });
}

function ConnectionNotice({
  desktop,
  run,
  onOpenDiagnostics,
}: {
  desktop?: DesktopSnapshot;
  run: RunAction;
  onOpenDiagnostics: () => void;
}) {
  const { t } = useI18n();
  if (!desktop || !desktop.recordingConsentGranted) return null;

  if (desktop.connectionState === "connected") {
    const history = desktop.history;
    if (!history || history.recorderState !== "running") return null;
    const permissionMissing = !history.health.accessibilityGranted;
    const monitorUnavailable =
      history.health.accessibilityGranted && !history.health.interactionMonitorActive;
    if (!permissionMissing && !monitorUnavailable) return null;
    return (
      <div className="connection-notice">
        <span className="signal failed" />
        <div>
          <strong>
            {permissionMissing
              ? t("health.permissionRequired")
              : t("settings.captureNeedsAttention")}
          </strong>
        </div>
        <button
          onClick={() =>
            permissionMissing
              ? void run(() => window.computerHistory.requestPermissions())
              : onOpenDiagnostics()
          }
        >
          {permissionMissing ? t("settings.grantAccessibility") : t("settings.openDiagnostics")}
        </button>
      </div>
    );
  }

  const labels = {
    starting: t("connection.starting"),
    stopped: t("connection.stopped"),
    missing: t("connection.missing"),
    failed: t("connection.failed"),
  } as const;
  return (
    <div className="connection-notice">
      <span className={`signal ${desktop.connectionState}`} />
      <div>
        <strong>{labels[desktop.connectionState]}</strong>
        {desktop.connectionError && <small>{desktop.connectionError}</small>}
      </div>
      {desktop.connectionState !== "starting" && (
        <button onClick={() => void run(() => window.computerHistory.startCollector())}>
          {t("connection.restart")}
        </button>
      )}
    </div>
  );
}

function RecordingConsentView({
  run,
  busy,
  error,
  onDismissError,
}: {
  run: RunAction;
  busy: boolean;
  error?: string;
  onDismissError: () => void;
}) {
  const { locale, t } = useI18n();
  const [step, setStep] = useState<"boundary" | "permission">("boundary");
  const isBoundaryStep = step === "boundary";
  const details = isBoundaryStep
    ? [
        [t("onboarding.offByDefault"), t("onboarding.offByDefaultDetail")],
        [t("onboarding.autoFiltered"), t("onboarding.autoFilteredDetail")],
      ]
    : [
        [t("onboarding.separatePermission"), t("onboarding.separatePermissionDetail")],
        [t("onboarding.noScreenRecording"), t("onboarding.noScreenRecordingDetail")],
      ];

  return (
    <section className="onboarding-screen">
      <header className="onboarding-header">
        <div className="onboarding-brand">
          <img src={appIcon} alt="" />
          <strong>DeskLore</strong>
        </div>
        <div className="onboarding-header-actions">
          <select
            className="onboarding-language"
            aria-label={t("settings.language")}
            value={locale}
            disabled={busy}
            onChange={(event) =>
              void run(() => window.computerHistory.setLocale(event.target.value as "en" | "zh-CN"))
            }
          >
            <option value="en">{t("language.english")}</option>
            <option value="zh-CN">{t("language.simplifiedChinese")}</option>
          </select>
          <div
            className="onboarding-progress"
            role="progressbar"
            aria-label={t("onboarding.progress", { step: isBoundaryStep ? 1 : 2 })}
            aria-valuemin={1}
            aria-valuemax={2}
            aria-valuenow={isBoundaryStep ? 1 : 2}
          >
            <i className="active" />
            <i className={isBoundaryStep ? "" : "active"} />
          </div>
        </div>
      </header>

      {error && (
        <div className="error-banner onboarding-error">
          <strong>{t("common.actionFailed")}</strong>
          <span>{error}</span>
          <button onClick={onDismissError}>{t("common.close")}</button>
        </div>
      )}

      <div className="onboarding-stage">
        <div className="onboarding-panel">
          <img className="onboarding-app-icon" src={appIcon} alt="" />
          <span className="onboarding-kicker">
            {t("onboarding.step", { step: isBoundaryStep ? 1 : 2 })}
          </span>
          <h1>
            {isBoundaryStep ? t("onboarding.reviewBoundary") : t("onboarding.allowAccessibility")}
          </h1>
          <p className="onboarding-lead">
            {isBoundaryStep ? t("onboarding.boundaryLead") : t("onboarding.permissionLead")}
          </p>

          <div className="onboarding-details">
            {details.map(([label, value]) => (
              <div key={label}>
                <strong>{label}</strong>
                <span>{value}</span>
              </div>
            ))}
          </div>

          <div className="onboarding-actions">
            {!isBoundaryStep && (
              <button className="secondary" disabled={busy} onClick={() => setStep("boundary")}>
                {t("common.back")}
              </button>
            )}
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                if (isBoundaryStep) {
                  setStep("permission");
                } else {
                  void run(() => window.computerHistory.grantRecordingConsent());
                }
              }}
            >
              {busy
                ? t("common.starting")
                : isBoundaryStep
                  ? t("common.continue")
                  : t("onboarding.agreeAndStart")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Sidebar({
  view,
  history,
  onView,
  onToggleRecording,
}: {
  view: View;
  history?: HistorySnapshot;
  onView: (view: View) => void;
  onToggleRecording: () => void;
}) {
  const { t } = useI18n();
  const running = history?.recorderState === "running";
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <i />
        </span>
        <div>
          <strong>DeskLore</strong>
        </div>
      </div>
      <nav>
        <button className={view === "timeline" ? "active" : ""} onClick={() => onView("timeline")}>
          <Icon name="timeline" />
          <span>{t("sidebar.timeline")}</span>
          <b>{history?.documents.length ?? "—"}</b>
        </button>
        <button className={view === "memory" ? "active" : ""} onClick={() => onView("memory")}>
          <Icon name="memory" />
          <span>{t("sidebar.memory")}</span>
          <b>{history ? history.memories.filter((memory) => memory.kind === "day").length : "—"}</b>
        </button>
        <button
          className={view === "settings" || view === "diagnostics" ? "active" : ""}
          onClick={() => onView("settings")}
        >
          <Icon name="settings" />
          <span>{t("sidebar.settings")}</span>
        </button>
      </nav>
      <div className="sidebar-bottom">
        <button
          className={`record-control ${running ? "running" : ""}`}
          onClick={onToggleRecording}
        >
          <span className="record-orbit">
            <i />
          </span>
          <div>
            <strong>{running ? t("sidebar.recording") : t("sidebar.paused")}</strong>
          </div>
        </button>
      </div>
    </aside>
  );
}

function ActivityRow({
  document,
  referenced,
  onAction,
}: {
  document: TimelineDocument;
  referenced: boolean;
  onAction: (action: "open" | "delete", id: string) => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <article className={`timeline-entry ${referenced ? "referenced" : ""}`}>
      <time>{timeLabel(document.startedAt, locale)}</time>
      <div className="entry-body">
        <div className="entry-title">
          <h3>{document.title}</h3>
        </div>
        <p>{document.description}</p>
        {document.generatorFailureReason && (
          <div className="summary-error" role="status">
            <strong>{t("summary.failed")}</strong>
            <span>
              {t("summary.retrying", {
                message: summaryFailureLabel(document.generatorFailureReason, t),
                reason: document.generatorFailureReason,
              })}
            </span>
          </div>
        )}
        <footer>
          <ApplicationList
            applications={document.applications}
            trailing={<span className="duration">{durationLabel(document, t)}</span>}
          />
          <div className="entry-actions">
            <button onClick={() => void onAction("open", document.id)}>
              {t("timeline.openRecord")}
            </button>
            <button
              className={confirmDelete ? "confirm" : ""}
              onBlur={() => setConfirmDelete(false)}
              onClick={() => {
                if (confirmDelete) void onAction("delete", document.id);
                else setConfirmDelete(true);
              }}
            >
              {confirmDelete ? t("common.confirmDelete") : t("common.delete")}
            </button>
          </div>
        </footer>
      </div>
    </article>
  );
}

interface DatedGroup {
  date: string;
  startedAt: string;
}

function DaySwitcher({
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

function TimelineView({
  history,
  run,
  selectedDate,
  referencedDocumentIDs,
  onSelectDate,
}: {
  history?: HistorySnapshot;
  run: RunAction;
  selectedDate?: string;
  referencedDocumentIDs: string[];
  onSelectDate: (date?: string) => void;
}) {
  const { t } = useI18n();
  const days = useMemo(() => {
    const groups = new Map<string, TimelineDocument[]>();
    const documents = [...(history?.documents ?? [])].sort(
      (lhs, rhs) => Date.parse(rhs.startedAt) - Date.parse(lhs.startedAt),
    );
    for (const document of documents) {
      const key = dateKey(document.startedAt);
      groups.set(key, [...(groups.get(key) ?? []), document]);
    }
    return [...groups.entries()].map(([date, documents]) => ({
      date,
      startedAt: documents[0].startedAt,
      documents,
    }));
  }, [history?.documents]);
  const selectedDay = days.find((day) => day.date === selectedDate) ?? days[0];
  const referencedDocuments = useMemo(
    () => new Set(referencedDocumentIDs),
    [referencedDocumentIDs],
  );

  useEffect(() => {
    if (selectedDate && days.some((day) => day.date === selectedDate)) return;
    onSelectDate(days[0]?.date);
  }, [days, onSelectDate, selectedDate]);

  const action = async (name: "open" | "delete", id: string): Promise<void> => {
    await run(() =>
      name === "open"
        ? window.computerHistory.openDocument(id)
        : window.computerHistory.deleteDocument(id),
    );
  };

  return (
    <>
      <PageHeader
        eyebrow={t("timeline.eyebrow")}
        title={t("timeline.title")}
        action={
          <div className="header-actions">
            <button
              className="secondary"
              onClick={() => void run(() => window.computerHistory.revealStorage())}
            >
              <Icon name="folder" />
              {t("common.revealFiles")}
            </button>
            {selectedDay && (
              <DaySwitcher days={days} selectedDate={selectedDay.date} onSelect={onSelectDate} />
            )}
          </div>
        }
      />
      <section className="archive">
        {!history ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("timeline.connecting")}</h2>
          </div>
        ) : days.length === 0 ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("timeline.empty")}</h2>
          </div>
        ) : selectedDay ? (
          <div className="day-group" key={selectedDay.date}>
            {selectedDay.documents.map((document) => (
              <ActivityRow
                key={document.id}
                document={document}
                referenced={referencedDocuments.has(document.id)}
                onAction={action}
              />
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}

interface MemoryDay extends DatedGroup {
  daily?: MemoryRollup;
  periods: MemoryRollup[];
}

function memoryRangeLabel(memory: MemoryRollup, locale: "en" | "zh-CN"): string {
  return `${timeLabel(memory.startedAt, locale)}–${timeLabel(memory.endedAt, locale)}`;
}

function searchKindLabel(kind: "10min" | "6h" | "day", t: Translate): string {
  if (kind === "day") return t("memory.dailyOverview");
  if (kind === "6h") return t("memory.activitySummary");
  return t("memory.timeline");
}

function visibleSearchAnswer(answer: string): string {
  return answer.replace(/\s+\[(?:10min|6h|day):[^\]]+\]/g, "");
}

function MemorySourceFooter({
  memory,
  onOpenTimeline,
}: {
  memory: MemoryRollup;
  onOpenTimeline: (memory: MemoryRollup) => void;
}) {
  const { t } = useI18n();
  if (memory.sourceDocumentIDs.length === 0 && memory.applications.length === 0) return null;
  return (
    <footer className="memory-source">
      <ApplicationList applications={memory.applications} />
      {memory.sourceDocumentIDs.length > 0 && (
        <div className="memory-source-meta">
          <span>{t("memory.basedOnActivities", { count: memory.sourceDocumentIDs.length })}</span>
          <button onClick={() => onOpenTimeline(memory)}>{t("memory.viewTimeline")}</button>
        </div>
      )}
    </footer>
  );
}

function MemoryView({
  history,
  run,
  onOpenTimeline,
}: {
  history?: HistorySnapshot;
  run: RunAction;
  onOpenTimeline: (memory: MemoryRollup) => void;
}) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<HistorySearchResponse>();
  const [searching, setSearching] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>();
  const days = useMemo(() => {
    const memories = history?.memories ?? [];
    const periods = memories.filter((memory) => memory.kind === "6h");
    const coveredPeriods = new Set<string>();
    const groups: MemoryDay[] = memories
      .filter((memory) => memory.kind === "day")
      .map((daily) => {
        const startedAt = Date.parse(daily.startedAt);
        const endedAt = Date.parse(daily.endedAt);
        const matchingPeriods = periods
          .filter((period) => {
            const periodStart = Date.parse(period.startedAt);
            const matches = periodStart >= startedAt && periodStart < endedAt;
            if (matches) coveredPeriods.add(period.id);
            return matches;
          })
          .sort((lhs, rhs) => Date.parse(lhs.startedAt) - Date.parse(rhs.startedAt));
        return {
          date: daily.id,
          startedAt: daily.startedAt,
          daily,
          periods: matchingPeriods,
        };
      });

    const fallbackGroups = new Map<string, MemoryRollup[]>();
    for (const period of periods) {
      if (coveredPeriods.has(period.id)) continue;
      const key = dateKey(period.startedAt);
      fallbackGroups.set(key, [...(fallbackGroups.get(key) ?? []), period]);
    }
    for (const [key, fallbackPeriods] of fallbackGroups) {
      fallbackPeriods.sort((lhs, rhs) => Date.parse(lhs.startedAt) - Date.parse(rhs.startedAt));
      groups.push({
        date: `periods-${key}`,
        startedAt: fallbackPeriods[0].startedAt,
        periods: fallbackPeriods,
      });
    }
    return groups.sort((lhs, rhs) => Date.parse(rhs.startedAt) - Date.parse(lhs.startedAt));
  }, [history?.memories]);
  const selectedDay = days.find((day) => day.date === selectedDate) ?? days[0];

  useEffect(() => {
    if (selectedDate && days.some((day) => day.date === selectedDate)) return;
    setSelectedDate(days[0]?.date);
  }, [days, selectedDate]);

  const submitSearch = async (): Promise<void> => {
    const value = query.trim();
    if (!value) {
      setSearch(undefined);
      return;
    }
    setSearching(true);
    try {
      setSearch(await window.computerHistory.searchMemory(value));
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t("memory.eyebrow")}
        title={t("memory.title")}
        action={
          <div className="header-actions">
            <button
              className="secondary"
              onClick={() => void run(() => window.computerHistory.revealStorage())}
            >
              <Icon name="folder" />
              {t("common.revealFiles")}
            </button>
            {selectedDay && (
              <DaySwitcher days={days} selectedDate={selectedDay.date} onSelect={setSelectedDate} />
            )}
          </div>
        }
      />
      <section className="memory-search">
        <div>
          <span className="section-kicker">{t("memory.searchKicker")}</span>
          <h2>{t("memory.searchTitle")}</h2>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitSearch();
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("memory.searchPlaceholder")}
            maxLength={500}
          />
          <button disabled={searching}>
            {searching ? t("memory.searching") : t("memory.search")}
          </button>
        </form>
        {search && (
          <div className="memory-answer">
            <p>{visibleSearchAnswer(search.answer)}</p>
            {search.matches.length > 0 && (
              <div>
                {search.matches.slice(0, 5).map((match) => (
                  <span key={`${match.kind}-${match.id}`}>
                    {searchKindLabel(match.kind, t)} · {match.title}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
      <section className="memory-archive">
        {!history ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("memory.connecting")}</h2>
          </div>
        ) : days.length === 0 ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>{t("memory.empty")}</h2>
          </div>
        ) : selectedDay ? (
          <div className="memory-day" key={selectedDay.date}>
            {selectedDay.daily && (
              <article className="daily-memory">
                <span className="section-kicker">{t("memory.dailyOverview")}</span>
                <h2>{selectedDay.daily.title}</h2>
                <p>{selectedDay.daily.description}</p>
                <ContinuationHint item={selectedDay.daily.continuationHint} />
                <MemorySourceFooter memory={selectedDay.daily} onOpenTimeline={onOpenTimeline} />
              </article>
            )}
            {selectedDay.periods.length > 0 && (
              <section className="memory-periods">
                <header>
                  <div>
                    <span className="section-kicker">{t("memory.byTime")}</span>
                    <h2>{t("memory.activitySummary")}</h2>
                  </div>
                  <span>{t("memory.periodCount", { count: selectedDay.periods.length })}</span>
                </header>
                <div>
                  {selectedDay.periods.map((memory) => (
                    <details className="memory-period" key={memory.id}>
                      <summary>
                        <time>{memoryRangeLabel(memory, locale)}</time>
                        <div>
                          <h3>{memory.title}</h3>
                          <p>{memory.description}</p>
                        </div>
                        <span>{t("common.details")}</span>
                      </summary>
                      <div className="memory-period-details">
                        <ContinuationHint item={memory.continuationHint} />
                        <MemorySourceFooter memory={memory} onOpenTimeline={onOpenTimeline} />
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}

function DiagnosticsView({
  history,
  run,
  onBack,
}: {
  history?: HistorySnapshot;
  run: RunAction;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const health = history?.health;
  const rows = [
    [t("health.accessibility"), health?.accessibilityGranted],
    [t("health.globalInteractions"), health?.interactionMonitorActive],
    [t("health.axObserver"), health?.axObserverActive],
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow={t("health.eyebrow")}
        title={t("health.title")}
        action={
          <div className="header-actions">
            <button className="secondary" onClick={onBack}>
              {t("health.backToSettings")}
            </button>
            <button
              className="secondary"
              onClick={() =>
                void run(() =>
                  health?.accessibilityGranted && !health.interactionMonitorActive
                    ? window.computerHistory.requestPermissions()
                    : window.computerHistory.refreshPermissions(),
                )
              }
            >
              {t("health.recheck")}
            </button>
          </div>
        }
      />
      <section className="health-layout">
        <div className="health-primary">
          {rows.map(([label, healthy]) => (
            <div className="health-row" key={label}>
              <span className={healthy ? "health-icon ok" : "health-icon warn"}>
                {healthy ? "✓" : "!"}
              </span>
              <div>
                <strong>{label}</strong>
              </div>
              <b>{healthy ? t("common.ready") : t("common.notReady")}</b>
            </div>
          ))}
          {!health?.accessibilityGranted && (
            <button
              className="permission-callout"
              onClick={() => void run(() => window.computerHistory.requestPermissions())}
            >
              <span>{t("health.permissionRequired")}</span>
              <strong>{t("health.openPermission")}</strong>
            </button>
          )}
        </div>
        <div className="metric-grid">
          <div>
            <span>{t("health.captureDuration")}</span>
            <strong>
              {Math.round(health?.lastAXCaptureDurationMilliseconds ?? 0)}
              <small> ms</small>
            </strong>
          </div>
          <div>
            <span>{t("health.semanticEvents")}</span>
            <strong>
              {(health?.keyboardSubmitCount ?? 0) +
                (health?.keyboardShortcutCount ?? 0) +
                (health?.textInputEventCount ?? 0)}
            </strong>
          </div>
          <div>
            <span>{t("health.captureQueue")}</span>
            <strong>{health?.axCaptureBacklog ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.rawEvents")}</span>
            <strong>{health?.capturedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.persisted")}</span>
            <strong>{health?.persistedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.policyBlocked")}</span>
            <strong>{health?.policyBlockedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.duplicatesDropped")}</span>
            <strong>{health?.deduplicatedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>{t("health.eventsCoalesced")}</span>
            <strong>{health?.burstCoalescedEventCount ?? 0}</strong>
          </div>
        </div>
      </section>
    </>
  );
}

export function App() {
  const [view, setView] = useState<View>("timeline");
  const [returnView, setReturnView] = useState<PrimaryView>("timeline");
  const [desktop, setDesktop] = useState<DesktopSnapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selectedTimelineDate, setSelectedTimelineDate] = useState<string>();
  const [referencedDocumentIDs, setReferencedDocumentIDs] = useState<string[]>([]);

  useEffect(() => {
    void window.computerHistory
      .getSnapshot()
      .then(setDesktop)
      .catch((cause: unknown) => setError(String(cause)));
    return window.computerHistory.onSnapshot(setDesktop);
  }, []);

  useEffect(() => {
    document.querySelector<HTMLElement>(".content")?.scrollTo({ top: 0 });
  }, [view]);

  const run = useCallback(async (action: () => Promise<DesktopSnapshot>): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await action();
      setDesktop(result);
      setError(result.history?.lastError);
      return !result.history?.lastError;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const navigate = useCallback(
    (next: View): void => {
      if (next === "settings" && (view === "timeline" || view === "memory")) {
        setReturnView(view);
      }
      setView(next);
    },
    [view],
  );

  const openDiagnostics = useCallback((): void => {
    if (view === "timeline" || view === "memory") setReturnView(view);
    setView("diagnostics");
  }, [view]);

  const closeSettings = useCallback((): void => setView(returnView), [returnView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== ",") return;
      event.preventDefault();
      navigate("settings");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate]);

  const toggleRecording = (): void => {
    if (!desktop?.recordingConsentGranted) {
      void run(() => window.computerHistory.grantRecordingConsent());
    } else if (desktop.connectionState !== "connected") {
      void run(() => window.computerHistory.startCollector());
    } else if (desktop.history?.recorderState === "running") {
      void run(() => window.computerHistory.pause());
    } else {
      void run(() => window.computerHistory.resume());
    }
  };

  const selectTimelineDate = useCallback((date?: string): void => {
    setSelectedTimelineDate(date);
    setReferencedDocumentIDs([]);
  }, []);

  const openMemoryTimeline = useCallback(
    (memory: MemoryRollup): void => {
      const sourceIDs = new Set(memory.sourceDocumentIDs);
      const documents = desktop?.history?.documents ?? [];
      const firstSource = [...documents]
        .filter((document) => sourceIDs.has(document.id))
        .sort((lhs, rhs) => Date.parse(lhs.startedAt) - Date.parse(rhs.startedAt))[0];
      const targetDate = dateKey(firstSource?.startedAt ?? memory.startedAt);
      const targetDayDocuments = documents.filter(
        (document) => dateKey(document.startedAt) === targetDate,
      );
      const referencedOnTargetDay = targetDayDocuments.filter((document) =>
        sourceIDs.has(document.id),
      );
      setSelectedTimelineDate(targetDate);
      setReferencedDocumentIDs(
        referencedOnTargetDay.length === targetDayDocuments.length
          ? []
          : referencedOnTargetDay.map((document) => document.id),
      );
      setView("timeline");
    },
    [desktop?.history?.documents],
  );

  const locale = desktop?.locale ?? "en";
  const t = (key: MessageKey, values?: Record<string, string | number>): string =>
    translate(locale, key, values);

  if (!desktop) {
    return (
      <I18nProvider locale={locale}>
        <div className="startup-screen">
          {error && (
            <div className="error-banner">
              <strong>{t("startup.failed")}</strong>
              <span>{error}</span>
              <button onClick={() => setError(undefined)}>{t("common.close")}</button>
            </div>
          )}
        </div>
      </I18nProvider>
    );
  }

  if (!desktop.recordingConsentGranted) {
    return (
      <I18nProvider locale={locale}>
        <div className={`onboarding-root ${busy ? "busy" : ""}`}>
          <RecordingConsentView
            run={run}
            busy={busy}
            error={error}
            onDismissError={() => setError(undefined)}
          />
        </div>
      </I18nProvider>
    );
  }

  if (view === "settings") {
    return (
      <I18nProvider locale={locale}>
        <SettingsPage
          desktop={desktop}
          run={run}
          busy={busy}
          error={error}
          onDismissError={() => setError(undefined)}
          onBack={closeSettings}
          onOpenDiagnostics={openDiagnostics}
        />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale}>
      <div className={`app-shell ${busy ? "busy" : ""}`}>
        <Sidebar
          view={view}
          history={desktop?.history}
          onView={navigate}
          onToggleRecording={toggleRecording}
        />
        <main className="content">
          <ConnectionNotice desktop={desktop} run={run} onOpenDiagnostics={openDiagnostics} />
          {error && (
            <div className="error-banner">
              <strong>{t("common.actionFailed")}</strong>
              <span>{error}</span>
              <button onClick={() => setError(undefined)}>{t("common.close")}</button>
            </div>
          )}
          {view === "timeline" ? (
            <TimelineView
              history={desktop?.history}
              run={run}
              selectedDate={selectedTimelineDate}
              referencedDocumentIDs={referencedDocumentIDs}
              onSelectDate={selectTimelineDate}
            />
          ) : view === "memory" ? (
            <MemoryView history={desktop?.history} run={run} onOpenTimeline={openMemoryTimeline} />
          ) : (
            <DiagnosticsView
              history={desktop?.history}
              run={run}
              onBack={() => setView("settings")}
            />
          )}
        </main>
      </div>
    </I18nProvider>
  );
}

import { useMemo, useState } from "react";
import type {
  ApplicationUsageSummary,
  TimelineApplication,
} from "../../../../../shared/contracts/index.js";
import { ApplicationIcon, PageHeader } from "../../components/HistoryComponents.js";
import { useI18n } from "../../app/i18n.js";

function usageDurationLabel(
  durationMilliseconds: number,
  locale: "en" | "zh-CN",
  compact = false,
): string {
  const totalMinutes = Math.max(0, Math.round(durationMilliseconds / 60_000));
  if (totalMinutes < 1) return locale === "zh-CN" ? "< 1 分钟" : "< 1 min";
  if (totalMinutes < 60) return locale === "zh-CN" ? `${totalMinutes} 分钟` : `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (compact || minutes === 0) return locale === "zh-CN" ? `${hours} 小时` : `${hours} hr`;
  return locale === "zh-CN" ? `${hours} 小时 ${minutes} 分钟` : `${hours} hr ${minutes} min`;
}

export function UsageView({ usage }: { usage?: ApplicationUsageSummary }) {
  const { locale, t } = useI18n();
  const [range, setRange] = useState<"today" | "week">("today");
  const selectedDays = range === "today" ? (usage ? [usage.today] : []) : (usage?.last7Days ?? []);
  const applications = useMemo(() => {
    const totals = new Map<
      string,
      { application: TimelineApplication; durationMilliseconds: number }
    >();
    for (const day of selectedDays) {
      for (const item of day.applications) {
        const existing = totals.get(item.application.bundleIdentifier);
        totals.set(item.application.bundleIdentifier, {
          application: item.application,
          durationMilliseconds: (existing?.durationMilliseconds ?? 0) + item.durationMilliseconds,
        });
      }
    }
    return [...totals.values()].sort(
      (lhs, rhs) =>
        rhs.durationMilliseconds - lhs.durationMilliseconds ||
        lhs.application.name.localeCompare(rhs.application.name),
    );
  }, [selectedDays]);
  const total = applications.reduce((sum, item) => sum + item.durationMilliseconds, 0);
  const maximum = applications[0]?.durationMilliseconds ?? 1;
  const maximumDay = Math.max(
    1,
    ...(usage?.last7Days.map((day) => day.totalDurationMilliseconds) ?? []),
  );
  const dateLabel = (date: string): string =>
    new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(`${date}T12:00:00`));

  return (
    <>
      <PageHeader
        eyebrow={t("usage.eyebrow")}
        title={t("usage.title")}
        action={
          <div className="usage-range" aria-label={t("usage.range")}>
            <button className={range === "today" ? "active" : ""} onClick={() => setRange("today")}>
              {t("usage.today")}
            </button>
            <button className={range === "week" ? "active" : ""} onClick={() => setRange("week")}>
              {t("usage.last7Days")}
            </button>
          </div>
        }
      />
      <section className="usage-overview">
        <div className="usage-total">
          <span>{range === "today" ? t("usage.todayTotal") : t("usage.weekTotal")}</span>
          <strong>{usageDurationLabel(total, locale)}</strong>
          <small>{t("usage.definition")}</small>
        </div>
        <div className="usage-week" aria-label={t("usage.last7Days")}>
          {(usage?.last7Days ?? []).map((day) => (
            <div key={day.date} title={usageDurationLabel(day.totalDurationMilliseconds, locale)}>
              <span>
                <i
                  style={{
                    height:
                      day.totalDurationMilliseconds > 0
                        ? `${Math.max(3, (day.totalDurationMilliseconds / maximumDay) * 100)}%`
                        : "0%",
                  }}
                />
              </span>
              <small>{dateLabel(day.date)}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="usage-applications">
        <header>
          <h2>{t("usage.applications")}</h2>
          <span>{t("usage.applicationCount", { count: applications.length })}</span>
        </header>
        {applications.length ? (
          <div className="usage-list">
            {applications.map((item) => (
              <article key={item.application.bundleIdentifier}>
                <ApplicationIcon application={item.application} />
                <div>
                  <header>
                    <strong>{item.application.name}</strong>
                    <span>{usageDurationLabel(item.durationMilliseconds, locale)}</span>
                  </header>
                  <span className="usage-progress">
                    <i style={{ width: `${(item.durationMilliseconds / maximum) * 100}%` }} />
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state usage-empty">{t("usage.empty")}</div>
        )}
      </section>
    </>
  );
}

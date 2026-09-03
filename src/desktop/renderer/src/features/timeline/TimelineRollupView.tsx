import type { TimelineRollup } from "../../../../../shared/contracts/index.js";
import { ContinuationHint, timeLabel } from "../../components/HistoryComponents.js";
import { useI18n } from "../../app/i18n.js";

function rollupRangeLabel(rollup: TimelineRollup, locale: "en" | "zh-CN"): string {
  return `${timeLabel(rollup.startedAt, locale)}–${timeLabel(rollup.endedAt, locale)}`;
}

function RollupStatus({ status }: { status: TimelineRollup["status"] }) {
  const { t } = useI18n();
  return (
    <span className={`rollup-status ${status}`}>
      {status === "provisional" ? t("timeline.inProgress") : t("timeline.finalized")}
    </span>
  );
}

export function TimelineRollupView({
  kind,
  rollups,
}: {
  kind: "6h" | "day";
  rollups: TimelineRollup[];
}) {
  const { locale, t } = useI18n();

  if (rollups.length === 0) {
    return (
      <section className="rollup-archive">
        <div className="empty-state">
          <div className="empty-clock" />
          <h2>{kind === "6h" ? t("timeline.noSixHourSummary") : t("timeline.noDailyOverview")}</h2>
        </div>
      </section>
    );
  }

  if (kind === "day") {
    const daily = rollups[0];
    return (
      <section className="rollup-archive">
        <article className="daily-rollup">
          <div className="rollup-heading">
            <span className="section-kicker">{t("timeline.dailyOverview")}</span>
            <RollupStatus status={daily.status} />
          </div>
          <h2>{daily.title}</h2>
          <p>{daily.description}</p>
          <ContinuationHint item={daily.continuationHint} />
        </article>
      </section>
    );
  }

  return (
    <section className="rollup-archive">
      <section className="rollup-periods">
        <header>
          <div>
            <span className="section-kicker">{t("timeline.byTime")}</span>
            <h2>{t("timeline.sixHourSummary")}</h2>
          </div>
          <span>{t("timeline.periodCount", { count: rollups.length })}</span>
        </header>
        <div>
          {rollups.map((rollup) => (
            <article className="rollup-period" key={rollup.id}>
              <time>{rollupRangeLabel(rollup, locale)}</time>
              <div>
                <div className="rollup-title-row">
                  <h3>{rollup.title}</h3>
                  <RollupStatus status={rollup.status} />
                </div>
                <p>{rollup.description}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

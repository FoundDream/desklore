import type { TimelineRollup } from "../../../../../shared/contracts/index.js";
import {
  ApplicationList,
  ContinuationHint,
  timeLabel,
} from "../../components/HistoryComponents.js";
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

function RollupSourceFooter({
  rollup,
  onOpenDocuments,
}: {
  rollup: TimelineRollup;
  onOpenDocuments: (rollup: TimelineRollup) => void;
}) {
  const { t } = useI18n();
  if (rollup.sourceDocumentIDs.length === 0 && rollup.applications.length === 0) return null;
  return (
    <footer className="rollup-source">
      <ApplicationList applications={rollup.applications} />
      {rollup.sourceDocumentIDs.length > 0 && (
        <div className="rollup-source-meta">
          <span>{t("timeline.basedOnActivities", { count: rollup.sourceDocumentIDs.length })}</span>
          <button onClick={() => onOpenDocuments(rollup)}>{t("timeline.viewDetails")}</button>
        </div>
      )}
    </footer>
  );
}

export function TimelineRollupView({
  kind,
  rollups,
  onOpenDocuments,
}: {
  kind: "6h" | "day";
  rollups: TimelineRollup[];
  onOpenDocuments: (rollup: TimelineRollup) => void;
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
          <RollupSourceFooter rollup={daily} onOpenDocuments={onOpenDocuments} />
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
            <details className="rollup-period" key={rollup.id}>
              <summary>
                <time>{rollupRangeLabel(rollup, locale)}</time>
                <div>
                  <div className="rollup-title-row">
                    <h3>{rollup.title}</h3>
                    <RollupStatus status={rollup.status} />
                  </div>
                  <p>{rollup.description}</p>
                </div>
                <span>{t("common.details")}</span>
              </summary>
              <div className="rollup-period-details">
                <ContinuationHint item={rollup.continuationHint} />
                <RollupSourceFooter rollup={rollup} onOpenDocuments={onOpenDocuments} />
              </div>
            </details>
          ))}
        </div>
      </section>
    </section>
  );
}

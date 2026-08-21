import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AgentSnapshot,
  DesktopSnapshot,
  HistorySearchResponse,
  MemoryRollup,
  TimelineApplication,
  TimelineDocument,
} from "../../shared/contracts.js";

type View = "timeline" | "memory" | "health" | "settings";

const summaryFailureLabels: Record<string, string> = {
  api_key_missing: "未配置 API Key",
  invalid_json: "模型返回的不是合法 JSON",
  invalid_fields: "模型返回字段不完整",
  invalid_evidence_ids: "模型引用了无效事件",
  empty_fields: "模型返回了空标题或描述",
  content_too_long: "模型返回内容过长",
  missing_output: "模型没有返回摘要文本",
  incomplete_max_output_tokens: "模型输出达到长度上限",
  incomplete_content_filter: "模型输出被内容过滤中断",
  incomplete_unknown: "模型输出未完成",
  model_refusal: "模型拒绝生成摘要",
  response_failed: "模型响应执行失败",
  network_timeout: "模型请求超时",
  network_dns_failed: "模型服务域名无法解析",
  network_cannot_connect: "无法连接模型服务",
  network_request_failed: "模型网络请求失败",
  unexpected_error: "摘要生成出现未知错误",
};

function summaryFailureLabel(reason: string): string {
  if (reason.startsWith("http_status_")) {
    return `模型服务返回 HTTP ${reason.slice("http_status_".length)}`;
  }
  if (reason.startsWith("quality_gate_failed:")) return "旧版摘要校验未通过";
  return summaryFailureLabels[reason] ?? "摘要生成失败";
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
  if (!item) return null;
  return (
    <aside className="continuation-hints">
      <span>接续线索</span>
      <p>{item}</p>
    </aside>
  );
}

function Icon({ name }: { name: "timeline" | "memory" | "health" | "settings" | "folder" }) {
  const paths = {
    timeline: (
      <>
        <circle cx="6" cy="5" r="1.5" />
        <circle cx="6" cy="12" r="1.5" />
        <path d="M9.5 5H18M9.5 12H18M6 6.5v4" />
      </>
    ),
    memory: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z" />
        <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5a2.5 2.5 0 0 1 2.5 2z" />
      </>
    ),
    health: (
      <>
        <path d="M3 12h3l2-6 3.5 12 2.2-6H21" />
        <path d="M4 4h16v16H4z" opacity=".2" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" />
      </>
    ),
    folder: (
      <>
        <path d="M3 7h7l2-2h9v14H3z" />
        <path d="M3 9h18" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
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

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const prefix =
    date.toDateString() === today.toDateString()
      ? "今天"
      : date.toDateString() === yesterday.toDateString()
        ? "昨天"
        : new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(date);
  return `${prefix} · ${new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
  }).format(date)}`;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function durationLabel(document: TimelineDocument): string {
  const minutes = Math.max(
    1,
    Math.round((Date.parse(document.endedAt) - Date.parse(document.startedAt)) / 60_000),
  );
  return `${minutes} 分钟`;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

function ConnectionNotice({ desktop }: { desktop?: DesktopSnapshot }) {
  if (!desktop || desktop.connectionState === "connected") return null;
  const labels = {
    starting: "正在启动本地采集器…",
    stopped: "本地采集器已停止",
    missing: "找不到本地采集器，请先运行 native:build",
    failed: "本地采集器异常退出",
  } as const;
  return (
    <div className="connection-notice">
      <span className={`signal ${desktop.connectionState}`} />
      <div>
        <strong>{labels[desktop.connectionState]}</strong>
        {desktop.connectionError && <small>{desktop.connectionError}</small>}
      </div>
      {desktop.connectionState !== "starting" && (
        <button onClick={() => void window.computerHistory.startAgent()}>重新启动</button>
      )}
    </div>
  );
}

function Sidebar({
  view,
  agent,
  onView,
  onToggleRecording,
}: {
  view: View;
  agent?: AgentSnapshot;
  onView: (view: View) => void;
  onToggleRecording: () => void;
}) {
  const running = agent?.recorderState === "running";
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <i />
        </span>
        <div>
          <strong>Computer</strong>
          <strong>History</strong>
        </div>
      </div>
      <nav>
        <button className={view === "timeline" ? "active" : ""} onClick={() => onView("timeline")}>
          <Icon name="timeline" />
          <span>时间线</span>
          <b>{agent?.documents.length ?? "—"}</b>
        </button>
        <button className={view === "memory" ? "active" : ""} onClick={() => onView("memory")}>
          <Icon name="memory" />
          <span>记忆</span>
          <b>{agent ? agent.memories.filter((memory) => memory.kind === "day").length : "—"}</b>
        </button>
        <button className={view === "health" ? "active" : ""} onClick={() => onView("health")}>
          <Icon name="health" />
          <span>采集健康</span>
          <i className={agent?.health.accessibilityGranted ? "ok" : "warn"} />
        </button>
        <button className={view === "settings" ? "active" : ""} onClick={() => onView("settings")}>
          <Icon name="settings" />
          <span>设置</span>
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
            <strong>{running ? "正在记录" : "记录已暂停"}</strong>
          </div>
        </button>
      </div>
    </aside>
  );
}

function TimelineCard({
  document,
  isLast,
  referenced,
  onAction,
}: {
  document: TimelineDocument;
  isLast: boolean;
  referenced: boolean;
  onAction: (action: "open" | "delete", id: string) => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <article className={`timeline-entry ${referenced ? "referenced" : ""}`}>
      <time>{timeLabel(document.startedAt)}</time>
      <div className={`timeline-rail ${isLast ? "last" : ""}`} />
      <div className="entry-body">
        <div className="entry-title">
          <h3>{document.title}</h3>
        </div>
        <p>{document.description}</p>
        {document.generatorFailureReason && (
          <div className="summary-error" role="status">
            <strong>摘要失败</strong>
            <span>
              {summaryFailureLabel(document.generatorFailureReason)}（
              {document.generatorFailureReason}），稍后自动重试
            </span>
          </div>
        )}
        <footer>
          <ApplicationList
            applications={document.applications}
            trailing={<span className="duration">{durationLabel(document)}</span>}
          />
          <div className="entry-actions">
            <button onClick={() => void onAction("open", document.id)}>打开原文</button>
            <button
              className={confirmDelete ? "confirm" : ""}
              onBlur={() => setConfirmDelete(false)}
              onClick={() => {
                if (confirmDelete) void onAction("delete", document.id);
                else setConfirmDelete(true);
              }}
            >
              {confirmDelete ? "确认删除" : "删除"}
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
  const selectedIndex = Math.max(
    0,
    days.findIndex((day) => day.date === selectedDate),
  );
  const selectedDay = days[selectedIndex];
  const olderDay = days[selectedIndex + 1];
  const newerDay = days[selectedIndex - 1];

  return (
    <div className="day-switcher" role="group" aria-label="切换时间线日期">
      <button
        type="button"
        disabled={!olderDay}
        onClick={() => olderDay && onSelect(olderDay.date)}
        aria-label="查看更早日期"
        title="查看更早日期"
      >
        <Chevron direction="left" />
      </button>
      <div className="day-switcher-current">
        <select
          aria-label="选择日期"
          value={selectedDay.date}
          onChange={(event) => onSelect(event.target.value)}
        >
          {days.map((day) => (
            <option key={day.date} value={day.date}>
              {dayLabel(day.startedAt)}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={!newerDay}
        onClick={() => newerDay && onSelect(newerDay.date)}
        aria-label="查看更晚日期"
        title="查看更晚日期"
      >
        <Chevron direction="right" />
      </button>
    </div>
  );
}

function TimelineView({
  agent,
  run,
  selectedDate,
  referencedDocumentIDs,
  onSelectDate,
}: {
  agent?: AgentSnapshot;
  run: (action: () => Promise<DesktopSnapshot>) => Promise<void>;
  selectedDate?: string;
  referencedDocumentIDs: string[];
  onSelectDate: (date?: string) => void;
}) {
  const days = useMemo(() => {
    const groups = new Map<string, TimelineDocument[]>();
    const documents = [...(agent?.documents ?? [])].sort(
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
  }, [agent?.documents]);
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
        eyebrow="活动记录"
        title="时间线"
        action={
          <div className="header-actions">
            <button
              className="secondary"
              onClick={() => void run(() => window.computerHistory.revealStorage())}
            >
              <Icon name="folder" />
              显示文件
            </button>
            {selectedDay && (
              <DaySwitcher days={days} selectedDate={selectedDay.date} onSelect={onSelectDate} />
            )}
          </div>
        }
      />
      <section className="archive">
        {!agent ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>正在连接本地档案</h2>
          </div>
        ) : days.length === 0 ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>还没有时间线</h2>
          </div>
        ) : selectedDay ? (
          <div className="day-group" key={selectedDay.date}>
            {selectedDay.documents.map((document, index) => (
              <TimelineCard
                key={document.id}
                document={document}
                isLast={index === selectedDay.documents.length - 1}
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

function memoryRangeLabel(memory: MemoryRollup): string {
  return `${timeLabel(memory.startedAt)}–${timeLabel(memory.endedAt)}`;
}

function searchKindLabel(kind: "10min" | "6h" | "day"): string {
  if (kind === "day") return "当天概览";
  if (kind === "6h") return "活动摘要";
  return "时间线";
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
  if (memory.sourceDocumentIDs.length === 0 && memory.applications.length === 0) return null;
  return (
    <footer className="memory-source">
      <ApplicationList applications={memory.applications} />
      {memory.sourceDocumentIDs.length > 0 && (
        <div className="memory-source-meta">
          <span>基于 {memory.sourceDocumentIDs.length} 段活动</span>
          <button onClick={() => onOpenTimeline(memory)}>查看时间线</button>
        </div>
      )}
    </footer>
  );
}

function MemoryView({
  agent,
  run,
  onOpenTimeline,
}: {
  agent?: AgentSnapshot;
  run: (action: () => Promise<DesktopSnapshot>) => Promise<void>;
  onOpenTimeline: (memory: MemoryRollup) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<HistorySearchResponse>();
  const [searching, setSearching] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>();
  const days = useMemo(() => {
    const memories = agent?.memories ?? [];
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
  }, [agent?.memories]);
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
        eyebrow="活动上下文"
        title="记忆"
        action={
          <div className="header-actions">
            <button
              className="secondary"
              onClick={() => void run(() => window.computerHistory.revealStorage())}
            >
              <Icon name="folder" />
              显示文件
            </button>
            {selectedDay && (
              <DaySwitcher days={days} selectedDate={selectedDay.date} onSelect={setSelectedDate} />
            )}
          </div>
        }
      />
      <section className="memory-search">
        <div>
          <span className="section-kicker">本地记忆检索</span>
          <h2>询问过去的工作</h2>
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
            placeholder="例如：Computer History 打包最后是什么状态？"
            maxLength={500}
          />
          <button disabled={searching}>{searching ? "检索中" : "检索"}</button>
        </form>
        {search && (
          <div className="memory-answer">
            <p>{visibleSearchAnswer(search.answer)}</p>
            {search.matches.length > 0 && (
              <div>
                {search.matches.slice(0, 5).map((match) => (
                  <span key={`${match.kind}-${match.id}`}>
                    {searchKindLabel(match.kind)} · {match.title}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
      <section className="memory-archive">
        {!agent ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>正在连接本地档案</h2>
          </div>
        ) : days.length === 0 ? (
          <div className="empty-state">
            <div className="empty-clock" />
            <h2>还没有长期记忆</h2>
          </div>
        ) : selectedDay ? (
          <div className="memory-day" key={selectedDay.date}>
            {selectedDay.daily && (
              <article className="daily-memory">
                <span className="section-kicker">当天概览</span>
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
                    <span className="section-kicker">按时间</span>
                    <h2>活动摘要</h2>
                  </div>
                  <span>{selectedDay.periods.length} 段</span>
                </header>
                <div>
                  {selectedDay.periods.map((memory) => (
                    <details className="memory-period" key={memory.id}>
                      <summary>
                        <time>{memoryRangeLabel(memory)}</time>
                        <div>
                          <h3>{memory.title}</h3>
                          <p>{memory.description}</p>
                        </div>
                        <span>详情</span>
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

function HealthView({
  agent,
  run,
}: {
  agent?: AgentSnapshot;
  run: (action: () => Promise<DesktopSnapshot>) => Promise<void>;
}) {
  const health = agent?.health;
  const rows = [
    ["辅助功能权限", health?.accessibilityGranted],
    ["全局交互监听", health?.interactionMonitorActive],
    ["AX 语义监听", health?.axObserverActive],
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow="原生采集器"
        title="采集健康"
        action={
          <button
            className="secondary"
            onClick={() => void run(() => window.computerHistory.refreshPermissions())}
          >
            重新检查
          </button>
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
              <b>{healthy ? "正常" : "未就绪"}</b>
            </div>
          ))}
          {!health?.accessibilityGranted && (
            <button
              className="permission-callout"
              onClick={() => void run(() => window.computerHistory.requestPermissions())}
            >
              <span>需要辅助功能权限</span>
              <strong>打开系统授权提示 →</strong>
            </button>
          )}
        </div>
        <div className="metric-grid">
          <div>
            <span>采集耗时</span>
            <strong>
              {Math.round(health?.lastAXCaptureDurationMilliseconds ?? 0)}
              <small> ms</small>
            </strong>
          </div>
          <div>
            <span>语义事件</span>
            <strong>
              {(health?.keyboardSubmitCount ?? 0) +
                (health?.keyboardShortcutCount ?? 0) +
                (health?.textInputEventCount ?? 0)}
            </strong>
          </div>
          <div>
            <span>采集队列</span>
            <strong>{health?.axCaptureBacklog ?? 0}</strong>
          </div>
          <div>
            <span>原始事件</span>
            <strong>{health?.capturedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>已写入</span>
            <strong>{health?.persistedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>策略拦截</span>
            <strong>{health?.policyBlockedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>重复丢弃</span>
            <strong>{health?.deduplicatedEventCount ?? 0}</strong>
          </div>
          <div>
            <span>合并事件</span>
            <strong>{health?.burstCoalescedEventCount ?? 0}</strong>
          </div>
        </div>
      </section>
    </>
  );
}

function SettingsView({
  agent,
  run,
}: {
  agent?: AgentSnapshot;
  run: (action: () => Promise<DesktopSnapshot>) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(agent?.llm.enabled ?? false);
  const [memorySynthesisEnabled, setMemorySynthesisEnabled] = useState(
    agent?.llm.memorySynthesisEnabled ?? false,
  );
  const [model, setModel] = useState(agent?.llm.model ?? "gpt-5.6-luna");
  const [endpoint, setEndpoint] = useState(
    agent?.llm.endpoint ?? "https://api.openai.com/v1/responses",
  );
  const [apiKey, setAPIKey] = useState("");
  useEffect(() => {
    if (!agent) return;
    setEnabled(agent.llm.enabled);
    setMemorySynthesisEnabled(agent.llm.memorySynthesisEnabled);
    setModel(agent.llm.model);
    setEndpoint(agent.llm.endpoint);
  }, [
    agent?.llm.enabled,
    agent?.llm.memorySynthesisEnabled,
    agent?.llm.model,
    agent?.llm.endpoint,
  ]);
  return (
    <>
      <PageHeader eyebrow="偏好设置" title="设置" />
      <section className="settings-sheet">
        <div className="settings-section">
          <div className="settings-copy">
            <h2>语义摘要</h2>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span />
          </label>
        </div>
        <div className="form-grid">
          <label>
            <span>模型</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
          <label className="wide">
            <span>Responses Endpoint</span>
            <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
          </label>
          <label className="wide">
            <span>API Key {agent?.llm.apiKeyConfigured && <b>已保存在 Keychain</b>}</span>
            <input
              type="password"
              placeholder={agent?.llm.apiKeyConfigured ? "留空以保留现有密钥" : "sk-…"}
              value={apiKey}
              onChange={(event) => setAPIKey(event.target.value)}
            />
          </label>
        </div>
        <div className="settings-actions">
          <button
            className="primary"
            onClick={() =>
              void run(async () => {
                const result = await window.computerHistory.configureLLM({
                  enabled,
                  memorySynthesisEnabled,
                  model,
                  endpoint,
                  apiKey,
                });
                setAPIKey("");
                return result;
              })
            }
          >
            保存模型设置
          </button>
          {agent?.llm.apiKeyConfigured && (
            <button
              className="text-danger"
              onClick={() => void run(() => window.computerHistory.removeLLMAPIKey())}
            >
              移除密钥
            </button>
          )}
        </div>
        <div className="settings-subtoggle">
          <div>
            <strong>模型归纳长期记忆</strong>
            <span>将本地十分钟摘要发送到同一模型 endpoint，生成 6 小时和每日综合记忆。</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={memorySynthesisEnabled}
              onChange={(event) => setMemorySynthesisEnabled(event.target.checked)}
            />
            <span />
          </label>
        </div>
        <div className="privacy-boundary">
          <strong>数据边界</strong>
          <span>
            原始事件、时间线和长期记忆保存在本机。开启语义摘要会发送经过过滤的事件样本；“模型归纳长期记忆”另行发送本地十分钟摘要。两个开关均关闭时，检索与确定性聚合完全离线。
          </span>
        </div>
        <div className="settings-divider" />
        <div className="settings-section observation">
          <div className="settings-copy">
            <h2>当前观察范围</h2>
          </div>
        </div>
        <div className="scope-list">
          <div>
            <span>当前应用</span>
            <strong>{agent?.activeApplication?.name ?? "没有前台应用"}</strong>
            {agent?.activeApplication && (
              <button
                onClick={() =>
                  void run(() =>
                    agent.activeApplicationAllowed
                      ? window.computerHistory.blockActiveApplication()
                      : window.computerHistory.allowActiveApplication(),
                  )
                }
              >
                {agent.activeApplicationAllowed ? "停止观察" : "允许观察"}
              </button>
            )}
          </div>
          <div>
            <span>当前域名</span>
            <strong>{agent?.activeDomain ?? "未检测到浏览器域名"}</strong>
            {agent?.activeDomain && (
              <button
                onClick={() =>
                  void run(() =>
                    agent.activeDomainAllowed
                      ? window.computerHistory.blockActiveDomain()
                      : window.computerHistory.allowActiveDomain(),
                  )
                }
              >
                {agent.activeDomainAllowed ? "停止观察" : "允许观察"}
              </button>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

export function App() {
  const [view, setView] = useState<View>("timeline");
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

  const run = useCallback(async (action: () => Promise<DesktopSnapshot>): Promise<void> => {
    setBusy(true);
    try {
      setDesktop(await action());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleRecording = (): void => {
    if (desktop?.connectionState !== "connected") {
      void run(() => window.computerHistory.startAgent());
    } else if (desktop.agent?.recorderState === "running") {
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
      const documents = desktop?.agent?.documents ?? [];
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
    [desktop?.agent?.documents],
  );

  return (
    <div className={`app-shell ${busy ? "busy" : ""}`}>
      <Sidebar
        view={view}
        agent={desktop?.agent}
        onView={setView}
        onToggleRecording={toggleRecording}
      />
      <main className="content">
        <ConnectionNotice desktop={desktop} />
        {error && (
          <div className="error-banner">
            <strong>操作没有完成</strong>
            <span>{error}</span>
            <button onClick={() => setError(undefined)}>关闭</button>
          </div>
        )}
        {view === "timeline" && (
          <TimelineView
            agent={desktop?.agent}
            run={run}
            selectedDate={selectedTimelineDate}
            referencedDocumentIDs={referencedDocumentIDs}
            onSelectDate={selectTimelineDate}
          />
        )}
        {view === "memory" && (
          <MemoryView agent={desktop?.agent} run={run} onOpenTimeline={openMemoryTimeline} />
        )}
        {view === "health" && <HealthView agent={desktop?.agent} run={run} />}
        {view === "settings" && <SettingsView agent={desktop?.agent} run={run} />}
      </main>
    </div>
  );
}

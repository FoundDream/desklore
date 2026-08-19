import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentSnapshot, DesktopSnapshot, TimelineDocument } from "../../shared/contracts.js";

type View = "timeline" | "health" | "settings";

const activityLabels: Record<string, string> = {
  researching: "研究",
  planning: "规划",
  implementation_started: "实现中",
  implementation_completed: "已实现",
  validated: "已验证",
  blocked: "受阻",
  unknown: "状态未知",
};

function Icon({ name }: { name: "timeline" | "health" | "settings" | "folder" }) {
  const paths = {
    timeline: (
      <>
        <circle cx="6" cy="5" r="1.5" />
        <circle cx="6" cy="12" r="1.5" />
        <path d="M9.5 5H18M9.5 12H18M6 6.5v4" />
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
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="content-header">
      <div>
        <span className="section-kicker">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
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
            <small>{agent?.activeApplication?.name ?? "等待活动"}</small>
          </div>
        </button>
        <p>
          <span>仅存本地</span> 原始活动保留在本机，界面只接收经过脱敏的时间线数据。
        </p>
      </div>
    </aside>
  );
}

function TimelineCard({
  document,
  isLast,
  onAction,
}: {
  document: TimelineDocument;
  isLast: boolean;
  onAction: (action: "open" | "delete", id: string) => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <article className="timeline-entry">
      <time>{timeLabel(document.startedAt)}</time>
      <div className={`timeline-rail ${isLast ? "last" : ""}`}>
        <span />
      </div>
      <div className="entry-body">
        <div className="entry-title">
          <h3>{document.title}</h3>
          {document.activityState && (
            <span className={`activity ${document.activityState}`}>
              {activityLabels[document.activityState] ?? document.activityState}
            </span>
          )}
        </div>
        <p>{document.description}</p>
        <footer>
          <div className="app-list">
            {document.applications.map((application) => (
              <span
                className="app-token"
                title={application.bundleIdentifier}
                key={application.bundleIdentifier}
              >
                <i>{application.name.slice(0, 1).toUpperCase()}</i>
                {application.name}
              </span>
            ))}
            <span className="duration">{durationLabel(document)}</span>
          </div>
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

function TimelineView({
  agent,
  run,
}: {
  agent?: AgentSnapshot;
  run: (action: () => Promise<DesktopSnapshot>) => Promise<void>;
}) {
  const days = useMemo(() => {
    const groups = new Map<string, TimelineDocument[]>();
    for (const document of agent?.documents ?? []) {
      const key = dateKey(document.startedAt);
      groups.set(key, [...(groups.get(key) ?? []), document]);
    }
    return [...groups.values()];
  }, [agent?.documents]);

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
        description="查看按十分钟整理的本地活动片段。内容经过隐私过滤，并以 Markdown 长期保存。"
        action={
          <button
            className="secondary"
            onClick={() => void run(() => window.computerHistory.revealStorage())}
          >
            <Icon name="folder" />
            显示文件
          </button>
        }
      />
      <div className="archive-summary">
        <div>
          <strong>{agent?.documents.length ?? 0}</strong>
          <span>时间线片段</span>
        </div>
        <div>
          <strong>
            {new Set(
              agent?.documents.flatMap((item) =>
                item.applications.map((app) => app.bundleIdentifier),
              ),
            ).size ?? 0}
          </strong>
          <span>出现的应用</span>
        </div>
        <div className="summary-rule" />
        <p>Markdown 是长期记录，原始 JSONL 只作为短期证据保留。</p>
      </div>
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
            <p>首个有活动的完整十分钟分段会出现在这里。</p>
          </div>
        ) : (
          days.map((documents) => (
            <div className="day-group" key={dateKey(documents[0].startedAt)}>
              <h2>{dayLabel(documents[0].startedAt)}</h2>
              {documents.map((document, index) => (
                <TimelineCard
                  key={document.id}
                  document={document}
                  isLast={index === documents.length - 1}
                  onAction={action}
                />
              ))}
            </div>
          ))
        )}
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
    ["辅助功能权限", health?.accessibilityGranted, "读取其他应用的窗口与控件结构"],
    ["全局交互监听", health?.interactionMonitorActive, "识别点击、Return 与组合快捷键"],
    ["AX 语义监听", health?.axObserverActive, "订阅文本与选择变化"],
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow="原生采集器"
        title="采集健康"
        description="Electron 负责展示，下面的数据来自签名后的 Swift Agent。"
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
          {rows.map(([label, healthy, description]) => (
            <div className="health-row" key={label}>
              <span className={healthy ? "health-icon ok" : "health-icon warn"}>
                {healthy ? "✓" : "!"}
              </span>
              <div>
                <strong>{label}</strong>
                <p>{description}</p>
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
            <span>AX 树</span>
            <strong>
              {health?.lastAXSnapshotNodeCount ?? 0}
              <small> / {health?.lastAXVisitedNodeCount ?? 0}</small>
            </strong>
            <p>保存 / 遍历节点</p>
          </div>
          <div>
            <span>采集耗时</span>
            <strong>
              {Math.round(health?.lastAXCaptureDurationMilliseconds ?? 0)}
              <small> ms</small>
            </strong>
            <p>最近一次快照</p>
          </div>
          <div>
            <span>语义事件</span>
            <strong>
              {(health?.keyboardSubmitCount ?? 0) +
                (health?.keyboardShortcutCount ?? 0) +
                (health?.textInputEventCount ?? 0)}
            </strong>
            <p>提交、快捷键与文本</p>
          </div>
          <div>
            <span>采集队列</span>
            <strong>{health?.axCaptureBacklog ?? 0}</strong>
            <p>
              慢采集 {health?.axSlowCaptureCount ?? 0} · 截断 {health?.axTruncatedCaptureCount ?? 0}
            </p>
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
  const [model, setModel] = useState(agent?.llm.model ?? "gpt-5.6-luna");
  const [endpoint, setEndpoint] = useState(
    agent?.llm.endpoint ?? "https://api.openai.com/v1/responses",
  );
  const [apiKey, setAPIKey] = useState("");
  useEffect(() => {
    if (!agent) return;
    setEnabled(agent.llm.enabled);
    setModel(agent.llm.model);
    setEndpoint(agent.llm.endpoint);
  }, [agent?.llm.enabled, agent?.llm.model, agent?.llm.endpoint]);
  return (
    <>
      <PageHeader
        eyebrow="偏好设置"
        title="设置"
        description="配置语义摘要与观察范围。密钥由 Swift Agent 写入 macOS Keychain。"
      />
      <section className="settings-sheet">
        <div className="settings-section">
          <div className="settings-copy">
            <h2>语义摘要</h2>
            <p>对完成的十分钟片段生成标题、描述、活动状态和证据引用；失败时自动使用规则摘要。</p>
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
        <div className="settings-divider" />
        <div className="settings-section observation">
          <div className="settings-copy">
            <h2>当前观察范围</h2>
            <p>默认观察所有普通应用和域名；私密窗口、安全输入与敏感字段始终排除。</p>
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

  useEffect(() => {
    void window.computerHistory
      .getSnapshot()
      .then(setDesktop)
      .catch((cause: unknown) => setError(String(cause)));
    return window.computerHistory.onSnapshot(setDesktop);
  }, []);

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
        {view === "timeline" && <TimelineView agent={desktop?.agent} run={run} />}
        {view === "health" && <HealthView agent={desktop?.agent} run={run} />}
        {view === "settings" && <SettingsView agent={desktop?.agent} run={run} />}
      </main>
    </div>
  );
}

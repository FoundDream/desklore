import type { CredentialStore } from "../../server/ports.js";
import { ServerCore } from "../../server/server-core.js";
import type { AppLocale } from "../../shared/i18n.js";
import type { CollectorClient } from "../../server/collector-client.js";
import type { TimelineAgentSessionFactory } from "../../server/history/timeline-agent-runtime.js";
import type { VisualCaptureProvider } from "../../server/history/visual.js";

class EnvironmentCredentialStore implements CredentialStore {
  async has(): Promise<boolean> {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  async load(): Promise<string | undefined> {
    return process.env.OPENAI_API_KEY;
  }

  async save(_apiKey: string, _locale: AppLocale): Promise<void> {
    throw new Error("Secure credential storage is unavailable");
  }

  async remove(): Promise<void> {}
}

/** @deprecated Use ServerCore with explicit platform dependencies. */
export class HistoryService extends ServerCore {
  constructor(
    collector: CollectorClient,
    storageRoot: string,
    visualCaptureProvider?: VisualCaptureProvider,
    timelineAgentSessionFactory?: TimelineAgentSessionFactory,
  ) {
    super(
      { storageRoot },
      {
        collector,
        credentials: new EnvironmentCredentialStore(),
        visualCapture: visualCaptureProvider,
        timelineAgentSessions: timelineAgentSessionFactory,
      },
    );
  }
}

export { ServerCore, type ServerCoreLifecycleState } from "../../server/server-core.js";

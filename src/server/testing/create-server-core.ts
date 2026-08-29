import type { AppLocale } from "../../shared/i18n/index.js";
import type { CollectorPort, CredentialStore } from "../core/ports.js";
import { ServerCore } from "../core/server-core.js";
import type { TimelineAgentSessionFactory } from "../history/timeline/agent/runtime.js";
import type { VisualCaptureProvider } from "../history/visual/service.js";

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

export function createTestServerCore(
  collector: CollectorPort,
  storageRoot: string,
  visualCapture?: VisualCaptureProvider,
  timelineAgentSessions?: TimelineAgentSessionFactory,
): ServerCore {
  return new ServerCore(
    { storageRoot },
    {
      collector,
      credentials: new EnvironmentCredentialStore(),
      visualCapture,
      timelineAgentSessions,
    },
  );
}

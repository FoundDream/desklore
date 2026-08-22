import type { AgentClient } from "../agent-client.js";
import type {
  VisualCaptureIntent,
  VisualCapturePayload,
  VisualCaptureProvider,
  VisualCaptureProviderStatus,
} from "./visual.js";

export class NativeAgentVisualCaptureProvider implements VisualCaptureProvider {
  readonly id = "macos-screencapturekit";

  constructor(private readonly collector: AgentClient) {}

  status(): VisualCaptureProviderStatus {
    const agent = this.collector.current().agent;
    if (!agent) return "unhealthy";
    return agent.health.screenCaptureGranted ? "ready" : "permission_required";
  }

  async requestPermission(): Promise<void> {
    await this.collector.request("requestScreenCapturePermission");
  }

  async capture(intent: VisualCaptureIntent): Promise<VisualCapturePayload> {
    const payload = await this.collector.requestPayload<VisualCapturePayload>(
      "captureVisualEvidence",
      { visualRequest: intent },
    );
    return (
      payload ?? {
        status: "failed",
        reason: "provider_empty_response",
        provider: this.id,
      }
    );
  }
}

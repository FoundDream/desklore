import type { CollectorClient } from "../collector-client.js";
import type {
  VisualCaptureIntent,
  VisualCapturePayload,
  VisualCaptureProvider,
  VisualCaptureProviderStatus,
} from "../../server/history/visual.js";

export class CollectorVisualCaptureProvider implements VisualCaptureProvider {
  readonly id = "macos-screencapturekit";

  constructor(private readonly collector: CollectorClient) {}

  status(): VisualCaptureProviderStatus {
    const snapshot = this.collector.current().snapshot;
    if (!snapshot) return "unhealthy";
    return snapshot.health.screenCaptureGranted ? "ready" : "permission_required";
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

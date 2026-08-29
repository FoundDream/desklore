import type {
  LLMConfigurationInput,
  ObservationPolicy,
  VisualConfigurationInput,
} from "../../shared/contracts/index.js";
import type { AppLocale } from "../../shared/i18n/index.js";
import type { NativePermissionCommand } from "../api/messages.js";
import type { ServerCore } from "../core/server-core.js";
import type { ServerCoreRequestMessage } from "../api/messages.js";

export async function dispatchServerCoreRequest(
  core: ServerCore,
  request: ServerCoreRequestMessage,
): Promise<unknown> {
  const [first] = request.parameters;
  switch (request.method) {
    case "start":
      return core.start();
    case "grantRecordingConsent":
      return core.grantRecordingConsent();
    case "shutdown":
      return core.shutdown();
    case "pause":
      return core.pause();
    case "resume":
      return core.resume();
    case "requestNative":
      return core.requestNative(first as NativePermissionCommand);
    case "setActiveApplicationAllowed":
      return core.setActiveApplicationAllowed(first as boolean);
    case "setActiveDomainAllowed":
      return core.setActiveDomainAllowed(first as boolean);
    case "updateObservationPolicy":
      return core.updateObservationPolicy(first as ObservationPolicy);
    case "setLocale":
      return core.setLocale(first as AppLocale);
    case "configureLLM":
      return core.configureLLM(first as LLMConfigurationInput);
    case "setLLMEnabled":
      return core.setLLMEnabled(first as boolean);
    case "setMemorySynthesisEnabled":
      return core.setMemorySynthesisEnabled(first as boolean);
    case "configureVisual":
      return core.configureVisual(first as VisualConfigurationInput);
    case "requestScreenCapturePermission":
      return core.requestScreenCapturePermission();
    case "removeLLMAPIKey":
      return core.removeLLMAPIKey();
    case "documentPath":
      return core.documentPath(first as string);
    case "deleteDocument":
      return core.deleteDocument(first as string);
    case "clearHistory":
      return core.clearHistory();
    case "restoreHistory":
      return core.restoreHistory(first as string);
    case "storagePath":
      return core.storagePath();
    case "searchMemory":
      return core.searchMemory(first as string);
  }
}

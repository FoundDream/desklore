import type { ModelProtocol } from "../../shared/model.js";
import type { TimelineLLMSettings } from "./types.js";

export interface ModelRuntime {
  settings: TimelineLLMSettings;
  apiKey: string;
}

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" };

export interface ModelMessage {
  role: "system" | "user";
  content: string | ModelContentPart[];
}

export interface StructuredModelRequest {
  messages: ModelMessage[];
  maxOutputTokens: number;
  schemaName: string;
  schema: Record<string, unknown>;
  timeoutMilliseconds: number;
}

export class ModelRequestError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
  ) {
    super(reason);
  }
}

interface ResponsesPayload {
  status?: string;
  incomplete_details?: { reason?: string };
  error?: { code?: string; message?: string };
  output?: Array<{
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
}

interface ChatCompletionsPayload {
  error?: { code?: string; message?: string };
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      refusal?: string | null;
    };
  }>;
}

function normalizedReason(value: string | undefined, fallback: string): string {
  return value?.replace(/[^a-z0-9_]+/gi, "_").replace(/^_+|_+$/g, "") || fallback;
}

function responsesMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) =>
            part.type === "text"
              ? { type: "input_text", text: part.text }
              : { type: "input_image", image_url: part.url, detail: part.detail ?? "auto" },
          ),
  }));
}

function chatCompletionsMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : {
                  type: "image_url",
                  image_url: { url: part.url, detail: part.detail ?? "auto" },
                },
          ),
  }));
}

function requestBody(
  protocol: ModelProtocol,
  model: string,
  request: StructuredModelRequest,
): Record<string, unknown> {
  const format = {
    type: "json_schema",
    name: request.schemaName,
    strict: true,
    schema: request.schema,
  };
  if (protocol === "chat_completions") {
    return {
      model,
      store: false,
      max_completion_tokens: request.maxOutputTokens,
      messages: chatCompletionsMessages(request.messages),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: request.schema,
        },
      },
    };
  }
  return {
    model,
    store: false,
    max_output_tokens: request.maxOutputTokens,
    input: responsesMessages(request.messages),
    text: { format },
  };
}

function responsesOutputText(payload: ResponsesPayload): string {
  if (payload.status === "incomplete") {
    throw new ModelRequestError(
      `incomplete_${normalizedReason(payload.incomplete_details?.reason, "unknown")}`,
      true,
    );
  }
  if (payload.status === "failed" || payload.error) {
    throw new ModelRequestError("response_failed", true);
  }
  const content = payload.output?.flatMap((item) => item.content ?? []) ?? [];
  if (content.some((item) => item.type === "refusal" || item.refusal)) {
    throw new ModelRequestError("model_refusal", false);
  }
  const text = content.find((item) => item.type === "output_text")?.text;
  if (!text) throw new ModelRequestError("missing_output", true);
  return text;
}

function chatCompletionsOutputText(payload: ChatCompletionsPayload): string {
  if (payload.error) throw new ModelRequestError("response_failed", true);
  const choice = payload.choices?.[0];
  if (!choice) throw new ModelRequestError("missing_output", true);
  if (choice.finish_reason === "length") {
    throw new ModelRequestError("incomplete_max_output_tokens", true);
  }
  if (choice.finish_reason === "content_filter" || choice.message?.refusal) {
    throw new ModelRequestError("model_refusal", false);
  }
  const content = choice.message?.content;
  const text =
    typeof content === "string"
      ? content
      : content
          ?.filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");
  if (!text) throw new ModelRequestError("missing_output", true);
  return text;
}

export async function generateStructuredText(
  runtime: ModelRuntime,
  request: StructuredModelRequest,
): Promise<string> {
  const response = await fetch(runtime.settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtime.apiKey}`,
    },
    body: JSON.stringify(requestBody(runtime.settings.protocol, runtime.settings.model, request)),
    signal: AbortSignal.timeout(request.timeoutMilliseconds),
  });
  if (!response.ok) {
    throw new ModelRequestError(
      `http_status_${response.status}`,
      [408, 409, 429].includes(response.status) || response.status >= 500,
    );
  }
  const payload = (await response.json()) as ResponsesPayload | ChatCompletionsPayload;
  return runtime.settings.protocol === "chat_completions"
    ? chatCompletionsOutputText(payload as ChatCompletionsPayload)
    : responsesOutputText(payload as ResponsesPayload);
}

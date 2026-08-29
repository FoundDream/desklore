export const modelProtocols = ["responses", "chat_completions"] as const;

export type ModelProtocol = (typeof modelProtocols)[number];

export const defaultModelEndpoints: Record<ModelProtocol, string> = {
  responses: "https://api.openai.com/v1/responses",
  chat_completions: "https://api.openai.com/v1/chat/completions",
};

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return modelProtocols.includes(value as ModelProtocol);
}

export function validateModelConfiguration(configuration: {
  protocol: ModelProtocol;
  model: string;
  endpoint: string;
}): boolean {
  if (!isModelProtocol(configuration.protocol) || !configuration.model.trim()) return false;
  try {
    const endpoint = new URL(configuration.endpoint);
    if (endpoint.protocol === "https:") return true;
    return (
      endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

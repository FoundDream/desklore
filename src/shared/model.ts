export const modelProtocols = ["responses", "chat_completions"] as const;

export type ModelProtocol = (typeof modelProtocols)[number];

export const defaultModelEndpoints: Record<ModelProtocol, string> = {
  responses: "https://api.openai.com/v1/responses",
  chat_completions: "https://api.openai.com/v1/chat/completions",
};

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return modelProtocols.includes(value as ModelProtocol);
}

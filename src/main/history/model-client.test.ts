import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateStructuredText,
  type ModelRuntime,
  type StructuredModelRequest,
} from "./model-client.js";

const request: StructuredModelRequest = {
  maxOutputTokens: 500,
  timeoutMilliseconds: 5_000,
  schemaName: "test_output",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
  messages: [
    { role: "system", content: "Return a structured result." },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this image." },
        { type: "image", url: "data:image/png;base64,aW1hZ2U=", detail: "low" },
      ],
    },
  ],
};

function runtime(protocol: ModelRuntime["settings"]["protocol"]): ModelRuntime {
  return {
    settings: {
      enabled: true,
      memorySynthesisEnabled: true,
      protocol,
      model: "test-model",
      endpoint:
        protocol === "responses"
          ? "https://example.com/v1/responses"
          : "https://example.com/v1/chat/completions",
    },
    apiKey: "test-key",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("model client protocols", () => {
  it("encodes and parses the Responses protocol", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateStructuredText(runtime("responses"), request)).resolves.toBe(
      '{"ok":true}',
    );

    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://example.com/v1/responses");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "test-model",
      store: false,
      max_output_tokens: 500,
      input: [
        { role: "system", content: "Return a structured result." },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this image." },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aW1hZ2U=",
              detail: "low",
            },
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "test_output", strict: true } },
    });
  });

  it("encodes and parses the Chat Completions protocol", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: '{"ok":true}' },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateStructuredText(runtime("chat_completions"), request)).resolves.toBe(
      '{"ok":true}',
    );

    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://example.com/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "test-model",
      store: false,
      max_completion_tokens: 500,
      messages: [
        { role: "system", content: "Return a structured result." },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this image." },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aW1hZ2U=", detail: "low" },
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "test_output", strict: true },
      },
    });
  });

  it("reports truncated Chat Completions output as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { role: "assistant", content: "{}" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = generateStructuredText(runtime("chat_completions"), request);
    await expect(result).rejects.toMatchObject({
      reason: "incomplete_max_output_tokens",
      retryable: true,
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryEvent } from "./types.js";
import { evaluateAXByRules, judgeAXWithLuna, understandVisualWithLuna } from "./visual.js";

function event(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    timestamp: "2026-08-22T06:00:00.000Z",
    kind: "mouse.click",
    captureReason: "mouse",
    application: { bundleIdentifier: "com.example.app", name: "Example" },
    window: { title: "Example", isPrivateBrowsing: false, runtimeIdentifier: 42 },
    ...overrides,
  };
}

function response(value: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const runtime = {
  settings: {
    enabled: false,
    memorySynthesisEnabled: false,
    model: "gpt-5.6-luna",
    endpoint: "https://api.openai.com/v1/responses",
  },
  apiKey: "test-key",
};

afterEach(() => vi.unstubAllGlobals());

describe("visual evidence planning", () => {
  it("uses rules only for clear AX outcomes", () => {
    expect(evaluateAXByRules(event()).decision).toBe("needs_visual");
    expect(
      evaluateAXByRules(
        event({
          target: { role: "AXTextArea", value: "Draft" },
          accessibility: {
            mode: "fullTree",
            text: 'AXTree v2 nodes=2\ne1 AXWindow\n  e2 AXTextArea value="Draft"',
          },
        }),
      ).decision,
    ).toBe("uncertain");
    expect(
      evaluateAXByRules(
        event({
          accessibility: {
            mode: "diffFromPrevious",
            text: 'AXTreeDiff v2 updated=1\ne2 AXStaticText title="Sent"',
          },
        }),
      ).decision,
    ).toBe("enough");
    expect(
      evaluateAXByRules(
        event({
          accessibility: {
            mode: "fullTree",
            text: 'AXTree v2 nodes=2\ne1 AXWindow title="Example"\n  e2 AXButton title="Close"',
          },
        }),
      ).reasons,
    ).toContain("window_chrome_only");
  });

  it("asks Luna only for partial AX evidence and keeps structured reasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          decision: "needs_visual",
          confidence: 0.91,
          reasons: ["chat_rows_missing"],
          missing_evidence: ["visible_messages"],
        }),
      ),
    );
    const result = await judgeAXWithLuna(
      event({
        accessibility: {
          mode: "fullTree",
          text: 'AXTree v2 nodes=2\ne1 AXWindow\n  e2 AXStaticText title="Partial"',
        },
      }),
      runtime,
    );
    expect(result).toMatchObject({
      decision: "needs_visual",
      source: "luna",
      confidence: 0.91,
      reasons: ["chat_rows_missing"],
      missingEvidence: ["visible_messages"],
    });
  });

  it("uses a privacy-processed data image for optional Luna visual understanding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({ understanding: "A confirmation dialog is visible.", confidence: 0.88 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await understandVisualWithLuna(
      event(),
      {
        status: "captured",
        provider: "test",
        imageBase64: "aW1hZ2U=",
        ocrText: "Confirm",
      },
      runtime,
    );
    expect(result.confidence).toBe(0.88);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      input: Array<{ content: Array<{ type: string; image_url?: string }> }>;
    };
    expect(body.input[1]?.content[1]).toMatchObject({
      type: "input_image",
      image_url: "data:image/png;base64,aW1hZ2U=",
    });
  });
});

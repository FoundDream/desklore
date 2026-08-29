import { describe, expect, it } from "vitest";
import type { TimelineAgentResult } from "./timeline-agent.js";
import { validWorkerResult } from "./timeline-agent-runtime.js";

const eventID = "00000000-0000-4000-8000-000000000001";

function result(evidenceEventIDs = [eventID]): TimelineAgentResult {
  return {
    title: "Evidence-backed result",
    description: "The worker cited inspected source evidence.",
    claims: [{ text: "A supported claim.", evidenceEventIDs }],
    evidenceEventIDs,
  };
}

describe("Timeline Agent runtime boundary", () => {
  it("accepts only citations that are both inspected and present in the source segment", () => {
    expect(validWorkerResult(result(), [eventID], new Set([eventID]))).toBe(true);
    expect(validWorkerResult(result(), [], new Set([eventID]))).toBe(false);
    expect(validWorkerResult(result(), [eventID], new Set())).toBe(false);
  });

  it("rejects document-level citations that are outside the source segment", () => {
    expect(
      validWorkerResult(
        { ...result(), evidenceEventIDs: [...result().evidenceEventIDs, "outside-source"] },
        [eventID, "outside-source"],
        new Set([eventID]),
      ),
    ).toBe(false);
  });

  it("requires document citations to equal the union of claim citations", () => {
    const secondID = "00000000-0000-4000-8000-000000000002";
    expect(
      validWorkerResult(
        { ...result(), evidenceEventIDs: [eventID, secondID] },
        [eventID, secondID],
        new Set([eventID, secondID]),
      ),
    ).toBe(false);
  });
});

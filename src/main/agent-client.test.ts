import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient, agentExecutableCandidates } from "./agent-client.js";

const originalAgentPath = process.env.COMPUTER_HISTORY_AGENT_PATH;

afterEach(() => {
  if (originalAgentPath === undefined) {
    delete process.env.COMPUTER_HISTORY_AGENT_PATH;
  } else {
    process.env.COMPUTER_HISTORY_AGENT_PATH = originalAgentPath;
  }
});

describe("AgentClient", () => {
  it("reports a missing native agent without spawning a process", async () => {
    const client = new AgentClient(["/path/that/does/not/exist"]);

    await expect(client.start()).resolves.toMatchObject({
      connectionState: "missing",
      connectionError: "Computer History Agent was not built",
    });
  });

  it("resolves development and packaged agent locations", () => {
    process.env.COMPUTER_HISTORY_AGENT_PATH = "/custom/ComputerHistoryAgent";

    expect(agentExecutableCandidates("/app", "/resources", "/project")).toEqual([
      "/custom/ComputerHistoryAgent",
      path.join(
        "/resources/native",
        "Computer History Agent.app/Contents/MacOS/ComputerHistoryAgent",
      ),
      path.join("/project/dist", "Computer History Agent.app/Contents/MacOS/ComputerHistoryAgent"),
      path.join("/app/dist", "Computer History Agent.app/Contents/MacOS/ComputerHistoryAgent"),
    ]);
  });
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workerPath = path.join(repositoryRoot, "out/main/timeline-agent-worker.js");
const temporaryUserData = mkdtempSync(path.join(os.tmpdir(), "desklore-worker-smoke-"));
const startupTimeoutMilliseconds = 10_000;
const stderrLimit = 4_096;

app.setPath("userData", temporaryUserData);

let child;
let finished = false;
let startupTimer;
let stderr = "";

function cleanup() {
  rmSync(temporaryUserData, { recursive: true, force: true });
}

function finish(code, message) {
  if (finished) return;
  finished = true;
  if (startupTimer) clearTimeout(startupTimer);
  child?.kill();
  const output = stderr.trim();
  if (code === 0) {
    console.log(message);
  } else {
    console.error(output ? `${message}\n${output}` : message);
  }
  app.once("quit", cleanup);
  app.exit(code);
}

app
  .whenReady()
  .then(() => {
    if (!existsSync(workerPath)) {
      finish(1, `Timeline Agent worker build output is missing: ${workerPath}`);
      return;
    }
    child = utilityProcess.fork(workerPath, [], {
      env: Object.fromEntries(
        ["PATH", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]
          .map((name) => [name, process.env[name]])
          .filter((entry) => typeof entry[1] === "string"),
      ),
      stdio: "pipe",
      serviceName: "DeskLore Timeline Agent Smoke Test",
    });
    child.stdout?.resume();
    child.stderr?.on("data", (chunk) => {
      if (stderr.length >= stderrLimit) return;
      stderr += String(chunk).slice(0, stderrLimit - stderr.length);
    });
    child.on("message", (message) => {
      if (message?.type === "ready" && message.protocolVersion === 1) {
        finish(0, "Timeline Agent worker smoke test passed.");
      }
    });
    child.on("error", (error) => {
      finish(1, `Timeline Agent worker emitted ${error.type ?? "an unknown error"}.`);
    });
    child.on("exit", (code) => {
      finish(1, `Timeline Agent worker exited before ready with code ${code}.`);
    });
    startupTimer = setTimeout(() => {
      finish(1, "Timeline Agent worker did not become ready within 10 seconds.");
    }, startupTimeoutMilliseconds);
  })
  .catch((error) => {
    finish(1, error instanceof Error ? error.message : String(error));
  });

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const processPath =
  process.env.DESKLORE_SERVER_CORE_PROCESS_PATH ??
  path.join(repositoryRoot, "out/main/server-core-process.js");
const temporaryUserData = mkdtempSync(path.join(os.tmpdir(), "desklore-server-core-smoke-"));
const historyRoot = path.join(temporaryUserData, "history");
const stateRoot = path.join(historyRoot, "state");

mkdirSync(stateRoot, { recursive: true });
writeFileSync(
  path.join(stateRoot, "recording-consent.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    granted: true,
    grantedAt: "2026-08-30T00:00:00.000Z",
  })}\n`,
);

app.setPath("userData", temporaryUserData);

let child;
let finished = false;
let timer;

function finish(code, message) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  child?.kill();
  if (code === 0) console.log(message);
  else console.error(message);
  app.once("quit", () => rmSync(temporaryUserData, { recursive: true, force: true }));
  app.exit(code);
}

app
  .whenReady()
  .then(() => {
    if (!existsSync(processPath)) {
      finish(1, `ServerCore process build output is missing: ${processPath}`);
      return;
    }
    child = utilityProcess.fork(processPath, [], {
      stdio: "pipe",
      serviceName: "DeskLore ServerCore Smoke Test",
    });
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    child.on("spawn", () => {
      child.postMessage({
        type: "initialize",
        storageRoot: historyRoot,
        collectorExecutableCandidates: [],
      });
    });
    child.on("message", (message) => {
      if (message?.type === "ready") {
        if (message.snapshot?.recordingConsentGranted !== true) {
          finish(1, "ServerCore process became ready before loading recording consent.");
          return;
        }
        child.postMessage({
          type: "request",
          id: "storage-path",
          method: "storagePath",
          parameters: [],
        });
        return;
      }
      if (message?.type === "response" && message.id === "storage-path") {
        if (!message.ok || message.value !== path.join(historyRoot, "timeline")) {
          finish(1, "ServerCore process returned an invalid startup response.");
          return;
        }
        finish(0, "ServerCore process smoke test passed.");
      }
      if (message?.type === "startup-error") finish(1, message.error);
    });
    child.on("error", () => finish(1, "ServerCore process failed to start."));
    child.on("exit", (code) => {
      if (!finished) finish(1, `ServerCore process exited before responding with code ${code}.`);
    });
    timer = setTimeout(() => finish(1, "ServerCore process smoke test timed out."), 10_000);
  })
  .catch((error) => finish(1, error instanceof Error ? error.message : String(error)));

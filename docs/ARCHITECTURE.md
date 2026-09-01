# Architecture

DeskLore is split by runtime and trust boundary first, then by domain. The repository mirrors the
processes that ship in the macOS application instead of mixing Electron, server, and Swift code in
one source tree.

## Runtime topology

```text
React renderer (sandboxed)
  -> window.desklore
  -> preload allowlist
  -> validated Electron IPC
  -> Electron main
       - window, tray, Keychain-backed credentials, file reveal/open
       - ServerCore utility-process client
  -> Electron structured-clone messages
  -> ServerCore utility process
       - policy and event coalescing
       - local storage, timeline, rollups, and usage
       - model and visual-enrichment orchestration
       - Collector adapter
  -> NDJSON over stdio
  -> DeskLore Collector (Swift executable)
       - Accessibility, AXObserver, NSWorkspace, interaction monitoring
       - native privacy filtering and optional ScreenCaptureKit capture
```

Electron main is a host, not the application domain. Long-running capture, persistence, model, and
history work runs in ServerCore so a failure does not take down the renderer or the main event loop.
The utility process is a crash boundary, not an operating-system sandbox: it receives the history
root and the API key in memory because it owns persistence and optional model work.

## Source layout

`src/desktop` contains the three Electron surfaces. `main` owns desktop lifecycle and IPC routing,
`preload` publishes the typed `DeskLoreAPI`, and `renderer` is organized around app composition,
shared components, and product features. Renderer imports stop at `src/shared`.

`src/server` is the application core. `api` defines messages exchanged with Electron main,
`runtime` boots and dispatches the utility process, `core` composes dependencies and lifecycle,
`history` contains domain modules, and `adapters` implements native collector and credential ports.
The core depends on ports; adapters depend inward on those ports.

`src/shared` contains only data and logic safe on both sides of Electron IPC. Values crossing a
process boundary must be structured-cloneable and represented here or in `src/server/api`.
`src/platform` contains runtime primitives that are reusable but intentionally not domain logic.

`native/collector` is a standalone Swift package with an executable target and a pure native-core
library target. It can be built and tested without loading the Electron project. `evaluation`
contains offline measurement code and tests, while `scripts` contains repository lifecycle
entrypoints. Branding inputs are isolated under `resources`.

## Data ownership and flow

The collector emits sanitized semantic events and usage-state transitions. ServerCore applies the
persisted observation policy again, coalesces events, and writes owner-only segment data. Closed
segments receive an immediate deterministic timeline baseline. Optional Timeline Agent work can
upgrade that same document after validating every claim citation against retained evidence. Six-hour
and daily timeline rollups, plus usage summaries, are derived from these local records.

Visual fallback is disabled by default. Its coordinator separately owns AX sufficiency decisions,
capture settling/coalescing, provider backoff, transient image understanding, and health metrics.
Pixels are processed in memory and discarded; persisted visual evidence contains sanitized text or
metadata only.

The Electron main process is the only layer that uses `safeStorage`. It loads the credential before
starting ServerCore and passes it through the process initialization message. ServerCore keeps it in
memory and never includes it in snapshots. Renderer snapshots contain sanitized DTOs only.

## Dependency rules

```text
desktop/renderer -> shared
desktop/preload  -> shared
desktop/main     -> shared + server/api
server/runtime   -> server/core + server/adapters + server/api
server/core      -> server/history + core ports + shared
server/adapters  -> core ports + history contracts
native/collector -> DeskLoreNativeCore + macOS frameworks
```

Avoid reverse dependencies. In particular, server modules do not import Electron, renderer code
does not import server implementation files, and Swift does not know the history storage format.

## Durability and deletion

Raw segments are the evidence source; timeline documents and rollups are derived artifacts. Writes that replace
state or Markdown use atomic owner-only files. Deleting a timeline document cascades to its source
segment and visual evidence, then regenerates affected rollups. Clear/restore archives history as one
unit and coordinates collector pause, outstanding visual work, and agent jobs before mutation.

## Testing strategy

TypeScript tests live beside their modules and use synthetic events. Cross-domain history behavior
is explicitly named as an integration test. Swift tests cover capture normalization and privacy
logic independently. The ServerCore process smoke test verifies the built utility-process entry,
while evaluator tests verify offline measurement tooling without treating benchmarks as product
quality claims.

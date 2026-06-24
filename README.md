# ComfyUI XPU migration demo

Local web demo for semi-automatic ComfyUI workflow migration to Intel XPU.

The demo wraps the existing migration operating system in `../ComfyUI/docs/draft/` and drives it through a backend migration-agent layer based on GitHub Copilot SDK and Copilot CLI.

> **Self-evolution + memory subsystem**: the agent has a two-layer knowledge system (recipes = hard injection, skills = soft injection) and a feedback log that feeds Step 13 improvement. See [docs/self-evolution-status.md](docs/self-evolution-status.md) for what's built and how the modules fit together.

## Development

```bash
npm install
npm run dev:api
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Express API port |
| `DEMO_WORKSPACE_ROOT` | `./workspaces` | Per-task workspaces |
| `DEMO_STATE_ROOT` | `./.demo-state` | Local task/event state |
| `DRAFT_DOC_ROOT` | `../ComfyUI/docs/draft` | Migration prompt/skill docs |
| `COMFYUI_ROOT` | `../ComfyUI` | ComfyUI checkout |
| `MODEL_ROOT` | `/home/intel/hf_models` | Shared model root |
| `COPILOT_CLI_PATH` | auto-discovered | Copilot CLI binary |
| `MIGRATION_AGENT_AUTO_APPROVE` | `1` | SDK permission requests are auto-approved by default; set `0` to require manual permission approval |
| `MIGRATION_AGENT_STEP_TIMEOUT_MS` | SDK default | SDK no-semantic-progress watchdog budget |
| `MIGRATION_AGENT_STEP_MAX_MS` | unset | Optional absolute SDK step runtime cap |
| `MIGRATION_AGENT_SDK_IDLE_TIMEOUT_MS` | derived | Large internal SDK `sendAndWait` idle timeout; keep above no-progress watchdog |
| `COPILOT_SDK_GITHUB_TOKEN` / `COPILOT_SDK_GH_TOKEN` | unset | Explicit opt-in GitHub auth token for controlled/headless SDK runs |
| `ASSET_SOURCE_SEARCH` | enabled outside tests | Enable provider source search for missing assets |
| `ASSET_ACQUISITION_ENABLE_DOWNLOAD` | `0` | Enable controlled backend download sub-jobs |
| `MIGRATION_AGENT_DOWNLOAD_PROFILE` | unset | Set to `demo` to enable demo asset-search/download defaults |
| `ASSET_DOWNLOAD_PROXY` / `MIGRATION_AGENT_DOWNLOAD_PROXY` | unset; demo profile defaults to `http://127.0.0.1:7890` | Runtime download/API proxy; artifacts use placeholders, not the concrete value |
| `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` / `CIVITAI_TOKEN` / `CIVITAI_API_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` | unset | Optional provider tokens, injected at process runtime only |
| `HF_FALLBACK_ENDPOINTS` | `https://hf-mirror.com` | Comma-separated HuggingFace-compatible fallback endpoints |
| `ASSET_SOURCE_INSECURE_TLS` | `0` | Allow curl/API calls through trusted corporate TLS interception |

For local development, prefer the existing Copilot CLI login state (`copilot /login` or the already-authenticated CLI session). The demo intentionally does not auto-read `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`, because a generic GitHub PAT may be rejected by the Copilot SDK endpoint and can accidentally make local auth worse.

Use `COPILOT_SDK_GITHUB_TOKEN` or `COPILOT_SDK_GH_TOKEN` only when the runtime is headless and cannot rely on an interactive Copilot login, such as CI, a service host, or a future deployment container. Keep those values in the process secret store only. Do not put tokens or private credentials in task artifacts.

Azure/BYOM model credentials are separate from GitHub Copilot auth. If a future deployment uses Azure OpenAI or another model provider through the Copilot SDK provider option, use Azure identity/managed identity or provider-specific secret injection for that model path; do not confuse it with GitHub Copilot session auth.

The SDK watchdog is progress-aware: assistant text deltas, tool start/complete events, and file/artifact progress reset the no-progress timer; heartbeat-style usage/hook events do not. This prevents long steps with real output from being marked dead while still detecting hung sessions.

## Asset acquisition downloads

Step 00 is a lightweight local preflight only: it parses the workflow, records declared models/custom nodes, checks configured local model roots, and marks remote/public/custom-node source work as deferred. It must not perform URL, repository, SSH, provider-network search, or download work.

Step 01 owns source acquisition. It records local, SSH remote, HuggingFace, Civitai, GitHub, ModelScope, and Comfy.ICU candidates in `01-acquisition-job.json`. Explicit HuggingFace file URLs from operator context, `model_repo`, or `../huggingface_mode.md` produce exact-file download candidates with a HuggingFace direct URL plus configured fallback endpoints such as `hf-mirror.com`. Civitai API responses also produce executable download candidates when they contain an exact filename match. GitHub and Comfy.ICU are used as custom-node discovery sources.

Download sub-jobs remain gated unless `ASSET_ACQUISITION_ENABLE_DOWNLOAD=1` is set, or `MIGRATION_AGENT_DOWNLOAD_PROFILE=demo` is used for local demo runs. The demo profile enables provider search/downloads, uses `https://hf-mirror.com` with `https://huggingface.co` fallback, keeps ModelScope at `https://www.modelscope.cn`, and defaults the proxy placeholder to `ASSET_DOWNLOAD_PROXY=http://127.0.0.1:7890` unless overridden. When enabled, the backend tries executable candidates in order, honors proxy/token environment placeholders at runtime, verifies expected size and SHA-256 when metadata is available, and only reports `waiting_for_human` after all candidates fail. Concrete tokens and proxy URLs are never written to artifacts.

## Task workspace layout

Every new migration task gets one clean workspace under `DEMO_WORKSPACE_ROOT/{taskId}`. Runtime state is isolated from source code and can be deleted by removing the task:

```text
workspaces/{taskId}/
  source/source-workflow.json
  task-state.json
  artifacts/
  cache/custom_nodes/
  cache/comfyui-user/
  outputs/previews/
  outputs/validation-runs/
  outputs/gui-acceptance/
  logs/sdk-session.jsonl
  package/manifest.json
  package/migration-bundle.zip
```

`package/manifest.json` records the layout and packaging policy. Bundles should include task evidence, reports, migrated workflows, logs, and manifests only; large model files stay in `/home/intel/hf_models` and are referenced by path/digest.

## Agent approval flow

The backend can keep a running Copilot SDK session paused while it waits for a web decision:

1. SDK `ask_user` requests emit a `human_question` event. Permission requests are auto-approved by default for local demo stability; set `MIGRATION_AGENT_AUTO_APPROVE=0` to route permission requests through the web UI.
2. The web UI records a decision through `/api/tasks/:taskId/human-decisions`.
3. The backend approval broker resolves the waiting SDK handler and the same session continues.

For diagnostics, use the UI **Approval probe** button or call:

```bash
curl -X POST http://127.0.0.1:3001/api/tasks/<taskId>/approval-probe \
  -H 'Content-Type: application/json' \
  -d '{"stepId":"00"}'
```

Then answer the generated question from the UI or by posting to `/api/tasks/:taskId/human-decisions`.

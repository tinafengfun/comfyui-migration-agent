# Step-12b dry-run hang — ComfyUI-Manager blocking startup (root cause + fix)

Discovered driving the single-output Mini_Llama_Caption migration to full delivery
(2026-08-23). Step 12b's delivery dry-run stalled ~30 min; the agent eventually
diagnosed "server event loop permanently blocked by ComfyUI-Manager's network calls"
and worked around it by excluding comfyui-manager from the redeploy staging.

## Root cause (verified against the code + live state)

1. **ComfyUI-Manager `network_mode = public`** (the default) makes synchronous CNR
   registry / version network calls on startup. Gate in
   `custom_nodes/comfyui-manager/glob/manager_core.py:810`:
   `if get_config()['network_mode'] != 'public': dont_wait = True` — any non-public mode
   makes the startup CNR fetch non-blocking.
2. **The dry-run container had no proxy env.** The Intel network is proxy-only (direct
   external egress is silently dropped by the firewall). A `docker` container without
   `HTTP_PROXY/HTTPS_PROXY` set has Manager's startup calls hang on slow TCP retries,
   which blocks ComfyUI's single asyncio event loop → the HTTP server accepts
   connections but never responds ("permanent block", container CPU ~0%).
3. **Why only the dry-run hung:** the main migration container is launched by
   `comfyuiLifecycle.buildDockerStartScript`, which passes the proxy passthrough
   (`-e HTTP_PROXY -e HTTPS_PROXY -e NO_PROXY ...`), so Manager's calls resolve via the
   proxy. The Step-12b dry-run launch script was generated from the agent-recorded
   `launch_command` in `05-environment-summary.json`, which had **no proxy** and an
   **empty `env_vars`** — so the dry-run container ran Manager in public mode with no
   proxy → hang.

No env-var override for `network_mode` exists in Manager; the lever is `config.ini`.

## Fix

A migrated / reproduced runtime never needs Manager's network at runtime (custom nodes
are git-cloned out-of-band; Manager's remote fetch is management-only). So the robust,
proxy-independent fix is to run Manager **offline**.

- **Applied live:** set `network_mode = offline` in
  `/nfs_share/comfyui-core/user/__manager/config.ini` (root-owned; via sudo). Every
  container inherits the core's config — the main container by bind-mount, the dry-run +
  the delivered bundle by tar-copy — so one change fixes all paths and travels with
  deliveries.
- **Reproducible:** `scripts/ensure-manager-offline.sh [core]` (registered in
  `scripts/TOOLS.md`) makes it idempotent for fresh `/nfs_share/comfyui-core`
  provisioning or any core that reverts to public.

## Follow-ups (not yet done)

- Wire `ensure-manager-offline.sh` into whatever provisions a fresh shared core (there is
  no single core-provisioning script in this repo today; the core is pre-existing on
  `/nfs_share`). Candidate: call it from the agent deploy path (`deploy-agent-demo.sh`)
  or a core-sync script so a rebuilt core can't regress to `public`.
- Secondary hardening (defense-in-depth): have the Step-12b dry-run launch script carry
  the same proxy passthrough as `comfyuiLifecycle.buildDockerStartScript`, so even a
  public-mode Manager wouldn't hang. Lower priority now that offline is the default.

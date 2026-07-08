# Patch Adaptation Protocol

> **Single source of truth** for how patch-carrying recipes are applied, validated, and adapted across package versions.
>
> Everyone — recipe authors, the migration agent, human reviewers — aligns on this file.
> Path is configurable via `MIGRATION_PROTOCOLS_DIR` (default: `prompts/migration-workflow-v2/protocols/`).

## When this activates

This protocol is injected automatically into Step 05 (environment deployment) when **one or more matched recipes declare a `patchFile`**. No trigger configuration, no nodeType lists — the presence of `patchFile` in any matched recipe is the sole activation condition.

Adding a new patch recipe requires **zero changes** to injection logic. Write the recipe, drop the patch file, done.

## Step 1 — Version check

Before applying any patch, determine the installed version of the target package:

1. Read `01-acquisition-job.json` in the task workspace → find the custom node's `commit` field.
2. Or run `git -C <custom_nodes/<package>> rev-parse HEAD`.
3. Compare against the recipe's `baseVersion`.

| Installed commit vs `baseVersion` | Action |
|---|---|
| **Match** | Layer 1 only (text-level apply). |
| **Differ** | Layer 1 → 2 → 3 (escalating adaptation). |
| **Patch already applied** (validation passes) | Skip application, record success. |

If `baseVersion` is absent from the recipe, assume version drift and start at Layer 1 with a fallback to Layer 2/3 on conflict.

## Step 2 — Three-layer adaptation pipeline

Attempt layers in order. Stop at the first layer that produces a passing `validationCommand`.

### Layer 1 — Text-level (`git apply --3way`)

Fastest. Handles context-line drift (whitespace, nearby edits) via Git's 3-way merge.

```
git -C <package_dir> apply --3way <patchFile>
```

- **Success**: patch applied cleanly → go to validation.
- **Conflict**: fuzz mismatch or rejected hunk → escalate to Layer 2.

### Layer 2 — Structural (ast-grep or manual rewrite)

When Layer 1 fails because the code structure changed (function renamed, parameters reordered, file split). Use the recipe's `patchTarget` to locate the relevant symbol in the current source.

- If `ast-grep` is available: write a structural rule that matches the old pattern and rewrites to the new one.
- Otherwise: manually locate `patchTarget` in the current source, apply the structural change preserving the patch's semantic intent.

**Success**: structural change applied → go to validation.
**Cannot locate target**: escalate to Layer 3.

### Layer 3 — Semantic (LLM adaptation)

When Layers 1 and 2 fail. The agent itself performs semantic adaptation:

1. **Read the patch** to understand its INTENT — what XPU behavior does it add? (e.g., "adds `is_xpu_available()` check to device enumeration", "converts output tensors on XPU to CPU before ComfyUI return".)
2. **Read the current source** at `patchTarget` to see how the code is structured NOW.
3. **Synthesize a new patch** that achieves the same intent against the current code — possibly different line numbers, different function names, different file layout.
4. Apply the synthesized patch → go to validation.

This layer is what makes the system **version-agnostic**: even if upstream refactored everything, the agent can reconstruct the XPU support from intent + current source.

## Step 3 — Validation

After applying (any layer), run the recipe's `validationCommand` from the package root:

```
cd <package_dir> && <validationCommand>
```

- **Exit 0**: patch succeeded. Record the outcome (which layer was needed, validation passed).
- **Non-zero exit**: report the diff between expected and actual behavior. Retry from Layer 2 or 3 with the failure information.

## Step 4 — Fallback

If all three layers fail OR validation fails after all layers:

1. Use the recipe's `workarounds` (e.g., set device to `cpu`, reduce resolution, strip unused model buckets).
2. Mark `xpuSupport` as **degraded** in the step 05 output (e.g., `patched → cpu_offload`).
3. Record the failure for analytics — this feeds back into recipe improvement.

## Authoring guide — adding a new patch recipe

1. **Write the patch** against a known commit of the target package. Save to `patches/<descriptive-name>.patch`.
2. **Fill the recipe fields**:
   - `patchFile`: repo-relative path to the patch (e.g., `patches/seedvr2-xpu-registration.patch`).
   - `patchTarget`: the file(s) and symbol(s) the patch touches, using `path/to/file.py::symbol_name` notation. Comma-separate multiple targets.
   - `validationCommand`: a shell command that exits 0 when XPU works. Run from the package root — no absolute paths.
   - `baseVersion`: `<repo-name>@<commit-sha>` the patch was written against.
3. **The protocol activates automatically.** No trigger config, no code changes, no skill registration. When a workflow matches this recipe at Step 05, the patch adaptation section appears in the prompt.

### Example recipe fields

```json
{
  "patchFile": "patches/seedvr2-xpu-registration.patch",
  "patchTarget": "src/optimization/memory_manager.py::is_xpu_available, get_gpu_backend; src/interfaces/video_upscaler.py::execute",
  "validationCommand": "python -c \"import torch; assert hasattr(torch,'xpu') and torch.xpu.is_available(); from src.optimization.memory_manager import is_xpu_available; assert is_xpu_available(); print('OK')\"",
  "baseVersion": "numz/ComfyUI-SeedVR2_VideoUpscaler@4490bd1"
}
```

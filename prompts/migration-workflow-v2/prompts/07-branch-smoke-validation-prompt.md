**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Branch smoke validation prompt

## Task

Run the smallest faithful branch-level smoke tests before full workflow validation.

## Required context

- validated API prompt
- branch map
- target output nodes
- reduced-resource settings
- running ComfyUI endpoint
- Step 06 branch prompt manifest, including submission output node IDs and generated wrappers

## Copy/paste execution prompt

Use this prompt when asking an implementation agent to run Step 7:

```text
根据 ComfyUI/docs/draft/migration-workflow-v2/prompts/07-branch-smoke-validation-prompt.md
和 ComfyUI/docs/draft/migration-workflow-v2/skills/07-branch-smoke-validation-skill.md，
对 <workflow_slug> 执行 Step 7 branch smoke validation。

输入：
- source workflow: <original_workflow.json>
- validated API prompt: <06-or-06b-prompt.json>
- branch map/topology: <03-workflow-topology.md 或 03-inventory.md>
- ComfyUI endpoint: <http://127.0.0.1:8188>
- branch plan:
  1. <branch_slug>: target outputs <node_ids>, reduced settings <node.input=value>
  2. <branch_slug>: target outputs <node_ids>, reduced settings <node.input=value>

要求：
1. 不修改 source workflow。
2. 不 bypass、删除、替换、断开任何节点。
3. 为每个分支创建独立 branch prompt、notes、request、history、summary、evidence 和报告。
4. 使用 /prompt 和 partial_execution_targets 运行最小 faithful branch smoke。
5. reduced settings 只能降低尺寸、步数、帧数、batch 或输出前缀，且必须逐项记录 old/new/reason。
6. 如果固定 seed，而 sampler 的 seed/noise_seed 输入连接到 `Seed (rgthree)` 等 seed 节点，只能修改 seed 节点的值；不能把输入链接替换成常量从而断开/绕过 seed 节点。
7. 保存并检查实际输出文件；仅有 execution_success 不算通过。
8. 记录 executed nodes 和 cached nodes。
9. 如果后修复依赖后通过主要依赖缓存，必须标记 cache-assisted，并在可行时做 cache-bust 验证。
10. 如果 custom node 在运行时缺少声明的 portable dependency，归类为 environment dependency gap，安装声明依赖后重跑；不要 bypass 节点。
11. 完成后写 <workflow_slug>/07-{branch_slug}-smoke.md，并给出 Step 8 是否可以开始的边界结论。
```

## Constraints

1. Smoke success is not full-size success.
2. Keep branch changes faithful to the original graph.
3. Do not bypass nodes just to make a branch pass.
4. Preserve prompt, history, logs, and generated outputs.
5. If Step 06 generated a wrapper for a terminal non-output branch, submit the wrapper output node and keep the wrapper provenance in the branch notes.
6. Verify output file paths on disk, not only history JSON.
7. Fixed-seed smoke prompts must keep seed nodes in the graph. When a sampler seed input is linked, edit the linked seed node value instead of replacing the link with a literal.

## Steps

1. Select the smallest faithful branch for each important output mode.
2. Use fixed seed and reduced steps/resolution/frame count where allowed.
3. Submit branch prompt and retain history.
4. Confirm intended output files exist and are non-empty.
5. Capture XPU/CPU placement evidence where relevant.
6. Review execution history, not only final status:
   - executed nodes
   - cached nodes
   - failed node and whether upstream critical compute already ran
   - declared custom-node dependency gaps exposed only at runtime
7. If a rerun passes mostly from cache after fixing a late blocker, record it as cache-assisted evidence and, when practical, run one safe cache-bust verification such as changing a seed or output prefix so the critical sampler/downstream path executes again.
8. Check boundary and variant coverage:
   - every advertised output branch
   - single/double/triple-image or first-last/multi-reference modes when present
   - minimum and intended frame-count/resolution tiers
   - any known divisibility or tail-frame assumptions
9. Classify pass, fail, CPU fallback, blocked, environment dependency gap, cache-assisted pass, or untested variant.
10. If `/free` or a server restart turns a previously cache-assisted branch into a cold OOM, preserve both attempts. Treat it as capacity evidence for Step 08/09 instead of hiding the cache boundary or bypassing the failing node.

## Reusable tool

When available, use `tools/step07_branch_smoke.py` to submit Step 06 branch prompts, apply bounded smoke settings, preserve per-branch artifacts, and summarize pass/cache/fail status:

```bash
<ComfyUI root>/.venv-xpu/bin/python \
  ComfyUI/docs/draft/migration-workflow-v2/tools/step07_branch_smoke.py \
  --workspace <workspace> \
  --comfy-root <ComfyUI root> \
  --api-url http://127.0.0.1:<port> \
  --timeout-seconds 1200 \
  --smoke-seed <fixed integer>
```

The tool must keep the graph intact, record every reduced setting, submit only generated branch prompts, retain request/response/history/summary/report artifacts, and check output files are non-empty.

## Output

Create a branch-smoke report with:

- branch name and output node
- branch prompt, notes, request, response, history, summary, evidence, before/after paths
- prompt/history paths
- generated media paths
- runtime logs and placement notes
- executed-node and cached-node evidence
- covered and uncovered branch variants
- reduced-setting assumptions
- dependency fixes made during smoke, if any
- cache-bust verification result, if needed
- pass/fail/blocker classification
- Step 08 context and `completion_decision`

## Hard stops

Stop full-size validation if a critical branch cannot produce a faithful smoke output.

If a branch variant is not tested, do not infer coverage from a neighboring variant. Mark it `untested variant` and ask whether it is in delivery scope.

## Prior-migration lessons

Dasiwa branch smoke proved reachability before expensive runs. It also showed that compatibility aliases must remain labeled smoke-only and cannot prove source-identical fidelity.

Zimage FLUX2/Klein smoke showed two additional branch-smoke rules. First, a downstream node can expose a declared but missing custom-node dependency after expensive upstream compute has already succeeded; classify that as an environment dependency gap, preserve the failed attempt, install only the declared portable dependency, and rerun without bypassing the node. Second, a post-fix rerun may pass from ComfyUI cache; record cached nodes explicitly and use a small cache-bust verification when needed before claiming the branch path passed.

Zimage SeedVR2 smoke showed that Step 7 can complete multiple important branches in sequence while still preserving the original graph. For complex workflows, finish all critical branch families before entering Step 8; do not treat the first passing branch as whole-workflow readiness.

Zimage v2 Step 07 showed that when a full branch suite is run sequentially, later branches can legitimately reuse cached upstream nodes while still executing branch-specific output, SeedVR2, or upscale nodes. Mark these as `cache_assisted_pass`, record executed and cached node IDs, and run with a changed fixed seed when practical to verify that critical sampler/downstream paths can recompute.

Zimage v2 Step 08 repair showed a no-bypass edge inside reduced settings: changing `KSamplerAdvanced.noise_seed` from a linked `Seed (rgthree)` node to a literal fixed seed silently removes that seed node from runtime execution. Reduced branch prompts must preserve linked seed nodes by changing the seed node value. The same repair also showed that clearing ComfyUI cache can expose cold-start XPU capacity issues; preserve failed cold attempts and successful cache-assisted attempts separately.

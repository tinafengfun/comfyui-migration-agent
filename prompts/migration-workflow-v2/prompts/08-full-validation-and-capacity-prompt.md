**CRITICAL RULE FOR HUMAN INTERACTION:** When you need to communicate with the human operator, you MUST use the `ask_user` tool. Do NOT write messages, questions, or follow-ups as plain text — the human operator CANNOT see your plain text output. Every message to the human must go through `ask_user`. This applies to ALL rounds of interaction, not just the first one. Maximum 5 `ask_user` rounds per step; after round 5, apply your best judgment and proceed.

# Full validation and capacity prompt

## Task

Run the full workflow or highest-fidelity reproducible path and **classify the result into exactly one of three outcomes**. Everything else in this step (evidence, mitigations, report) flows from which bucket the run lands in:

- ✅ **full-size success** — outputs produced at source-identical fidelity, runtime peak comfortably inside budget (< 80% of usable VRAM)
- ⚠️ **restricted / tight success** — outputs produced but either (a) at reduced fidelity or via a Step 06 runtime-policy variant (not source-identical), or (b) at peak/budget ratio 80–100% (tight; needs telemetry on every future run)
- 🛑 **capacity hard stop** — runtime OOM **and** static theory both say required memory exceeds budget; no reasonable mitigation left after one bounded pass

If the run produces a real failure that is NOT capacity (e.g. a node import error, a graph bug, a missing asset), do **not** classify it as a capacity hard stop — escalate as an integration/feature gap instead.

## Copy/paste execution prompt

Use this prompt when asking an implementation agent to run Step 8:

```text
根据 ComfyUI/docs/draft/migration-workflow-v2/prompts/08-full-validation-and-capacity-prompt.md
和 ComfyUI/docs/draft/migration-workflow-v2/skills/08-full-validation-and-capacity-skill.md，
对 <workflow_slug> 执行 Step 8 full validation and capacity classification。

输入：
- source workflow: <original_workflow.json>
- validated full prompt: <06-or-06b-prompt.json>（明确标注是否为 runtime-policy variant）
- branch smoke evidence: <07-branch-smoke-aggregate.md>
- ComfyUI endpoint: <从 task-state.json steps["05"].completion_signals.api_url 读取>
- target memory budget: <XPU VRAM - reserve，例如 21.7 GB>
- model memory estimates: <理论权重+激活估算>

要求：
1. 不修改 source workflow。
2. 不 bypass、删除、替换、断开任何节点。
3. 运行 full 或 highest-fidelity prompt；若 06 是 runtime-policy variant，标注边界，不要升级为 source-identical。
4. 实际检查输出文件存在且非空，不能只看 execution_success。
5. 记录 executed/cached/structural-value nodes，区分 cold-start 与 cache-assisted 成功。
6. 若固定 seed，sampler seed 输入若连接到 seed 节点，只能改 seed 节点值，不能把链接替换成常量。
7. 用 `partial_execution_targets` 时不可以静默丢弃节点；reconcile 所有 source nodes。
8. 捕获 failing node、model path、free/required memory、runtime traceback（若失败）。
9. 把 runtime 内存证据和静态理论估算对照，按 decision matrix 归类。
10. 把所有 prior failed attempts（cold-start OOM、cache-assisted、report-only recovery）保存在 08- artifact folder 下，标明每次变化。
11. 产出 `08-full-validation-report.md`，明确给出 result_class（full-size / restricted / tight / capacity hard stop / integration gap / feature gap）和下一步建议。
```

## Decision matrix quick reference

Use usable VRAM after reserves (not the marketing number). Compare runtime peak to budget:

| Runtime peak vs usable budget | Decision |
| --- | --- |
| `< 80%` | Normal success path. Capacity is not the first suspect. |
| `80–100%` | Tight success. Continue, but keep telemetry on every run and propagate the same launch flags into Step 12/delivery. |
| `100–120%` | One bounded mitigation pass IF source/theory suggests a plausible fix (e.g. CPU placement for VAE/preprocess, targeted reserve tweak). Prepare hard-stop evidence in parallel — do not retry generic `lowvram` knobs. |
| `> 120%` | Capacity hard stop once static reasoning agrees. Stop tuning; recommend multi-XPU, reduced-fidelity delivery tier, or larger-VRAM node (see `gpu-nodes.json`). |

Static model-file sums are an **upper-bound warning, not a measurement**. A summed file size that exceeds VRAM triggers telemetry and staged-execution reasoning, not an automatic hard stop (Zimage v2 is the canonical counter-example).

## Required context

- branch-smoke evidence
- full or high-fidelity prompt
- model memory estimates
- runtime memory instrumentation
- target hardware budget

## Constraints

1. Do not call branch smoke a full-size success.
2. Compare runtime memory evidence with theoretical memory reasoning.
3. Do not retry generic low-vram knobs indefinitely.
4. Preserve the highest-fidelity failure case if full success is impossible.
5. Do not classify a run as source-identical if it uses a runtime-policy prompt variant. Report it as runtime-policy success or failure and keep the original source workflow boundary explicit.
6. Do not declare a capacity hard stop from summed model file sizes alone. Model file sums are conservative; compare them with actual staged runtime telemetry before deciding.

## Steps

1. Run the full or highest-fidelity prompt.
2. Capture failing node, model path, input shape, free memory, and required memory.
3. Compare runtime evidence to static weight and activation estimates.
4. Use the matching capacity skill's decision matrix to decide whether mitigation is still justified.
5. Classify the result: full-size success, restricted success, CPU fallback, integration gap, feature gap, or capacity hard stop.
6. If the run succeeds near the budget limit, classify it as tight success, record peak/budget ratio, and require telemetry to stay with future GUI or delivery validation.
7. Preserve user-facing outputs under the workflow artifact folder when possible. If a target emits only temporary preview/comparer files, copy them or record their history metadata immediately before temp cleanup can remove them.
8. Preserve graph links when applying reduced settings. If a sampler seed is linked to a seed node, change the seed node value instead of replacing the link with a literal fixed seed.
9. Reconcile all source nodes against executed, cached, disconnected/reference, sink, and structural value classifications. Primitive value nodes that are present in the prompt but not runtime-scheduled must be explicitly classified, not treated as missing or silently ignored.
10. Keep prior failed or report-recovery attempts under the Step 08 artifact folder, especially cold-start OOM, cache-assisted success, and accounting/report-only failures.

## Output

Create a full-validation report with:

- run settings
- success/failure point
- output files or failed output node
- runtime memory evidence
- theoretical capacity reasoning
- budget ratio and mitigation decision
- final result class and escalation path
- source-workflow boundary: source-identical, runtime-policy variant, GUI/manual validation, or customer-facing validation
- retained output evidence, distinguishing durable output files from temporary preview/comparer files
- all-node accounting, including cached nodes and structural value nodes not scheduled by the runtime
- previous attempt archive paths and what changed between attempts

## Hard stops

Stop tuning and escalate if runtime evidence shows required memory exceeds available budget and theoretical active-weight/activation analysis agrees.

## Prior-migration lessons

Dasiwa full-size branch `54` was a structural capacity problem on a 24 GB-class card, not an ordinary tuning miss, after both runtime and memory math aligned.

Zimage Step 8 showed the inverse case: a static model-file sum can exceed physical VRAM, while staged execution, low-VRAM policy, purge/offload behavior, and block swap keep the actual runtime peak inside budget. Treat this as tight success only when the full/high-fidelity run completes and telemetry proves the peak ratio.

Zimage v2 Step 8 added two tooling rules. First, reduced full-path prompts must not bypass linked seed nodes while fixing seeds. Second, a run can complete successfully but be misclassified as failed if the accounting tool treats structural primitive value nodes as missing runtime work. Step 8 reports must distinguish runtime failure from report/accounting recovery, and must carry cache-assisted versus cold-start boundaries into Step 9.

## Example output shape

```text
Result class: capacity hard stop
Validation level: branch smoke passed; full-size failed
Runtime evidence: failing denoise node requested more memory than usable device budget
Theory evidence: active Wan model path plus activation estimate exceeds single-card budget
Mitigation decision: stop generic lowvram retries; recommend multi-XPU or reduced-fidelity delivery tier
```

```text
Result class: full/high-fidelity runtime-policy success on current XPU target
Validation level: Step 7 branch smoke passed; Step 8 full/high-fidelity API path passed
Runtime evidence: peak runtime memory was 95.4% of physical budget
Theory evidence: summed model files exceeded device memory, but staged execution/offload kept the live peak under budget
Mitigation decision: no capacity hard stop; continue with telemetry and preserve the same launch/runtime policy for GUI or delivery validation
Boundary: source workflow unchanged; runtime-policy prompt variant used; GUI/customer validation not claimed
```

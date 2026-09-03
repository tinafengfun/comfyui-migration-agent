---
name: prd-workflow
description: Author a Product Requirements Document (PRD) for a new capability/feature of the ComfyUI→Intel-XPU migration agent, via a structured workflow — clarify problem → scope → requirements → design (reusing existing seams) → phased plan → risks → acceptance. Use when the user says "write a PRD", "prd-workflow", "spec this feature", or before building a non-trivial capability. Saves the PRD to docs/prd/<slug>.md.
---

# PRD workflow

Turn a feature idea into a reviewable PRD **before** implementation, so scope and
approach are agreed and grounded in what already exists in this repo. This skill
produces a document; it does not write code.

## When to use

- The user asks to "write a PRD / spec / design doc" for a capability.
- Before building a non-trivial, multi-part feature (new migration step, new
  node-handling capability, a subsystem) — pairs naturally with EnterPlanMode.
- To capture a decision the team needs to review (e.g. "API-node → local-model
  substitution", a new capacity policy, a batch-migration runner).

Skip for a one-line fix or a change with an obvious single approach.

## Process

1. **Frame the problem (1–2 sentences).** What is broken / missing today, and the
   concrete trigger (a real workflow, a failed migration, a user need). No solution yet.
2. **Ground it in the codebase.** Before designing, find the existing seams to reuse —
   grep for the relevant subsystem (steps in `src/server/orchestrator.ts`, the recipe
   library `recipes/`, `src/catalog/`, `knownCustomNodes`, `assetSourceProviders`,
   the workflow normalizer, `migrationRoute` vocab). A PRD that reuses seams beats one
   that invents parallel machinery. Cite `file:line`.
3. **Ask only the blocking questions** (AskUserQuestion) — the decisions you cannot
   pick from the code or sensible defaults (scope boundary, quality-vs-effort, human-gate
   policy). Don't ask what you can decide.
4. **Write the PRD** to `docs/prd/<kebab-slug>.md` using the template below.
5. **Confirm.** Summarize the PRD in chat and ask for approval (or use EnterPlanMode to
   turn it into an execution plan). Do not start coding until the PRD is accepted.

## PRD template

```markdown
# PRD: <feature name>

**Status:** draft · **Owner:** <who> · **Date:** <YYYY-MM-DD>

## 1. Problem
What's wrong/missing today + the concrete trigger. Who is affected and how.

## 2. Goal / non-goals
- Goal: the outcome, in one sentence.
- Non-goals: explicitly out of scope (prevents scope creep).

## 3. Users & scenarios
Who runs this, and 1–3 concrete scenarios (a real workflow / migration).

## 4. Requirements
- Functional (numbered, testable): FR1 …, FR2 …
- Non-functional: performance, XPU/offline constraints, human-approval rules,
  backward-compat (flag-gated? default off?).

## 5. Design (reuse first)
The approach, anchored to existing seams (cite file:line). What's net-new vs
extended. Data/graph changes. Where the human gate sits. Interaction with the
migration steps (00–13), catalog, recipes, GPU nodes.

## 6. Phased plan
Phase 0 (MVP / de-risk) → … each phase independently shippable + verifiable,
previous behavior available via flag/fallback.

## 7. Risks & mitigations
The 2–5 real risks (esp. correctness / behavior-drift / capacity) + mitigation.

## 8. Acceptance & verification
- Unit tests (which pure seams).
- Live proof (which workflow on which GPU node; what must be true).
- For behavior-changing features: how quality/regression is judged.

## 9. Open questions
Anything still unresolved for the reviewer.
```

## House rules (this repo)

- **Reuse over rebuild** — the catalog is the Registry, recipes are deterministic
  injection, the normalizer handles graph surgery, `migrationRoute` is the triage
  vocab. Extend these; name the file:line.
- **Behavior-changing substitutions need a human gate** — replacing a cloud/API node
  with a local model, or substituting a model, drifts the result; require explicit
  approval and mark the delivery boundary (agent.md substitution rule).
- **Flag-gate risky changes** default-off; keep the old path as fallback until proven
  live on a GPU node.
- **XPU/offline first** — the target has no cloud APIs; prefer local inference
  (e.g. `ComfyUI-llama-cpp_vlm` on XPU) over any cloud call.
- Keep the PRD scannable: bullets over prose, one line per requirement.

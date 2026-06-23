# Agent Self-Evolution & Memory Architecture — 设计文档

> Status: DRAFT — design baseline, not yet implemented.
> Created: 2026-06-23
> Owners: tinafengfun + agent-evolution track

## 目录

1. [背景与动机](#1-背景与动机)
2. [设计原则](#2-设计原则)
3. [记忆架构（最优先）](#3-记忆架构最优先)
4. [目录布局](#4-目录布局)
5. [自进化机制（建在记忆架构之上）](#5-自进化机制建在记忆架构之上)
6. [版本化与回滚](#6-版本化与回滚)
7. [SQLite 分析层](#7-sqlite-分析层)
8. [实施优先级](#8-实施优先级)
9. [非范围](#9-非范围)

---

## 1. 背景与动机

第一个工作流（Qwen-Image-2512 FP8）的端到端测试暴露了**两类性质完全不同的问题**：

| 类别 | 例子 | 处理路径 |
|---|---|---|
| **A. Agent 自身实现问题** | ComfyUI task 跑完不清理、context 爆掉、状态卡死、prompt 不规范 | 改 agent 代码 / prompt / skill |
| **B. ComfyUI 对 XPU 的支持 bug** | FP8 量化模型加载崩溃、量化格式不支持、节点 kernel 缺失 | 人工介入改 ComfyUI 代码、交付 patch |

两类都需要"反馈→沉淀→复用"的回路，但**进化的对象不同**：
- A 进化的是 agent 自己（prompt / skill / 代码）
- B 进化的是跨任务的"ComfyUI-XPU 知识库"（recipe / patch）

当前 agent 已经有零散的基础设施（`workflowKnowledge.ts`、`evolutionAnalyzer.ts`、Step 13），但**没有闭环**：反馈没收集、规则没评分、recipe 没沉淀、目录混乱、上下文易爆。

本设计的目标：**先铺好记忆与目录的地基，再在其上建自进化能力。**

---

## 2. 设计原则

1. **地基先于智能**：没有清晰的目录、版本、记忆分层之前，所有"进化"都是拍脑袋。
2. **内容与元数据分离**：内容（markdown / JSON / 代码）放文件、git；元数据（计数、统计、检索）放 SQLite。
3. **人类在环**：所有进入 L4（全局永久）的改动必须人工审批；agent 可以提议，不能单方面生效。
4. **可回滚**：每个 skill / recipe / patch 的每次变更必须可单独 revert。
5. **污染归零**：agent 永远不在 ComfyUI 根目录或 migration-agent 根目录写调试垃圾。
6. **渐进加载**：prompt 注入按需触发，避免上下文爆炸。

---

## 3. 记忆架构（最优先）

按"生命周期 × 后端"两个轴划分五层：

| 层 | 生命周期 | 内容 | 后端 | 淘汰策略 |
|---|---|---|---|---|
| **L0** | 单次工具调用 | bash 输出、grep 结果、临时计算 | 工具 I/O（不落盘到记忆目录） | 立即 |
| **L1** | 单 step | 当前 step 的轨迹、中间推理 | SDK session transcript（`logs/sdk-session.jsonl`） | step 完成 |
| **L2** | 单 task（小时-天） | 全部 step artifacts / 决策 / 反馈 / ComfyUI 运行输出 | 文件系统 `workspaces/<taskId>/` | 完成 30 天后 tar.gz 归档 |
| **L3** | 跨 task（永久，版本化） | recipe 库 / 知识规则 / 已交付 patch | 文件系统 + **git**（migration-agent repo 子目录） | 被新版本取代（保留历史） |
| **L4** | 全局（永久，演进） | skills (markdown) / prompts / evaluation baseline / 反馈聚合 | **git**（GitHub）+ SQLite（只 analytics） | 人工审批退役 |

### 3.1 每层契约

**L0（瞬时）**
- 任何 bash 输出超过 1KB 必须 truncate 后再让 LLM 看（已有 `contextRetention.ts` 雏形）。
- 不写入任何"记忆"目录。

**L1（per-step）**
- 落盘到 `workspaces/<taskId>/logs/sdk-session.jsonl`（已有）。
- step 完成后写一个 200-token 摘要到 `artifacts/<stepId>-summary.json`，作为 L2 的入口。
- L1 内容**绝不**直接喂给下一个 step 的 prompt — 必须先经 L2 summary。

**L2（per-task）**
- 完整事实记录，只增不删。
- `task-state.json`、`artifacts/`、`outputs/`、`logs/`、`feedback/`、`escalation/`。
- 任何外部消费（Step 13 分析、SQLite 同步）都从 L2 读，不污染 L1。

**L3（跨 task）**
- 必须有 `provenance` 字段：来源 task、来源 step、证据 artifact、审批人。
- 任何 L3 条目都进 git，commit message 必须写触发来源。
- 写入前必须通过 schema 校验（CI 拦）。

**L4（全局）**
- skills / prompts / recipes 三大类，都进 git。
- 变更必须挂 PR，CI 跑 golden workflow 集。
- 发布用 tag (`skills-v1.2.0`)，生产可 pin。

### 3.2 防上下文爆炸的三层机制

| 层 | 机制 | 触发 |
|---|---|---|
| **结构层** | Skill 渐进式加载 | `skills-registry.json` 按 step + trigger 求值 |
| **摘要层** | 跨 step 上下文摘要 | step N 完成 → 写 200-token summary；step N+1 只读 summary + 路径 |
| **引用层** | 大块数据只放路径 | >5KB artifact 默认不在 prompt inline；>50KB 必须先压缩 |

Skill 总加载量 >30K tokens 触发警告，建议拆 skill。

---

## 4. 目录布局

```
agent-demo/
│
├── workspaces/<taskId>/                    # L2 per-task
│   ├── source/                             # workflow.json
│   ├── artifacts/                          # step outputs
│   │   └── phase1-context/                 # SDK 紧凑上下文
│   ├── outputs/                            # ComfyUI runtime
│   │   ├── previews/
│   │   ├── validation-runs/
│   │   └── gui-acceptance/
│   ├── logs/
│   │   ├── sdk-session.jsonl
│   │   └── comfyui.log                     # 本 task 的 ComfyUI stdout
│   ├── cache/
│   │   ├── custom_nodes/
│   │   └── comfyui-user/
│   ├── feedback/                           # 新：per-step 反馈事件（JSONL）
│   ├── escalation/                         # 新：opencode session 产物
│   │   ├── snapshot.json                   # spawn 时的现场快照
│   │   ├── patch.diff                      # opencode 交付的补丁
│   │   └── validation-report.json
│   ├── package/                            # 交付包
│   └── task-state.json
│
├── .demo-state/                            # L3/L4 跨 task 状态
│   ├── tasks/                              # 新：per-task state（拆分自 state.json）
│   │   └── <taskId>.json
│   ├── knowledge-base/                     # 已有：抽取规则（按 workflow sha）
│   ├── recipe-library/                     # 新：跨 task 复用知识
│   │   ├── nodes/
│   │   │   ├── VAELoader.json
│   │   │   └── CLIPLoader.json
│   │   └── models/
│   │       └── qwen25_vl_fp8.json
│   ├── skills-registry.json                # 新：skill 元数据 + trigger + version
│   ├── feedback-log.jsonl                  # 新：跨 task append-only 反馈流
│   ├── evolution-events.jsonl              # 新：每次进化决策审计
│   └── analytics.db                        # 新：SQLite（见 §7）
│
├── comfyui-patches/                        # 新：已交付 patch + 精度报告
│   ├── 0001-xpu-fp8-fallback-dequantize.patch
│   ├── 0001-xpu-fp8-...precision-report.md
│   └── PATCH-INDEX.md
│
├── debug-archives/                         # 新：调试会话归档
│   └── <taskId>-<stepId>-<timestamp>/
│       ├── repro-script.py
│       ├── stack-trace.log
│       ├── diagnosis.md
│       └── resolution.md
│
├── prompts/                                # L4 git-tracked（已有）
│   └── migration-workflow-v2/
│       ├── skills/                         # 所有 markdown skills
│       └── prompts/                        # 所有 step prompts
│
├── logs/                                   # 新：agent 自身运行日志（不在 workspace）
│   ├── migration-backend.log
│   ├── migration-frontend.log
│   └── deepseek-proxy.log
│
├── tests/                                  # 已有
├── scripts/                                # 已有
└── src/                                    # 已有
```

### 4.1 目录归属规则（agent 硬约束）

| Agent 想写的东西 | 唯一允许路径 | 禁止路径 |
|---|---|---|
| 单步 artifact | `workspaces/<taskId>/artifacts/<stepId>-*` | ComfyUI 根目录 |
| ComfyUI 运行输出 | `workspaces/<taskId>/outputs/<subdir>/` | `ComfyUI/output/` |
| extra-model-paths | `workspaces/<taskId>/artifacts/05-extra-model-paths.yaml` | ComfyUI 根目录 |
| Repro / debug 脚本 | `agent-demo/debug-archives/<taskId>-<stepId>-<ts>/` | ComfyUI 根目录 / `xpu-bug-investigation/` |
| ComfyUI 源码补丁 | `agent-demo/comfyui-patches/` | ComfyUI 根目录 |
| 临时 bash 输出 | `/tmp/migration-agent/<taskId>/<random>/` | 任何 git 仓库根 |

实现：`promptSkillCompiler.ts` 注入硬规则；`scripts/lint-workspace-purity.ts` 三层执行：
- **L1 运行时硬闸**：skill/recipe 加载时 schema 校验，invalid 拒绝加载（`promptSkillCompiler.ts` / `recipeLibrary.ts`）
- **L2 pre-commit hook**：commit 前快速 lint（`scripts/lint-workspace-purity.ts --quick`）
- **L3 cron job**：每日凌晨全量扫描，日志写 `/var/log/migration-purity.log`

### 4.2 现有污染清单（待清理）

ComfyUI 根目录当前残留：

```
p                                              # bash typo
pppppppppppppppppppppppppp                     # 同上
pythonxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx # 同上
lib2.log                                       # 散落日志
server.py.agent-patched                        # patch 备份
hook_breaker_ac10a0.py                         # 可疑 debug 代码
extra_model_paths.yaml                         # agent 写错位置
artifacts/                                     # agent 写错位置
```

`xpu-bug-investigation/`：patches（应保留）+ repro 脚本（应归档）+ vim swap 文件（垃圾）混在一起。

清理动作：见 §8 第 0 步。

---

## 5. 自进化机制（建在记忆架构之上）

记忆架构是地基，自进化是上层建筑。三套独立的进化回路：

### 5.1 反馈闭环（最基础）

```
┌─────────────────────────────────────────────────────────┐
│  每 step: 用户/agent 产生 feedback event                 │
│    ↓                                                     │
│  写入 workspaces/<taskId>/feedback/events.jsonl  (L2)    │
│    ↓                                                     │
│  追加到 .demo-state/feedback-log.jsonl         (L3 流)   │
│    ↓                                                     │
│  Step 13 批量分类:                                       │
│    - type ∈ {agent_bug, comfyui_bug, missing_feature,   │
│    │         user_preference, data_gap}                  │
│    - severity ∈ {blocker, degrade, nit}                  │
│    ↓                                                     │
│  按 type 路由:                                           │
│    - agent_bug        → 进化 skill/prompt/code           │
│    - comfyui_bug      → 写 ticket + escalation 候选      │
│    - missing_feature  → 写 ticket                        │
│    - user_preference  → 写规则                           │
│    - data_gap         → 写资产 acquisition note          │
└─────────────────────────────────────────────────────────┘
```

**双轨触发**：
- **实时反馈**：用户在 step 进行中点 "stop, wrong" → 立即路由（blocker 类）
- **事后反馈**：用户在 step 完成后留言 → 攒到 Step 13 批处理（非 blocker 类）

**feedback event schema**：
```typescript
interface FeedbackEvent {
  id: string;
  taskId: string;
  stepId: string;
  createdAt: string;       // ISO 8601
  source: "human" | "agent_self" | "evaluator";
  type: "agent_bug" | "comfyui_bug" | "missing_feature"
      | "user_preference" | "data_gap";
  severity: "blocker" | "degrade" | "nit";
  message: string;         // 人类可读
  stateSnapshot: {
    workflowSha: string;
    comfyuiSha: string;
    agentCommitSha: string;
    failingArtifactPath?: string;
    stackTracePath?: string;
  };
  proposedAction?: "evolve_prompt" | "evolve_skill" | "fix_code"
                 | "create_ticket" | "record_only";
  status: "open" | "triaged" | "resolved" | "wontfix";
}
```

### 5.2 Skill 进化 + 渐进式加载

**Skill 三层（按加载条件）**：

| 层 | 加载条件 | 例子 |
|---|---|---|
| **core** | 永远加载 | 00-intake、03-inventory 的硬规则 |
| **on-demand** | step + trigger 条件命中才加载 | 02-feasibility 的 FP8 gate（只在检测到 FP8 TE 时） |
| **reference** | 只暴露目录，agent 显式 Read 才进上下文 | 节点兼容性大表、patch 库 |

**Skill frontmatter（必填）**：
```yaml
---
skillId: fp8-xpu-gate
version: 1.2.0
tier: on-demand
trigger:
  stepId: "02"
  condition:
    anyOf:
      - assetPattern: "*_fp8*"
      - assetPattern: "*_scaled.safetensors"
      - assetPattern: "qwen_*_vl_*_fp8*"
provenance:
  taskOrigin: "7f5cf9e4-1d1d-4429-8017-12c33b273f08"
  evidenceArtifact: "02-feasibility.md"
  createdAt: "2026-06-19"
  approvedBy: "tinafengfun"
retireCondition:
  envGte: { comfy_kitchen: "0.3.0" }   # 上游修了 QTensor.clone 就退役
---
```

**Skill 注册表** (`.demo-state/skills-registry.json`)：
```json
{
  "active": {
    "fp8-xpu-gate": { "version": "1.2.0", "commitSha": "abc1234" },
    "workspace-hygiene": { "version": "1.0.0", "commitSha": "def5678" }
  },
  "retired": {
    "old-cuda-fallback": { "version": "0.9.0", "retiredAt": "2026-06-10", "reason": "..." }
  }
}
```

**加载流程**（`promptSkillCompiler.ts` 重构）：
1. 读 `skills-registry.json` 拿 active 列表
2. 每个 skill 读 frontmatter 拿 trigger
3. 按 step 求值 trigger（match stepId + 检查 condition）
4. 命中：拼进 prompt；不命中：跳过
5. 总加载量 >30K tokens → 警告

**Skill 提议→审批流程**：
1. Step 13 或反馈分析认为 "这条 prompt 该变成 skill"
2. agent 生成 skill markdown + frontmatter + trigger
3. 提交到 `prompts/.../skills/` 分支（不直接 commit main）
4. pre-commit hook 跑 schema 校验 + purity lint（L2 闸）
5. 合 main 后 runtime 加载时再校验一次（L1 闸）
6. cron 每日全量校验（L3 闸）
7. 人工 review 决定是否进 `skills-registry.json` active 列表

> **注**：本项目无 CI/CD 环境。CI 三层职责（PR 检查、回归测试、定时审计）由 pre-commit hook + cron job + runtime gate 共同承担。

### 5.3 Recipe 库（跨 task 知识）

Recipe 是"对某个节点 / 某个模型模式，XPU 上需要做什么"。结构化、可检索、跨 task 复用。

**Schema**：
```json
{
  "recipeId": "CLIPLoader-qwen25-vl-fp8",
  "version": "1.0.0",
  "nodeType": "CLIPLoader",
  "modelPattern": "qwen_*_vl_*_fp8*",
  "xpuSupport": "patched",
  "patchClass": "functional_runtime_support",
  "patchFile": "comfyui-patches/0001-xpu-fp8-fallback-dequantize-before-move-to-xpu.patch",
  "knownIssues": [
    "comfy_kitchen QTensor.clone() segfaults on .to('xpu')",
    "fp8 → bf16 dequant doubles memory; VRAM gate required"
  ],
  "validationEvidence": "comfyui-patches/clip_fp8_precision_report.md",
  "validatedOnWorkflows": ["7f5cf9e4-1d1d-4429-8017-12c33b273f08"],
  "provenance": {
    "taskOrigin": "7f5cf9e4-1d1d-4429-8017-12c33b273f08",
    "createdAt": "2026-06-19",
    "approvedBy": "tinafengfun"
  },
  "retireCondition": "comfy_kitchen >= 0.3.0 fixes QTensor.clone segfault"
}
```

**Step 04 source audit 改造**：扫到 nodeType + modelPattern → 自动从 `recipe-library/` 拉对应 recipe 注入 prompt，省去每次重新调研。

**首个样板**：基于上次 FP8 patch 工作灌 `CLIPLoader-qwen25-vl-fp8.json`，作为后续 recipe 的格式参考。

### 5.4 Opencode 升级（处理 comfyui_bug）

**触发**：Step 05/07/08 撞到 comfyui bug、agent 自己分析后判定无法在 prompt/skill 层修。

**架构**：
```
migration-agent (paused at step N)
  ↓ 1. 冻结现场: snapshot {comfyui git SHA, workflow.json, /object_info,
  │     stack trace, model filenames, xpu logs, agent's diagnosis.md}
  ↓ 2. spawn opencode:
  │     opencode --cwd <comfyui-worktree> --context snapshot.json
  ↓ 3. opencode 在隔离 git worktree 工作:
  │     - 复现 → 改代码 → 跑精度测试 → 产 patch.diff + test_report.json
  ↓ 4. opencode 退出, migration-agent 读 patch:
  │     - apply patch → 重跑失败 step 的 branch smoke
  │     - 通过 → resume pipeline
  │     - 不通过 → 升级为 human ticket
  ↓ 5. 沉淀:
       - 成功: recipe-library +1 entry, 下次同问题直接复用
       - 失败: ticket 库 +1 entry, 避免下次重复 escalate
```

**关键约束**：
- Patch 验证是 migration-agent 的责任（不是 opencode 自说自话）
- Opencode 有 budget（token + 时长），超了降级为 ticket
- 失败的 escalation 也要沉淀（known-unfixable 库），防止重复触发
- Worktree 隔离 + 退出后清理

### 5.5 三种进化路径汇总

| 进化对象 | 触发 | 产出 | 审批 |
|---|---|---|---|
| **Prompt 改动** | 反馈类型 `agent_bug` + 单步问题 | 改 `prompts/.../*.md` | 人工 PR review |
| **Skill 新增/演进** | 反复出现的 prompt 模式 / 跨 task 共性 | 新增/改 `prompts/.../skills/*.md` + registry | 人工 PR + golden 回归 |
| **ComfyUI 代码 patch** | 反馈类型 `comfyui_bug` | opencode 产 patch → `comfyui-patches/` + recipe | 人工精度验证 |

---

## 6. 版本化与回滚

**进 git 的东西**（migration-agent repo）：
- `prompts/` 全部
- `comfyui-patches/` 全部
- `.demo-state/recipe-library/` 全部
- `.demo-state/skills-registry.json`
- `docs/` 全部

**不进 git 的**：
- `workspaces/` 太大
- `.demo-state/tasks/<taskId>.json` 运行时状态
- `logs/`
- `node_modules/`、模型、二进制

**版本策略**：
- 每个 skill 文件 frontmatter 写 `version: semver`
- 重大变更用 tag：`skills-v1.0`、`skills-v2.0`，生产可 pin tag
- 回滚 = `git revert <commit>` + 更新 `skills-registry.json` active version

**规则 efficacy 反馈**（让规则有生死）：
- 每条 learned rule 有 `injectedCount` / `helpedCount` / `hurtCount` / `lastUsedAt`
- 注入后任务成功 → helpedCount++
- 注入后任务失败 / 用户回退 → hurtCount++
- `hurtCount > helpedCount` → 自动归档为 retired（保留历史，不再注入）

---

## 7. SQLite 分析层

**只存 analytics，不存内容。** 内容仍在 markdown/JSON 文件里。

```sql
-- 跨 task 查询
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workflow_sha TEXT,
  status TEXT,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE steps (
  task_id TEXT,
  step_id TEXT,
  status TEXT,
  duration_ms INTEGER,
  token_count INTEGER,
  PRIMARY KEY (task_id, step_id)
);

-- 反馈聚合
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY,
  task_id TEXT,
  step_id TEXT,
  type TEXT,
  severity TEXT,
  created_at TEXT
);
CREATE INDEX feedback_type_severity ON feedback(type, severity);

-- 规则 efficacy
CREATE TABLE rule_injections (
  id INTEGER PRIMARY KEY,
  rule_id TEXT,
  task_id TEXT,
  step_id TEXT,
  helped INTEGER,    -- 0/1
  hurt INTEGER,      -- 0/1
  created_at TEXT
);

-- Skill 版本和注入历史
CREATE TABLE skill_versions (
  skill_id TEXT,
  version TEXT,
  commit_sha TEXT,
  created_at TEXT,
  promoted_by TEXT,
  PRIMARY KEY (skill_id, version)
);

CREATE TABLE skill_injections (
  skill_id TEXT,
  version TEXT,
  task_id TEXT,
  step_id TEXT,
  injected_at TEXT
);

-- Recipe 使用记录
CREATE TABLE recipe_usage (
  recipe_id TEXT,
  task_id TEXT,
  applied_at TEXT,
  outcome TEXT,    -- "success" | "failed" | "partial"
  PRIMARY KEY (recipe_id, task_id)
);
```

**写入路径**：orchestrator 事件 → JSONL → 后台 batch insert（不阻塞主流程）。

**读取路径**：只在 Step 13 分析、Step 11 报告、Step 04 recipe 检索时读，不在热路径。

---

## 8. 实施优先级

### 第一期（地基，2-3 周）

| # | 任务 | 估时 | 依赖 |
|---|---|---|---|
| **0** | 清理 ComfyUI 根目录污染 + 写 `lint-workspace-purity.ts`（cron + pre-commit + 运行时三层执行） | 0.5 天 | - |
| **1** | 拆 `.demo-state/state.json` 为 per-task JSON | 2 天 | - |
| **2** | `taskWorkspaces.ts` 加 `feedback/` + `escalation/` 目录 | 0.5 天 | - |
| **3** | 定义 schema: skill frontmatter、recipe、feedback event | 1 天 | - |
| **4** | `.demo-state/skills-registry.json` + `promptSkillCompiler.ts` 改渐进加载 | 3-5 天 | 3 |
| **5** | 第一个 recipe 样板：灌 `CLIPLoader-qwen25-vl-fp8.json` | 1 天 | 3 |
| **6** | `humanApprovalBroker.ts` 加 feedback event 收集 | 2 天 | 2, 3 |
| **7** | 迁移现有 repro 脚本 + patch 到新目录结构 | 0.5 天 | - |
| **8** | SQLite analytics 基础表 + JSONL→DB sync | 3 天 | 6 |

### 第二期（智能层，1-2 个月）

| # | 任务 | 估时 | 依赖 |
|---|---|---|---|
| **9** | Step 13 prompt 加 feedback + evolution-analysis 输入 | 1 天 | 6, 8 |
| **10** | 反馈自动分类 agent（type + severity） | 5 天 | 9 |
| **11** | 规则 efficacy 评分 + 自动退役 | 3 天 | 8 |
| **12** | Step 04 自动从 recipe 库拉匹配 recipe 注入 prompt | 3 天 | 5 |
| **13** | Opencode escalation 最小实现（spawn → patch → 验证 → resume） | 5 天 | 2 |
| **14** | Prompt→skill 自动转换 agent | 1-2 周 | 4 |
| **15** | Golden workflow 集（手工标 3-5 个） | 持续 | - |
| **16** | Pre-commit hook + cron job 配置（purity lint、schema 校验、golden 回归） | 1 天 | 15 |

### 优先级理由

- **§8.0 最先做**：CI lint 是污染归零的杠杆，比文档管用 10 倍。
- **§8.1-8.3 是 schema 地基**：没这些，后面所有"进化"都是无源之水。
- **§8.4 渐进加载**：解锁上下文空间，是后续所有 skill 进化的前提。
- **§8.5 recipe 样板**：一个真实样例比 10 页文档管用。
- **§8.13 opencode escalation**：可并行做，独立模块。

---

## 9. 非范围

以下**不在本设计范围**：

- **Step isolation / 完全 P0 重构**（见 `backlog-context-optimization.md`）— 风险大，先靠渐进加载 + 摘要层缓解。
- **自动训练 / 微调** — 不做。所有进化都是 prompt/skill/代码层。
- **多 agent 协作**（A2A）— 不做。Opencode escalation 是单向 spawn，不是协作。
- **Model weights / embedding 重新训练** — 不做。
- **Web UI for evolution management** — 不做。先靠 markdown + git + sqlite CLI。
- **跨语言 agent（Python/Go/Rust）** — 不做。Opencode 用 Claude Code 即可。

---

## 附录 A：参考资料

- [DSPy](https://github.com/stanfordnlp/dspy) — prompt + few-shot demo 进化
- [Voyager](https://github.com/MineDojo/Voyager) — 可执行 skill 库 + 向量检索
- [ExpeL](https://github.com/LeapLabTHU/ExpeL) — 从轨迹抽 insights → 知识库
- [APE](https://github.com/keirp/automatic_prompt_engineer) — LLM 生成候选 prompt 打分
- [arXiv: Self-Evolving Agents Survey](https://arxiv.org/html/2507.21046v4)
- [OpenAI self-evolving cookbook](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining)

## 附录 B：现有代码映射

| 设计概念 | 现有实现 | 状态 |
|---|---|---|
| 规则抽取 | `workflowKnowledge.ts` | ✅ 闭环（缺 efficacy 评分） |
| 模式检测 | `evolutionAnalyzer.ts` | ✅ 产出，❌ Step 13 未消费 |
| Context 持久化分类 | `contextRetention.ts` | ⚠️ 只控持久化，未控制 session 内 |
| Workspace 布局 | `taskWorkspaces.ts` | ⚠️ 缺 feedback/escalation 目录 |
| Per-step SDK 轨迹 | `logs/sdk-session.jsonl` | ✅ |
| 状态存储 | `state.ts`（单 state.json） | ❌ 待拆分 per-task |
| Skill 加载 | `promptSkillCompiler.ts`（全量） | ❌ 待改渐进式 |
| Step 13 改进 | `prompts/.../13-agent-improvement-skill.md` | ⚠️ 半成品 |
| 反馈收集 | `humanApprovalBroker.ts`（单步决策） | ❌ 缺 type/severity/聚合 |

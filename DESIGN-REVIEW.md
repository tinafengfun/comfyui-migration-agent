# ComfyUI XPU Migration Agent — 架构梳理与问题分析

## 1. 项目定位

将 ComfyUI 的 CUDA 工作流半自动迁移到 Intel XPU 平台的 Web Agent 系统。后端通过 GitHub Copilot SDK 驱动 LLM Agent 执行 14 步（00–13）迁移流水线，前端提供任务管理、人工审批、产物浏览和进度监控。

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────┐
│  React Frontend (src/client/main.tsx)                │
│  - 任务 CRUD / 工作流上传                               │
│  - 步骤执行控制 / 人工审批                               │
│  - SSE 实时事件流 / 产物浏览                            │
└──────────────┬───────────────────────────────────────┘
               │ HTTP REST + SSE
┌──────────────▼───────────────────────────────────────┐
│  Express API Server (src/server/index.ts)             │
│  - 28 个 REST 端点                                     │
│  - JSON body 200MB limit                              │
│  - 无认证/鉴权                                         │
└──────────────┬───────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────┐
│  MigrationOrchestrator (orchestrator.ts)              │
│  - 任务生命周期管理                                     │
│  - 步骤调度与执行                                       │
│  - 人工门控 (Human Gate) 机制                          │
│  - Phase 1 单体 Agent 驱动                             │
│  - 上下文预算管理                                       │
│  - 状态同步与恢复                                       │
└───────┬──────────────────┬───────────────────────────┘
        │                  │
┌───────▼──────┐  ┌────────▼─────────┐
│ CopilotSdk   │  │ CopilotCli       │
│ Runner       │  │ Worker           │
│ (SDK 模式)   │  │ (CLI 子进程模式)  │
└───────┬──────┘  └────────┬─────────┘
        │                  │
        ▼                  ▼
  @github/copilot-sdk   copilot CLI binary
```

### 2.1 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **API 入口** | `server/index.ts` | Express 路由，408 行 |
| **编排器** | `server/orchestrator.ts` | 任务/步骤生命周期，人工门控，状态同步，2781 行 |
| **SDK Runner** | `server/copilotSdkRunner.ts` | Copilot SDK 会话管理，事件录制，看门狗，753 行 |
| **CLI Worker** | `server/copilotCliWorker.ts` | Copilot CLI 子进程模式，75 行 |
| **Phase 1 Agent** | `server/phase1Agent.ts` | 单体 Agent 驱动，任务状态管理，prompt 编译，767 行 |
| **Prompt 编译** | `server/promptSkillCompiler.ts` | StepJob 序列化为 Agent prompt，270 行 |
| **上下文预算** | `server/contextBudget.ts` | token 估算与预算追踪，198 行 |
| **上下文留存** | `server/contextRetention.ts` | SDK 事件分级与存储策略，167 行 |
| **审批代理** | `server/humanApprovalBroker.ts` | Promise-based 人工决策等待，43 行 |
| **状态存储** | `server/state.ts` | 持久化任务/事件/产物/决策 |
| **配置** | `server/config.ts` | 环境变量聚合，56 行 |
| **前端** | `client/main.tsx` | 单组件 React UI，1919 行 |

### 2.2 辅助模块

| 模块 | 职责 |
|------|------|
| `assetAcquisition.ts` | 资产获取任务（本地搜索 + 远程下载候选） |
| `assetPrep.ts` | Step 01 资产/CN 清单准备 |
| `assetSourceProviders.ts` / `Registry.ts` | HuggingFace / Civitai / GitHub 等提供商搜索 |
| `feasibility.ts` | Step 02 可行性预检 |
| `intakePreflight.ts` | Step 00 确定性预检 |
| `workflowInventory.ts` | Step 03 工作流节点/拓扑清单 |
| `stepArtifactScaffold.ts` | 步骤产物脚手架 |
| `sourceAuditCheckpoint.ts` | Step 04 源审计检查点 |
| `branchSmokeAggregate.ts` | Step 07 分支冒烟聚合 |
| `artifactCompletion.ts` | 产物完成度检查 |
| `progressNarrative.ts` | 人类可读进度叙述生成 |
| `subJobs.ts` | 下载子任务管理 |
| `fsUtils.ts` | 安全路径拼接、JSON 读写 |

---

## 3. 迁移流水线 (Steps 00–13)

```
00 Intake Preflight     ─ 确定性：解析工作流，检查本地模型/自定义节点
       │
01 Asset Resolution     ─ 确定性 + 人工门控：资产/CN 源解析，本地搜索
       │
02 Feasibility          ─ 确定性：源一致性差距分析
       │
03 Workflow Inventory   ─ 确定性：节点/链接拓扑清单
       │
04 Source Audit         ─ SDK Agent：CUDA/MPS/CPU 设备假设审计
       │
05 Environment Deploy   ─ SDK Agent + 人工门控：环境安装部署
       │
06 Prompt Generation    ─ SDK Agent：生成迁移 prompt + 运行时策略 prompt
       │
07 First-stage Smoke    ─ SDK Agent：分支冒烟测试
       │
08 Full Validation      ─ SDK Agent：全量验证
       │
09 Tuning               ─ SDK Agent：调优
       │
10 Coverage Review      ─ SDK Agent：覆盖率审查
       │
11 Delivery             ─ SDK Agent：交付打包
       │
12 GUI Acceptance       ─ SDK Agent + 人工门控：GUI 人工验收
       │
13 Agent Improvement    ─ SDK Agent：prompt/skill 反思改进
```

Steps 00/01/02/03 是确定性步骤（纯本地文件操作，不调用 SDK）；
Steps 04–13 通过 Copilot SDK 驱动 LLM Agent 执行。

### 3.1 两种执行模式

1. **逐步模式** (`runStep` / `runUntilGate`)：每次执行一个步骤或运行到人工门控
2. **Phase 1 单体模式** (`runPhase1Agent`)：一个 SDK 会话跑完 00–13，Agent 自行管理步骤切换

Phase 1 模式有独立的 `task-state.json` 状态管理，通过周期性同步 (`syncPhase1TaskState`) 与 API 层状态保持一致。

---

## 4. 关键机制

### 4.1 人工门控 (Human Gate)

```
Agent 遇到需要人工决策的情况
    │
    ├── SDK onPermissionRequest → 权限审批（默认自动批准）
    ├── SDK onUserInputRequest  → Agent 主动提问
    ├── 确定性步骤发现资产缺失   → 人工门控事件
    └── 上下文预算告警          → 检查点暂停
    │
    ▼
emit("human_question") → SSE 推送到前端
    │
    ▼
前端展示问题 + 选项 + 上下文说明
    │
    ▼
POST /api/tasks/:id/human-decisions
    │
    ▼
HumanApprovalBroker.resolveDecision() → Promise resolve → SDK 回调返回
```

每个 `human_question` 事件携带结构化的 `decisionContext`：
- 背景原因场景 (`backgroundReasonScene`)
- 术语解释 (`terminology`)
- 每个选项的后果与后续行动 (`consequencesAndFollowUp`)

### 4.2 上下文预算

Phase 1 单体会话运行时间长，有上下文溢出风险：

```
ContextBudgetTracker
    │
    ├── 追踪 SDK 事件数 + 字符数
    ├── 追踪产物文件大小
    ├── 估算 token 数 (chars / 4)
    │
    ├── warning 阈值 (180k tokens) → 写检查点
    └── critical 阈值 (300k tokens) → 暂停会话，等待恢复
```

达到 critical 时，后端暂停 SDK 会话，通过人工门控让用户选择：
- 在新 SDK 会话中从检查点恢复
- 停止并手动检查

### 4.3 进度看门狗

每个 SDK 步骤有双重超时保护：
- **无进度超时** (`noProgressTimeoutMs`)：默认 10 分钟（Phase 1 为 20 分钟）
- **最大运行时** (`maxRuntimeMs`)：默认 30 分钟（Phase 1 为 6 小时）

语义进度事件（助手消息、工具执行、文件变更）重置无进度计时器。

### 4.4 事件留存策略

SDK 事件按重要性分级：

| 级别 | 行为 | 示例 |
|------|------|------|
| `prompt_required` | 全部保留 | 错误/失败事件 |
| `prompt_summary` | 保留到 DB + 调试文件 | 语义进度事件 |
| `db_only` | 仅 DB | 非语义工具事件 |
| `debug_file_only` | 仅调试 JSONL | 无进度的 assistant.message |
| `drop` | 完全丢弃 | streaming_delta, usage_info, hook 事件 |

### 4.5 敏感信息脱敏

在产物持久化、日志记录、前端展示前统一脱敏：
- GitHub token (`ghp_*`, `github_pat_*`)
- HuggingFace token (`hf_*`)
- Bearer token
- 环境变量中的 token/password/secret
- URL query 参数中的 token/key/secret

---

## 5. 问题分析

### 5.1 严重问题

#### P0-1: Orchestrator 巨型类 (God Object)

`orchestrator.ts` 达到 **2781 行**，承担了过多职责：

- 任务 CRUD（创建/删除/清理）
- 步骤执行调度
- Phase 1 Agent 驱动
- 确定性步骤逻辑（00/01/02/03 内联处理）
- 人工门控管理（确定性门控 + Phase 1 门控 + 上下文预算门控）
- 状态同步与恢复
- 上下文预算告警
- CSV 解析
- 人工决策路由（停止/继续/提供上下文）
- 反思提案生成
- 硬停报告
- 事件发射与订阅

**影响**：可维护性极差，测试困难，修改一处容易引入回归。

**建议**：拆分为独立模块：
- `TaskManager` — 任务 CRUD + 清理
- `StepExecutor` — 步骤执行 + 确定性步骤逻辑
- `Phase1Driver` — Phase 1 单体 Agent 管理
- `HumanGateService` — 人工门控管理 + 决策路由
- `EventBus` — 事件发射/订阅

#### P0-2: 步骤错误静默吞没

```typescript
// index.ts:145, 154, 163, 176
void orchestrator.runStep(req.params.taskId, req.params.stepId).catch(() => undefined);
```

异步步骤执行的错误被 `.catch(() => undefined)` 完全吞掉。虽然步骤状态会通过 store 更新，但如果 store 更新本身失败，错误就永久丢失了。

**建议**：至少记录日志：
```typescript
void orchestrator.runStep(...).catch((err) => console.error("Step execution failed:", err));
```

#### P0-3: 无认证/鉴权

API 服务器暴露在 `0.0.0.0`，没有任何认证机制。任何网络客户端可以：
- 创建/删除任务
- 执行迁移步骤（消耗 LLM token）
- 读取所有产物和日志
- 发送人工决策

**建议**：至少添加 Bearer token 或 API key 认证中间件。

#### P0-4: JSON body 限制过大

```typescript
app.use(express.json({ limit: "200mb" }));
```

200MB 的 body 限制可用于内存耗尽攻击。

**建议**：降低到实际需要的上限（工作流 JSON 通常 < 10MB）。

### 5.2 架构问题

#### P1-1: 双执行模型导致状态不一致风险

逐步模式和 Phase 1 模式有各自的状态管理：
- 逐步模式：通过 `StateStore.updateStep()` 更新
- Phase 1 模式：Agent 写 `task-state.json`，后端周期性同步 (`syncPhase1TaskState`)

两者之间的同步依赖 10 秒间隔的定时器，存在状态不一致窗口。如果 Agent 在两次同步之间崩溃，API 层的状态可能过时。

#### P1-2: 确定性步骤逻辑内联在 orchestrator 中

Steps 00/01/02/03 的确定性逻辑通过 `if (stepId === "00")` / `if (stepId === "01")` ... 硬编码在 `runStep` 方法中。每添加一个确定性步骤都需要修改 orchestrator。

**建议**：引入 Step Handler 接口：
```typescript
interface StepHandler {
  canHandle(stepId: string): boolean;
  execute(task, step, context): Promise<StepResult>;
}
```

#### P1-3: 前端单组件架构

`main.tsx` 是 **1919 行的单个 React 组件**，管理 15+ 个 state 变量。这导致：
- 重渲染性能问题（任何 state 变化触发完整重渲染）
- 组件逻辑难以理解
- 无法独立测试 UI 部分

**建议**：拆分为 `TaskPanel`, `WorkflowGraph`, `HumanInteraction`, `ArtifactBrowser`, `Phase1Panel` 等子组件。

#### P1-4: SSE 无重连机制

前端 `EventSource` 在连接断开后不会自动重连，也不处理 `error` 事件。长时间运行的迁移任务中，网络波动可能导致前端失去实时更新。

### 5.3 代码质量问题

#### P2-1: 重复的工具函数

`isRecord`, `stringValue`, `truncateString`, `truncateForProgress` 等函数在多个文件中重复定义：
- `orchestrator.ts`
- `copilotSdkRunner.ts`
- `contextRetention.ts`
- `main.tsx`

**建议**：提取到 `shared/utils.ts`。

#### P2-2: `isRecord` 行为不一致

```typescript
// orchestrator.ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// copilotSdkRunner.ts & contextRetention.ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
  // 不排除 Array
}
```

`copilotSdkRunner.ts` 中数组会通过 `isRecord` 检查，可能导致后续代码将数组当对象使用。

**建议**：统一为排除数组的版本，放到 `shared/utils.ts`。

#### P2-3: 未使用的函数

`copilotSdkRunner.ts:692` 的 `isAssistantArtifactProgress` 函数已定义但从未被调用。

#### P2-4: Step 04 硬编码的节点族列表

```typescript
// promptSkillCompiler.ts:132-136
"Focus on active critical node families only: QwenVL (AILab_QwenVL), SeedVR2 loaders/upscaler, ..."
```

这些节点名称硬编码在代码中，应放到配置或 prompt 文件中。

### 5.4 健壮性问题

#### P3-1: 任务创建删除所有已有任务

```typescript
// orchestrator.ts - prepareExclusiveNewTask
const tasks = await this.store.listTasks();
for (const task of tasks) {
  await deleteTaskWorkspace(this.config.workspaceRoot, task.workspacePath);
  await this.store.deleteTask(task.id);
}
```

每次创建新任务都会删除所有已有任务。虽然是 demo 设计，但缺乏确认机制，误操作风险高。

#### P3-2: 看门狗定时器未 unref

`createProgressWatchdog` 使用 `setInterval` 但没有调用 `.unref()`。在步骤执行期间，这会阻止 Node.js 进程自然退出。

#### P3-3: 缺少 graceful shutdown

服务器没有 SIGTERM/SIGINT 处理。进程被终止时：
- 活跃的 SDK 会话不会被清理
- SSE 连接不会被关闭
- 写了一半的文件可能损坏

### 5.5 测试覆盖

存在测试文件但需确认覆盖率：

```
src/server/contextRetention.test.ts
src/server/taskWorkspaces.test.ts
src/server/progressNarrative.test.ts
src/server/workflowLoader.test.ts
src/server/phase1Agent.test.ts
src/server/orchestrator.test.ts
src/server/assetSourceProviders.test.ts
src/server/artifactCompletion.test.ts
src/server/humanApprovalBroker.test.ts
src/server/assetPrep.test.ts
src/server/copilotSdkRunner.test.ts
src/server/config.test.ts
src/server/contextBudget.test.ts
src/server/sourceAuditCheckpoint.test.ts
src/server/promptSkillCompiler.test.ts
src/server/stepArtifactScaffold.test.ts
src/server/subJobs.test.ts
src/server/feasibility.test.ts
```

核心模块都有对应测试，但 orchestrator 的测试受其 God Object 结构影响可能不够充分。

---

## 6. 数据流

### 6.1 任务创建

```
POST /api/tasks { workflowFileName, workflowJson }
    │
    ▼
prepareExclusiveNewTask()  ─── 删除所有已有任务
    │
    ▼
createTaskWorkspace()  ─── 创建 workspaces/{taskId}/ 目录结构
    │
    ▼
store.createTask()  ─── 持久化任务元数据
    │
    ▼
emit("progress")  ─── 通知前端
```

### 6.2 步骤执行 (逐步模式)

```
POST /api/tasks/:id/steps/:stepId/run
    │
    ▼
reconcileStaleActiveTasks()  ─── 清理上次进程的残留状态
    │
    ▼
compileStepJob()  ─── 编译 StepJob (prompt + skill + context)
    │
    ▼
[确定性步骤?]
    ├── Yes → 执行本地逻辑 → 更新状态 → return
    └── No  ↓
    │
    ▼
sdkRunner.runStep(job, emit, waitForDecision)
    │
    ├── onPermissionRequest → 自动批准 或 人工门控
    ├── onUserInputRequest  → 人工门控
    ├── onEvent             → 录制 + 看门狗 + 预算追踪
    │
    ▼
session.sendAndWait(prompt, timeout)
    │
    ▼
检查产物完成度 → 更新状态 → 通知前端
```

### 6.3 Phase 1 单体执行

```
POST /api/tasks/:id/run-phase1
    │
    ▼
preparePhase1Driver()
    │   ├── 构建 task-state.json (14 步状态)
    │   ├── 编译 Phase 1 driver prompt
    │   ├── 初始化 running-summary.md
    │   ├── 初始化 context-debt.json
    │   └── 初始化 phase3-extraction-candidates.json
    │
    ▼
sdkRunner.runStep(phase1Job, emit, waitForDecision, observePhase1SdkEvent)
    │
    ├── 周期性 syncPhase1TaskState() (10s 间隔)
    ├── 上下文预算追踪 → 警告/暂停
    │
    ▼
会话结束 → syncPhase1TaskState() → 检查终端状态 → 暴露人工门控
```

---

## 7. 技术栈依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| `@github/copilot-sdk` | ^0.3.0 | Copilot SDK，0.x 版本 API 不稳定 |
| `express` | ^5.2.1 | **Express 5 仍为 alpha/beta** |
| `react` / `react-dom` | ^19.2.1 | React 19 |
| `vite` | ^7.2.7 | 构建工具 |
| `typescript` | ^5.9.3 | TypeScript |
| `vitest` | ^4.0.15 | 测试框架 |

**风险点**：
- Copilot SDK 0.x 可能有 breaking changes
- Express 5 非稳定版本

---

## 8. 改进建议优先级

| 优先级 | 编号 | 建议 |
|--------|------|------|
| **P0** | P0-1 | 拆分 orchestrator.ts 为 5+ 独立模块 |
| **P0** | P0-2 | 步骤错误记录日志，不再静默吞没 |
| **P0** | P0-3 | 添加 API 认证中间件 |
| **P0** | P0-4 | 降低 JSON body 限制到合理值 |
| **P1** | P1-1 | 统一逐步/Phase 1 状态管理策略 |
| **P1** | P1-2 | 引入 StepHandler 接口解耦确定性步骤 |
| **P1** | P1-3 | 拆分前端为独立组件 |
| **P1** | P1-4 | 添加 SSE 重连逻辑 |
| **P2** | P2-1 | 提取重复工具函数到 shared/ |
| **P2** | P2-2 | 统一 isRecord 实现 |
| **P2** | P2-3 | 清理未使用代码 |
| **P3** | P3-1 | 任务创建时增加确认或保留机制 |
| **P3** | P3-2 | 看门狗定时器添加 unref() |
| **P3** | P3-3 | 添加 graceful shutdown 处理 |

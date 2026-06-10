# Backlog: Workspace Lifecycle & Isolation

> Status: BACKLOG — 问题的根因已定位，方案待后续统一重构。
> Created: 2026-06-03
> Last updated: 2026-06-08

## Background

每次上传 workflow 会创建一个 migration workspace（`workspaces/<taskId>/`）。
当前 workspace 管理存在多个设计和实现缺陷，在 2026-06-02 的端到端测试中集中暴露。

---

## 问题清单（按严重程度排序）

### W0: Agent shell CWD 是 task workspace，不是 ComfyUI root

**表现**：Step 05 agent 在 Copilot CLI detached shell 中运行 `exec python3 server.py`，
但 shell CWD = task workspace（`workspaces/<taskId>/`），不是 ComfyUI/。
Python 的 `sys.path[0]` 不包含 ComfyUI root，导致 `from utils.install_util import ...` 失败。

**临时修复**：agent 在 server.py 中添加了 sys.path shim（3 个 commit），但这只是 workaround。

**根因**：SDK session 的 `workingDirectory` 设为 `job.workspacePath`（task workspace），
所有 bash 命令的 CWD 都是 workspace 目录。agent 必须显式 `cd` 到 ComfyUI root 才能启动。

**正确方案**：ComfyUI 启动应由 orchestrator 统一管理，不应由 agent bash 命令触发。
Orchestrator 知道 ComfyUI root 路径，可以在正确的 CWD 启动进程。

**涉及文件**：
- `src/server/orchestrator.ts` — 新增 `startComfyUIForTask()` / `stopComfyUIForTask()`
- `src/server/copilotSdkRunner.ts` — `workingDirectory` 改为 ComfyUI root（或保持不变但文档化）
- `prompts/migration-workflow-v2/skills/05-environment-deployment-skill.md` — Launch command 章节（已更新）

---

### W1: ComfyUI 进程泄漏

**表现**：多个历史 workspace 的 ComfyUI 进程仍在后台运行，占用 GPU 显存和端口。

```
PID 830537  — task 296b0592 (port 8191, from May 25)
PID 1025345 — task a5fba0a2 (port 8188, from May 26)
```

**根因**：`rerunStep()` 调用 `killComfyUIProcessesForTask()` 只杀当前 task 的进程，
历史 task 的进程无人清理。服务重启也不会清理残留进程（进程是 nohup 后台启动的）。

**方案**：
1. `restart.sh` 启动时 `pgrep -f "main.py" | xargs kill` 清理所有残留 ComfyUI 进程
2. orchestrator 维护 ComfyUI 进程注册表（taskId → PID → port）
3. 新 task 启动 ComfyUI 前先杀同 port 的旧进程

---

### W2: SDK 超时后 step 状态卡死

**表现**：`session.sendAndWait()` 30 分钟超时，SDK session 死亡，
但 orchestrator 的 step 状态机没有捕获这种 "半死" 状态，step 卡在 `running`。
后续所有 human decision 被记录为 "for next resume" 但永远不会 resume。
前端 run/rerun 按钮被 "Step is already running" 拒绝。

**根因**：
- `sendAndWait` 等待 `session.idle`，但 agent 在 `onUserInputRequest`（等用户回答）时不会 emit idle
- 超时后 error 被 catch 但没有更新 step status
- `activeSteps` Map 中残留条目阻止 rerun

**方案**：
1. 在 `copilotSdkRunner.ts` 的 catch 块中，检测 `sendAndWait` 超时错误，抛出特定异常
2. orchestrator 捕获该异常，将 step 标记为 `paused`（新状态）而非 `running`
3. 暴露 `resumePausedStep` API，允许前端恢复
4. 或：增大 `sdkIdleTimeoutMs`（当前 30 分钟）到更长值，或设为 0（无限等待，靠 watchdog）

**涉及文件**：
- `src/server/copilotSdkRunner.ts` — catch `sendAndWait` timeout
- `src/server/orchestrator.ts` — 新增 `paused` 状态 + `activeSteps` 清理
- `src/shared/types.ts` — step status 联合类型加 `paused`
- `src/client/` — 前端 UI 支持 `paused` 状态

---

### W3: 无 workspace 生命周期管理

**表现**：所有 workspace（无论完成/失败/进行中）堆积在 `workspaces/` 目录，
没有归档、清理或对比机制。

**方案**：
1. workspace 三态：`active` / `completed` / `archived`
2. 完成的 task 7 天后自动 archive（压缩为 tar.gz）
3. 提供 API：`GET /api/tasks?status=active`、`DELETE /api/tasks/:id`、`POST /api/tasks/:id/archive`
4. 前端 TaskList 区分活跃/历史 task
5. 磁盘配额：`workspaces/` 超过 10GB 时拒绝新 task 并提示清理

---

### W4: Rerun 时没有 clean slate

**表现**：rerun step 时只清理部分文件（artifacts），workspace 目录残留上一次的
输出、日志、临时文件。agent 可能读到过期数据做出错误判断。

**方案**：
1. `rerunStep()` 时清理该 step 的所有 artifacts（已部分实现）
2. 清理 `outputs/`、`inputs/` 中的临时文件
3. 杀死该 task 的 ComfyUI 进程（已实现 `killComfyUIProcessesForTask`）
4. 可选：提供 "full reset" 功能，清理整个 workspace 从 step 00 重新开始

---

### W5: 多 workspace 共享 venv 和 ComfyUI 源码

**表现**：所有 task 共享同一个 ComfyUI checkout 和 `.venv-xpu`。
一个 task 的 agent 修改了 ComfyUI 源码（如 XPU guard patch）会影响所有 task。

**方案**：
1. 短期：agent 的 patch 必须通过 git stash/unstash 隔离，每个 task 完成后 revert
2. 长期：为每个 task 创建 ComfyUI 的 git worktree（轻量级，共享 .git）
3. venv 可以共享（只读），但如有安装操作需要在 worktree 的基础上

---

## 依赖关系

```
W0 (CWD 问题) ─── 最优先，影响每个 task
  │
W1 (进程泄漏) ─── 独立，可立刻做
  │
W2 (状态卡死) ─── 独立，可立刻做
  │
W3 (生命周期) ─── 独立，可后续做
  │
W4 (rerun 清理) ─── 依赖 W0（orchestrator 管理 ComfyUI 启停后更容易做）
  │
W5 (源码隔离) ─── 低优先，短期用 git stash 即可
```

建议实施顺序：**W1 → W2 → W0 → W4 → W3 → W5**

---

## 已完成的临时修复

| 问题 | 临时修复 | 文件 |
|------|---------|------|
| W0 CWD 问题 | agent 在 server.py 中添加 sys.path shim | ComfyUI `server.py`, `app/frontend_management.py` (3 commits) |
| W0 Launch 规范 | skill 文件中规范了 `main.py` + `--disable-dynamic-vram` | `prompts/.../05-environment-deployment-skill.md` |
| W2 状态卡死 | 手动修改 `.demo-state/state.json` | 临时 workaround，需代码修复 |
| W1 进程泄漏 | `killComfyUIProcessesForTask()` | `src/server/orchestrator.ts` (仅当前 task) |

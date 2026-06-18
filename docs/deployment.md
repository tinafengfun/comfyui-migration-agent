# ComfyUI Migration Agent — 部署和配置指南

## 快速启动

```bash
# 1. 安装依赖
cd agent-demo
npm install

# 2. 配置 LLM provider
cp env.example env
vim env  # 取消注释你需要的 provider profile

# 3. 启动服务
bash scripts/restart.sh
```

启动后访问：
- 前端: http://localhost:5173
- 后端 API: http://127.0.0.1:3001/api/health

## 配置说明

### LLM Provider 配置

`env` 文件控制 LLM 模型选择。支持 4 种 provider profile：

#### Profile A: GitHub Copilot API（默认）

```bash
export COPILOT_MODEL=gpt-5-mini
# 无需设置 COPILOT_PROVIDER_* 变量
# 自动使用 gh auth token 认证
```

前提条件：
```bash
gh auth login          # 安装 GitHub CLI 并登录
gh auth status         # 确认有 copilot scope
```

#### Profile B: Intel AI Demo API

```bash
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_PROVIDER_BASE_URL=https://aidemo.intel.cn/v1
export COPILOT_PROVIDER_API_KEY=your-key
export COPILOT_MODEL=minimax-m2.7
```

#### Profile C: OpenAI-compatible（vLLM, Ollama 等）

```bash
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_PROVIDER_BASE_URL=http://localhost:11434/v1
export COPILOT_PROVIDER_API_KEY=unused
export COPILOT_MODEL=qwen3-235b-a22b
```

#### Profile D: Anthropic

```bash
export COPILOT_PROVIDER_TYPE=anthropic
export COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com
export COPILOT_PROVIDER_API_KEY=sk-ant-xxxxx
export COPILOT_MODEL=claude-sonnet-4-20250514
```

### 环境变量参考

| 变量 | 必需 | 说明 |
|------|------|------|
| `COPILOT_MODEL` | 是 | 模型名称 |
| `COPILOT_PROVIDER_TYPE` | 自定义 provider 时 | `openai` / `azure` / `anthropic` |
| `COPILOT_PROVIDER_BASE_URL` | 自定义 provider 时 | API endpoint URL |
| `COPILOT_PROVIDER_API_KEY` | 自定义 provider 时 | API key |
| `COPILOT_PROVIDER_MAX_PROMPT_TOKENS` | 否 | 最大输入 token（默认 128000） |
| `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS` | 否 | 最大输出 token（默认 16000） |

### env 文件查找顺序

1. `AGENT_ENV` 环境变量指定的路径
2. `agent-demo/env`
3. `agent-demo/../env`（上级目录）

```bash
# 自定义路径
export AGENT_ENV=/path/to/my-env
bash scripts/restart.sh
```

## 服务管理

```bash
# 启动/重启
bash scripts/restart.sh

# 查看日志
tail -f /tmp/migration-backend.log
tail -f /tmp/migration-frontend.log

# 手动停服务
pkill -f "tsx src/server/index.ts"   # 后端
pkill -f "vite --host"                # 前端
```

## 前端使用流程

1. **上传 Workflow** — 拖拽或选择 ComfyUI workflow JSON 文件
2. **Run until gate** — 自动依次执行 step，遇到 human gate 暂停
3. **Human Gate 交互** — 在 chat 区域与 agent 多轮对话决策
4. **上传缺失文件** — 如果 step 01 提示缺少 input media，点击上传
5. **逐步执行 / 重新执行** — 每个 step 可以独立 run / rerun

## 项目结构

```
agent-demo/
├── env.example              # LLM 配置模板（复制为 env 后编辑）
├── scripts/
│   └── restart.sh           # 一键重启脚本（构建 + 启动前后端）
├── src/
│   ├── client/              # React 前端
│   │   ├── main.tsx         # 主 UI 组件
│   │   ├── hooks/useApi.ts  # API 调用封装
│   │   └── styles.css       # 样式
│   ├── server/              # Node.js 后端
│   │   ├── index.ts         # Express API 路由
│   │   ├── orchestrator.ts  # 核心编排器（step 调度、human gate）
│   │   ├── copilotSdkRunner.ts  # Copilot SDK 封装
│   │   ├── assetReplacement.ts  # 文件上传与放置
│   │   └── humanApprovalBroker.ts  # 人工审批中间件
│   └── shared/types.ts      # 共享类型定义
├── prompts/
│   └── migration-workflow-v2/   # Step prompts 和 skills
│       ├── prompts/         # 各 step 的 prompt 文件
│       ├── skills/          # 各 step 的 skill 文件
│       └── tools/           # Python 工具脚本
├── docs/
│   └── deployment.md        # 本文件
└── workspaces/              # 运行时 task 数据（gitignore）
```

## 常见问题

### "Failed to list models"

GitHub Copilot API 被代理/防火墙阻断。解决方案：
1. 配置 HTTP 代理让 `api.githubcopilot.com` 通过
2. 切换到其他 provider profile（Intel AI Demo / vLLM / Anthropic）

### Step 报 IPEX dependency error

```bash
cd /path/to/ComfyUI
.venv-xpu/bin/pip uninstall intel-extension-for-pytorch -y
```

PyTorch 2.11+ 已内置 XPU 支持，旧版 IPEX 不兼容且不再需要。

### LoadImage 找不到上传的图片

系统已自动处理三道防线：
1. 上传时文件放置到 `ComfyUI/input/` + `task-workspace/inputs/` + 通过 API 注册
2. Step 07+ 运行前自动同步 `input-media/` 到 ComfyUI 实例
3. rerun 时杀掉旧 ComfyUI 进程，确保干净重启

### 重新执行某个 Step

点击 step 旁边的 "Re-run" 按钮。系统会：
1. 杀掉关联的 ComfyUI 进程
2. 清理该 step 生成的 artifact 文件
3. 重置 step 和下游 step 状态
4. 重新执行

# ComfyUI Migration Agent — 部署指南 (1:1 复刻 runbook)

本文档是把迁移 Agent 部署到一台新机器的权威步骤，已在 `172.16.124.12:/workspace` 上完整验证过。
照着做即可得到一台和原机配置/可用性一致的 Agent 节点。

---

## 1. 架构与依赖关系

```
┌──────────────────────────────────────────────────────────────┐
│  Migration Agent  (本仓库, Node + Express + React + Vite)      │
│   • 后端 API : tsx src/server/index.ts   → :3001              │
│   • 前端     : vite --host                → :5173             │
│   • LLM 后端 : 通过 Copilot SDK 的 custom-provider 走 DeepSeek │
│   • 编排器   : 14 步迁移流水线 (00-intake … 13-improvement)    │
└───────────────┬──────────────────────────────────────────────┘
                │ 依赖 (运行时由 Agent 拉起)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  ComfyUI checkout  ($COMFYUI_ROOT, 自带 XPU torch 的 venv)     │
│   • Agent 在 Step 05 用 $node.venv_python 启动 main.py         │
│   • --listen 0.0.0.0 --port 8188 --reserve-vram 1              │
└───────────────┬──────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────┐
│  模型库  ($MODEL_ROOTS, 例 /home/intel/hf_models)              │
│   • 单机部署=本地目录; 多机部署=NFS 同路径只读挂载              │
└──────────────────────────────────────────────────────────────┘
```

**关键点：** 本仓库**不包含** ComfyUI 源码。Agent 运行时需要一个独立的 ComfyUI checkout
（由 `COMFYUI_ROOT` / `gpu-nodes.json` 指向）。ComfyUI 的安装可以用
`scripts/bootstrap-gpu-node.mts`，或手动 `git clone` + 建 XPU venv。

---

## 2. 前置条件 (新机器上需要先具备)

| 条件 | 说明 |
|---|---|
| **Node.js ≥ 20** (推荐 22 LTS) | Agent 是 TypeScript，需要 node + npm。`curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` |
| **ComfyUI + XPU torch** | 一份能跑的 ComfyUI checkout（含 `.venv-xpu`，`torch.xpu.is_available()==True`）。没有就用 bootstrap 脚本装。 |
| **模型库** | 一个模型目录（checkpoints / loras / ...）。多机共享建议 NFS 同路径挂载。 |
| **Intel 出网代理** | 公司网访问 github/npm/DeepSeek 都要代理 `http://proxy.ims.intel.com:911`（**不要**用 `child-prc.intel.com:912`，Fortinet 拦 github TLS）。 |
| **DeepSeek API Key** | 当前生效的 LLM 后端（见 §4）。 |

> 若新机器 apt 处于 broken 状态（如残留 oneapi 依赖冲突），先 `sudo apt-get -y --fix-broken install` 再装 Node。

---

## 3. 快速部署 (5 步)

```bash
# 0. 代理写进 shell（github/npm/DeepSeek 都需要）
cat >> ~/.proxyrc <<'EOF'
export HTTP_PROXY=http://proxy.ims.intel.com:911
export HTTPS_PROXY=http://proxy.ims.intel.com:911
export http_proxy=http://proxy.ims.intel.com:911
export https_proxy=http://proxy.ims.intel.com:911
export NO_PROXY=localhost,127.0.0.1
EOF
echo '[ -f ~/.proxyrc ] && . ~/.proxyrc' >> ~/.bashrc && . ~/.proxyrc
git config --global http.proxy http://proxy.ims.intel.com:911
git config --global https.proxy http://proxy.ims.intel.com:911

# 1. 克隆
git clone https://github.com/tinafengfun/comfyui-migration-agent.git
cd comfyui-migration-agent

# 2. 一键初始化（检查 Node、npm ci、从模板生成 env/gpu-nodes.json、typecheck）
bash scripts/setup.sh

# 3. 编辑 env —— 填 DeepSeek API key + 本机路径（见 §4 / §5）
$EDITOR env

# 4. 编辑 gpu-nodes.json —— 把 local-xpu 的路径改成本机真实路径（见 §5）
$EDITOR gpu-nodes.json

# 5. 启动并验证
bash scripts/restart.sh
curl -s http://127.0.0.1:3001/api/health   # 期望 {"ok":true,...}
```

浏览器打开 `http://<host>:5173` 即可使用 GUI。

---

## 4. LLM 后端配置 (`env`)

`scripts/restart.sh` 启动时会 source `env` 文件。`env` 是**本地机密文件**（含 API key），
**不进 git**（`.gitignore` 已忽略 `/env`），模板是 `env.example`。

### Profile A — DeepSeek（当前生效，推荐）

Agent 用 `@github/copilot-sdk` 的 **custom-provider** 把请求转发到 DeepSeek（OpenAI 兼容），
不经过 GitHub Copilot 的 token 交换，最稳定。

```bash
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_PROVIDER_BASE_URL=https://api.deepseek.com
export COPILOT_PROVIDER_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export COPILOT_MODEL=deepseek-v4-flash
export COPILOT_DISABLE_REASONING=1
export COPILOT_PROVIDER_MAX_PROMPT_TOKENS=128000
export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS=16000
```

### Profile B — GitHub Copilot（注意 token 类型）

需要 `gh auth login`（OAuth，`copilot` scope）登录过的环境，**且 `env` 里不要设
`COPILOT_SDK_GH_TOKEN`**。SDK 在 `useLoggedInUser:true` 下会走 Copilot CLI 的 auto-login。

> ⚠️ **不要**把 classic PAT (`ghp_…`) 塞进 `COPILOT_SDK_GH_TOKEN`：那会强制
> `useLoggedInUser:false` + 显式 token，Copilot 的 token-exchange 端点会拒绝 PAT
>（`400 Personal Access Tokens are not supported for this endpoint`）。
> 要么留空走 auto-login（需 gh 已登录），要么用 fine-grained PAT（开 "Copilot Requests" 权限）走 `GH_TOKEN`。

```bash
# 仅在 gh 已 OAuth 登录的机器上：什么都不用设，默认就是 Copilot
export COPILOT_MODEL=gpt-5-mini
```

### Profile C / D — 其它 OpenAI 兼容 / Anthropic

```bash
# Intel AI Demo
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_PROVIDER_BASE_URL=https://aidemo.intel.cn/v1
export COPILOT_PROVIDER_API_KEY=...
export COPILOT_MODEL=minimax-m2.7

# Anthropic
export COPILOT_PROVIDER_TYPE=anthropic
export COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com
export COPILOT_PROVIDER_API_KEY=sk-ant-...
export COPILOT_MODEL=claude-sonnet-4-20250514
```

启动后 `restart.sh` 会打印当前 `Model:` / `Provider:`，确认生效。

---

## 5. GPU 节点配置 (`gpu-nodes.json`)

`gpu-nodes.json` 是**本机文件**（含机器路径 / ssh key 路径），不进 git，模板是
`gpu-nodes.example.json`。`setup.sh` 会自动 `cp` 一份。

单机部署——只留一个 `local` 节点，指向本机的 ComfyUI：

```json
{
  "default_node": "local-xpu",
  "nodes": [{
    "name": "local-xpu",
    "kind": "local",
    "comfyui_root": "/home/intel/ComfyUI",
    "venv_python": "/home/intel/ComfyUI/.venv-xpu/bin/python3",
    "model_roots": ["/home/intel/hf_models"],
    "api_host": "127.0.0.1",
    "api_port": 8188,
    "launch_flags": ["--reserve-vram", "1"],
    "vram_gb": 24
  }]
}
```

**多机部署**（把工作调度到大显存远端）用 CLI 一键引导，会自动装远端 ComfyUI、配 SSH key、
NFS 同路径挂载、注册到 `gpu-nodes.json`：

```bash
npx tsx scripts/bootstrap-gpu-node.mts \
  --name remote-biggpu --host 172.16.124.12 --user intel \
  --comfyui-root /home/intel/ComfyUI --vram-gb 24 --allow-sudo
```

详见 `docs/gpu-node-setup.md`。GUI 里也可以 Manage → 增删改查 / 测试节点。

---

## 6. Recipes / Patches / Schemas

全部随仓库提交，开箱即用，无需额外操作：

- `recipes/` — 命中即注入到 Step 02/04/05 提示词的硬知识（如 CLIPLoader-qwen-fp8）。
- `patches/` — ComfyUI 源码补丁（如 seedvr2-xpu-registration），按 recipe 在迁移时按需 apply。
- `schemas/` — skill frontmatter / recipe / feedback 的 JSON Schema。
- `prompts/migration-workflow-v2/` — 14 步的 prompt + skill + tools（`draftDocRoot` 默认指这里）。

---

## 7. 验证

```bash
npm run typecheck                 # TS 通过
npm test                          # vitest，期望 32 files / 201 tests 全绿
npx tsx scripts/e2e-smoke.mts     # 不走 LLM 的接线冒烟（recipe 注入/反馈/分析库）
curl -s http://127.0.0.1:3001/api/health
curl -s http://127.0.0.1:3001/api/gpu-nodes
```

**真实端到端迁移**（走 LLM + ComfyUI）：

```bash
# 准备一个 ComfyUI 导出的 workflow JSON，然后：
npx tsx scripts/e2e-migration.mts --auto-approve --timeout 25 path/to/workflow.json
```

成功标志：Step 00→01→02→03… 依次推进，`artifacts/sdk-sessions/02-*.md` 有 LLM 输出，
`run-report.json` 记录进度。Step 05 会拉起本机 ComfyUI（`curl 127.0.0.1:8188/system_stats` 可查）。
模型/自定义节点缺失会在后续步骤以 hard-stop / human gate 报出，属于预期行为。

---

## 8. 故障排查 (本次新机部署实测踩坑)

| 现象 | 原因 | 解决 |
|---|---|---|
| `apt install nodejs` 报 unmet dependencies | 残留 oneapi 包冲突 | `sudo apt-get -y --fix-broken install` 后重装 |
| `npm test` 报 ENOENT `…/ComfyUI/docs/draft/…` | `testDraftDocRoot()` 只认旧的 in-ComfyUI 布局 | 已修：优先用仓库自带 `prompts/` |
| Step 00 `EACCES …/.tmp/…` 扫模型库崩 | 模型库是只读 NFS，含不可读子目录；3 个 walk 只吞 ENOENT | 已修：`intakePreflight/assetPrep/assetAcquisition` 的 walk 都吞 `EACCES/EPERM` |
| Step 02 `400 Personal Access Tokens are not supported` | 把 PAT 塞进 `COPILOT_SDK_GH_TOKEN`，强制显式 token | 改用 DeepSeek（Profile A），或留空走 gh auto-login；**别用 classic PAT** |
| Step 02 `Session was not created with authentication info` | `useLoggedInUser:true` 但本机没有可用 gh 登录态 | 用 DeepSeek，或在新机 `gh auth login`(OAuth) |
| DeepSeek 调用超时/连不上 | 没走代理 | 确保 `env` 里设了 `HTTPS_PROXY=http://proxy.ims.intel.com:911` |

---

## 9. 服务管理

```bash
bash scripts/restart.sh            # 重启后端 + 前端（会清理泄漏的 ComfyUI 进程）
tail -f /tmp/migration-backend.log
tail -f /tmp/migration-frontend.log
pkill -f "tsx src/server/index.ts" # 手动停后端
```

- 后端默认 `:3001`（`PORT` 可改），前端 `:5173`，ComfyUI `:8188`。
- `restart.sh` 查找 `env` 的顺序：`$AGENT_ENV` → `./env` → `../env` → `../../env`。

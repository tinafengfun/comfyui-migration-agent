# 未通过 XPU 验证的 custom node 清单（人工处理）

来源：`comfyui_migration_tasks.xlsx` 批量导入后仍为 candidate/unsupported 的 29 个节点。
按问题类型分组，附真实问题（表格人工备注 + 本次批量导入的发现）。生成于 2026-08-27。

catalog 里这些都已作为 candidate 记录（带 knownIssue），修好后可用
`scripts/catalog-import` 流程重新入库（装依赖/打 patch → 重跑 harvest → build-records 升为 trusted）。

---

## A. 大概率能直接用 / 小修（表格标"可直接运行"，harvest 失败多为缺依赖或小 import 问题）

| 节点 | 问题 / 备注 |
|---|---|
| **Bjornulf_custom_nodes** | 大型综合节点包；表格标"可直接运行"——需现场跑一遍看具体报错 |
| **ComfyUI-AutomaticCFG** | 自动 CFG 重缩放；`colorama` 已装仍未注册 → 有 import/代码问题需排查 |
| **ComfyUI-Dev-Utils** | 开发者工具；`aiohttp-sse` 已装仍未注册 → 需排查 |
| **ComfyUI_FizzNodes** | 动画/调度节点；`pandas numexpr` 已装仍未注册；仓库已 2 年未更新 |
| **comfyui-dream-project** | Deforum 类动画；表格标"可直接运行" |
| **comfyui-ollama** | 接入 Ollama/LLM；需要本机起 ollama 服务才会注册 |
| **comfyui-tensorops** | 张量操作节点 |
| **ComfyUI_Fill-Nodes** | 图像/特效/文件/视频综合节点 |
| **comfyui_image_metadata_extension** | 保存图片元数据（Civitai 兼容） |
| **ComfyUI_WordCloud** | 词云节点 |
| **CRT-Nodes** | 通用扩展合集；表格标"可直接运行" |
| **ComfyUI-TeaCache** | 表格：已支持 CacheDit，**可先不支持 TeaCache**（可跳过） |
| **ComfyUI-Manager** | 表格：**用自带版本即可**（本身不是节点提供者，无需入库） |

## B. 需要具体代码 / device 修改（已有明确改动点）

| 节点 | 问题 / 改动点 |
|---|---|
| **ComfyUI-wanBlockswap** | `nodes.py` 中 `torch.device("cuda")` 改成 `xpu`（无 requirements，纯 device 改） |
| **ComfyUI-segment-anything-2** | `nodes.py` 的 `DownloadAndLoadSAM2Model` 需要增加 xpu 适配 |
| **ComfyUI-Impact-Pack** | 内部调用 KSampler，**可在 xpu 上运行**；harvest 缺依赖，装齐依赖应能注册 |
| **ComfyUI-LivePortraitKJ** | 不能用 MediaPipeCropper（mediapipe 已停维护，报 `No module named 'mediapipe.framework'`）；改用 **insightfaceCropper** + device 选 CPU 可正常运行 |
| **ComfyUI_PuLID_Flux_ll** | `pip install facenet-pytorch --no-deps`；Load InsightFace / Load FaceNet 可加 xpu 或选 CPU；`PulidFluxHook.py` 在 omni comfyui 有 bug 需修正 |
| **ComfyUI_IndexTTS** | 升级到 omni-b7 后无法启动（transformers 版本改动不兼容），**已提 PR** |
| **ComfyUI-FluxTrainer** | 与 `transformers==5.0` 冲突；**可在 omni b6 版本运行** |
| **ComfyUI-Woosh** | 语音模型；安装失败，需手工 `pip install hear21passt` |

## C. 完全 CUDA / 暂不移植（表格已明确标注）

| 节点 | 问题 |
|---|---|
| **ComfyUI-3D-Pack** | 强依赖 NV，不太好改 |
| **ComfyUI-nunchaku** | 依赖 nunchaku-ai/nunchaku，完全是 CUDA 实现，暂不移植 |
| **ComfyUI-FlashVSR** | 视频超分，使用 cuda，需要迁移 |
| **ComfyUI-FlashVSR_Ultra_Fast** | 视频超分（cuda） |

## D. 仓库不可用 / 已迁移 / 翻译类（换源或无需处理）

| 节点 | 问题 |
|---|---|
| **comfyui-reactor-node** | 原仓库 HTTP 403（已停维护）；**已迁移到 `ComfyUI-ReActor`（PR 已 merge，已支持 xpu）→ 建议改用该包** |
| **ComfyUI_CatVTON_Wrapper** | catalog 记录的 `AkshayLaghate/...` 仓库 404（已删/私有）；另有 `chflame163/ComfyUI_CatVTON_Wrapper` 分支但非同一实现，需重新确认源 |
| **AIGODLIKE-COMFYUI-TRANSLATION** | 停维护，后续转入 ComfyUI 官方内置翻译（可不处理） |
| **ComfyUI-DD-Translation** | 基于上面的衍生翻译分支（同上，可不处理） |

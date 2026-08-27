# 未通过 XPU 验证的 custom node 清单（人工处理 · backlog）

来源：`comfyui_migration_tasks.xlsx` 批量导入后仍为 candidate/unsupported 的 29 个节点。
按问题类型分组，附真实问题（表格人工备注 + 本次批量导入的发现）+ 迁移工作量估计。
生成于 2026-08-27。**状态：后续有空再处理（不阻塞主线）。**

catalog 里这些都已作为 candidate 记录（带 knownIssue），修好后走 `scripts/catalog-import`
流程重新入库（装依赖/打 patch → 重跑 harvest → build-records 升为 trusted）。
**注意：torch 相关依赖一定在容器内装**（宿主机侧会拉 CUDA torch 覆盖 XPU torch，见 P3 教训）。

## 工作量总览

| 工作量档 | 含义 | 节点数 | 预计总量 |
|---|---|---|---|
| **S 小** | <1h：装依赖 / 换源 / 起服务 / 跳过 | 13 | ~1–1.5 人日 |
| **M 中** | 1–3h：明确的 device patch + 现场验证 | 8 | ~2–3 人日 |
| **L 大** | 数天或需真正移植 CUDA kernel，可行性存疑 | 4 | 单独立项评估 |
| **—** | 无需处理（翻译类停维护 / Manager 用自带） | 4 | 0 |

建议顺序：**先 B 类的 device patch（M，收益明确）→ 再 A 类捞依赖（S）→ D 类换源（reactor）→ C 类单独评估**。

---

## A. 大概率能直接用 / 小修（表格标"可直接运行"，多为缺依赖或小 import 问题）

| 节点 | 问题 / 备注 | 工作量 |
|---|---|---|
| **ComfyUI-TeaCache** | 已支持 CacheDit，**可先不支持 TeaCache**（跳过） | S（跳过） |
| **ComfyUI-Manager** | **用自带版本即可**，本身不是节点提供者，无需入库 | —（跳过） |
| **comfyui-ollama** | 接入 Ollama/LLM；需本机起 ollama 服务才会注册 | S |
| **Bjornulf_custom_nodes** | 大型综合包；表格标"可直接运行"，现场跑看报错 | S |
| **comfyui-dream-project** | Deforum 类动画；"可直接运行" | S |
| **CRT-Nodes** | 通用扩展合集；"可直接运行" | S |
| **comfyui-tensorops** | 张量操作节点 | S |
| **ComfyUI_Fill-Nodes** | 图像/特效/文件/视频综合节点 | S |
| **comfyui_image_metadata_extension** | 保存图片元数据（Civitai 兼容） | S |
| **ComfyUI_WordCloud** | 词云节点 | S |
| **ComfyUI-AutomaticCFG** | `colorama` 已装仍未注册 → 有 import/代码问题需排查 | S–M |
| **ComfyUI-Dev-Utils** | `aiohttp-sse` 已装仍未注册 → 需排查 | S–M |
| **ComfyUI_FizzNodes** | `pandas numexpr` 已装仍未注册；仓库 2 年未更新 | S–M |

## B. 需要具体代码 / device 修改（已有明确改动点，收益明确 → 优先）

| 节点 | 问题 / 改动点 | 工作量 |
|---|---|---|
| **ComfyUI-wanBlockswap** | `nodes.py` 中 `torch.device("cuda")` → `xpu`（无 requirements，纯 device 改） | M（偏 S） |
| **ComfyUI-Impact-Pack** | 内部调用 KSampler，**可在 xpu 上运行**；装齐依赖应能注册 | M |
| **ComfyUI-segment-anything-2** | `nodes.py` 的 `DownloadAndLoadSAM2Model` 需增加 xpu 适配 | M |
| **ComfyUI-LivePortraitKJ** | 弃用 MediaPipeCropper（已停维护，报 `No module named 'mediapipe.framework'`）；改 insightfaceCropper + device 选 CPU | M |
| **ComfyUI-Woosh** | 语音模型；安装失败，需手工 `pip install hear21passt` | M |
| **ComfyUI_PuLID_Flux_ll** | `pip install facenet-pytorch --no-deps`；InsightFace/FaceNet 可加 xpu 或选 CPU；`PulidFluxHook.py` 在 omni 有 bug 需修 | M（偏 L） |
| **ComfyUI_IndexTTS** | omni-b7 后 transformers 版本不兼容，**已提 PR** → 合入后重测 | M（依赖 PR） |
| **ComfyUI-FluxTrainer** | 与 `transformers==5.0` 冲突；**可在 omni b6 运行** → 需版本协调 | M |

## C. 完全 CUDA / 暂不移植（表格已明确标注，需真正移植或放弃）

| 节点 | 问题 | 工作量 |
|---|---|---|
| **ComfyUI-3D-Pack** | 强依赖 NV，不太好改 | L（立项评估） |
| **ComfyUI-nunchaku** | 依赖 nunchaku-ai/nunchaku，完全 CUDA 实现，暂不移植 | L（可能不可行） |
| **ComfyUI-FlashVSR** | 视频超分，使用 cuda，需要迁移 | L |
| **ComfyUI-FlashVSR_Ultra_Fast** | 视频超分（cuda） | L |

## D. 仓库不可用 / 已迁移 / 翻译类（换源或无需处理）

| 节点 | 问题 | 工作量 |
|---|---|---|
| **comfyui-reactor-node** | 原仓库 403（停维护）；**已迁移到 `ComfyUI-ReActor`（PR 已 merge，已支持 xpu）→ 改用该包**，走标准流程入库 | S（换源） |
| **ComfyUI_CatVTON_Wrapper** | catalog 记录的 `AkshayLaghate/...` 404；另有 `chflame163/ComfyUI_CatVTON_Wrapper` 但非同一实现，需重新确认源 | S–M（先定源） |
| **AIGODLIKE-COMFYUI-TRANSLATION** | 停维护，转入 ComfyUI 官方内置翻译 | —（跳过） |
| **ComfyUI-DD-Translation** | 基于上面的衍生翻译分支 | —（跳过） |

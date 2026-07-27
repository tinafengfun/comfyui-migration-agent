import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureAssetAcquisitionJob, generateAssetQueryVariants } from "./assetAcquisition";
import { ensureDir } from "./fsUtils";
import { demoModelRoot } from "./config";

describe("generateAssetQueryVariants", () => {
  it("strips a parenthetical strength-range hint and CJK descriptive words to find the real repo name (Klein LoRA)", () => {
    const variants = generateAssetQueryVariants("Klein-大熊一致性consistency（0.4-1.0）.safetensors");
    expect(variants).toContain("Klein-consistency");
    expect(variants).toContain("Klein consistency");
  });

  it("strips a stale version suffix to find the real repo name (Z-Image checkpoint)", () => {
    const variants = generateAssetQueryVariants("Z-Image-Anime-AIO-FP8_V1.safetensors");
    expect(variants).toContain("Z-Image-Anime-AIO-FP8");
  });

  it("always includes the extension-stripped raw name first (cheapest, most common case)", () => {
    const variants = generateAssetQueryVariants("flux1-dev.safetensors");
    expect(variants[0]).toBe("flux1-dev");
  });

  it("returns a single variant unchanged when the name has no noise to strip", () => {
    const variants = generateAssetQueryVariants("ae.safetensors");
    expect(variants).toEqual(["ae"]);
  });

  it("never returns more than 5 variants", () => {
    const variants = generateAssetQueryVariants("Some-Really（Messy）Name_V3-With-Many-Tokens-Here.safetensors");
    expect(variants.length).toBeLessThanOrEqual(5);
  });

  it("dedupes variants that collapse to the same string after stripping", () => {
    const variants = generateAssetQueryVariants("plain-name.safetensors");
    expect(new Set(variants).size).toBe(variants.length);
  });
});

describe("asset acquisition job", () => {
  it("creates provider search and custom-node candidate plans for unresolved assets", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task-asset-acquisition",
      name: "Asset acquisition",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        '"definitely_missing_asset_for_test.safetensors","definitely_missing_asset_for_test.safetensors","","not found","source unknown","ComfyUI/models/diffusion_models/definitely_missing_asset_for_test.safetensors","","","18:UNETLoader","","missing","requires human approval/source","none","false","source-identical asset not staged"',
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "| Node type | Source package or repo | Installed/source evidence | State | Human action |",
        "| --- | --- | --- | --- | --- |",
        "| SeedVR2LoadDiTModel | seedvr2_videoupscaler | package hint from workflow only | source known | none |",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "Use https://hf-mirror.com and GitHub for missing assets",
      redactedHumanContext: "Use https://hf-mirror.com and GitHub for missing assets",
      sourceSearch: async (input) => ({
        config: {
          profileName: "test",
          enableNetworkSearch: true,
          allowInsecureTls: false,
          requestTimeoutSeconds: 1,
          maxResultsPerProvider: 1,
          huggingFaceEndpoint: "https://hf-mirror.com",
          modelScopeEndpoint: "https://modelscope.cn",
          hasHuggingFaceToken: false,
          hasCivitaiToken: false,
          hasGitHubToken: false,
          proxyConfigured: true,
          enableDownload: false,
          explicitHuggingFaceFiles: [],
          huggingFaceFallbackEndpoints: ["https://hf-mirror.com"],
          tokenEnvNames: {
            huggingface: ["HF_TOKEN"],
            civitai: ["CIVITAI_TOKEN"],
            github: ["GITHUB_TOKEN"]
          },
          proxyEnvNames: ["ASSET_DOWNLOAD_PROXY"]
        },
        issues: [],
        candidates: [
          {
            provider: input.kind === "model" ? "huggingface" : "github",
            title: input.query,
            url: `https://example.test/${input.query}`,
            // A real provider API hit (HuggingFace/Civitai/ModelScope/token-
            // authenticated GitHub) always sets apiUrl -- this is what tells
            // the query-variant loop in ensureAssetAcquisitionJob to stop
            // trying further fuzzy variants (see generateAssetQueryVariants).
            apiUrl: `https://example.test/api?query=${input.query}`,
            score: 100,
            requiresToken: false,
            notes: "mock candidate"
          }
        ]
      })
    });

    expect(result.status).toBe("waiting_for_secure_download");
    expect(result.providerCandidateCount).toBe(1);
    expect(result.customNodeCandidateCount).toBe(1);
    expect(result.remoteCandidateCount).toBe(0);
    expect(result.unresolvedItems[0]).toMatchObject({
      assetName: "definitely_missing_asset_for_test.safetensors",
      kind: "model asset",
      expectedTargetPath: "ComfyUI/models/diffusion_models/definitely_missing_asset_for_test.safetensors",
      candidateCount: 1
    });
    const job = JSON.parse(await fs.readFile(result.jobPath, "utf8")) as {
      unresolvedItems: Array<{ assetName: string; kind: string; expectedTargetPath: string }>;
      items: Array<{ candidates: unknown[]; targetPath: string; kind: string; expectedTargetPath: string }>;
      customNodeItems: Array<{ candidates: unknown[] }>;
    };
    expect(job.unresolvedItems[0]?.assetName).toBe("definitely_missing_asset_for_test.safetensors");
    expect(job.unresolvedItems[0]?.expectedTargetPath).toBe(
      "ComfyUI/models/diffusion_models/definitely_missing_asset_for_test.safetensors"
    );
    expect(job.items[0]?.candidates).toHaveLength(1);
    expect(job.items[0]?.targetPath).toContain("diffusion_models");
    expect(job.items[0]?.kind).toBe("model asset");
    expect(job.customNodeItems[0]?.candidates).toHaveLength(1);
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("Provider/remote search found 1 candidate");
    expect(report).toContain("ComfyUI/models/diffusion_models/definitely_missing_asset_for_test.safetensors");
  });

  it("downloads to the task's node-specific model root, not the demo model root, when both are configured (real bug: demoModelRoot was unconditionally preferred whenever present, and resolveModelRoots always includes it, so every download was invisible to the actual target GPU node's own NFS-shared model root)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-model-root-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const nodeSpecificRoot = path.join(root, "nfs-share");
    await ensureDir(artifactPath);
    await ensureDir(nodeSpecificRoot);
    const task: MigrationTask = {
      id: "task-asset-acquisition-model-root",
      name: "Asset acquisition model root",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        // Empty staged_path -- no "ComfyUI/"-prefixed expectedTargetPath, so
        // targetPathForRow falls through to primaryModelRoot(modelRoots, ...).
        '"model_root_test.safetensors","model_root_test.safetensors","","not found","source unknown","","","","1:UNETLoader","","missing","requires human approval/source","none","false","source-identical asset not staged"',
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ensureAssetAcquisitionJob({
      task,
      // demoModelRoot listed first, exactly like resolveModelRoots' merge order
      // (config.ts's globalRoots always prepends demoModelRoot; the node's own
      // model_roots are appended after).
      modelRoots: [demoModelRoot, nodeSpecificRoot],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "",
      redactedHumanContext: "",
      sourceSearch: async () => ({
        config: {
          profileName: "test",
          enableNetworkSearch: false,
          allowInsecureTls: false,
          requestTimeoutSeconds: 1,
          maxResultsPerProvider: 1,
          huggingFaceEndpoint: "https://huggingface.co",
          modelScopeEndpoint: "https://modelscope.cn",
          hasHuggingFaceToken: false,
          hasCivitaiToken: false,
          hasGitHubToken: false,
          proxyConfigured: false,
          enableDownload: false,
          explicitHuggingFaceFiles: [],
          huggingFaceFallbackEndpoints: ["https://hf-mirror.com"],
          tokenEnvNames: {
            huggingface: ["HF_TOKEN"],
            civitai: ["CIVITAI_TOKEN"],
            github: ["GITHUB_TOKEN"]
          },
          proxyEnvNames: ["ASSET_DOWNLOAD_PROXY"]
        },
        issues: [],
        candidates: []
      })
    });

    const job = JSON.parse(await fs.readFile(result.jobPath, "utf8")) as {
      items: Array<{ assetName: string; targetPath: string }>;
    };
    const item = job.items.find((i) => i.assetName === "model_root_test.safetensors");
    expect(item?.targetPath).toBeDefined();
    expect(path.resolve(item!.targetPath).startsWith(path.resolve(nodeSpecificRoot))).toBe(true);
    expect(path.resolve(item!.targetPath).startsWith(path.resolve(demoModelRoot))).toBe(false);
  });

  it("adds local model_repo roots and SSH remote exact-file candidates without persisting secrets", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-remote-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const localRepo = path.join(root, "repo");
    await ensureDir(artifactPath);
    await ensureDir(localRepo);
    await fs.writeFile(path.join(localRepo, "local.safetensors"), "local", "utf8");
    const modelRepoPath = path.join(root, "model_repo");
    await fs.writeFile(
      modelRepoPath,
      [
        `local dir ${localRepo}`,
        "remote: 172.16.120.97:~/lucas/weights/models login user: intel, pwd: secret-password",
        "hf token: hf_secretvalue1234567890",
        ""
      ].join("\n"),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task-asset-acquisition-remote",
      name: "Asset acquisition remote",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        '"local.safetensors","local.safetensors","","not found","source unknown","","","","1:LoraLoader","","missing","requires human approval/source","none","false","source-identical asset not staged"',
        '"remote.safetensors","remote.safetensors","","not found","source unknown","","","","2:LoraLoader","","missing","requires human approval/source","none","false","source-identical asset not staged"',
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "",
      redactedHumanContext: "",
      modelRepoPath,
      sourceSearch: async () => ({
        config: {
          profileName: "test",
          enableNetworkSearch: false,
          allowInsecureTls: false,
          requestTimeoutSeconds: 1,
          maxResultsPerProvider: 1,
          huggingFaceEndpoint: "https://huggingface.co",
          modelScopeEndpoint: "https://modelscope.cn",
          hasHuggingFaceToken: false,
          hasCivitaiToken: false,
          hasGitHubToken: false,
          proxyConfigured: false,
          enableDownload: false,
          explicitHuggingFaceFiles: [],
          huggingFaceFallbackEndpoints: ["https://hf-mirror.com"],
          tokenEnvNames: {
            huggingface: ["HF_TOKEN"],
            civitai: ["CIVITAI_TOKEN"],
            github: ["GITHUB_TOKEN"]
          },
          proxyEnvNames: ["ASSET_DOWNLOAD_PROXY"]
        },
        issues: [],
        candidates: []
      }),
      remoteSearch: async (assetName, targetPath, remotes) => ({
        issues: [],
        candidates: assetName === "remote.safetensors" ? remotes.map((remote) => ({
          provider: "ssh_remote",
          title: `${remote.user}@${remote.host}:${remote.root}/remote.safetensors`,
          url: `ssh://${remote.host}/remote.safetensors`,
          downloadUrl: `${remote.user}@${remote.host}:${remote.root}/remote.safetensors`,
          sizeBytes: 123,
          score: 100,
          requiresToken: false,
          notes: "mock ssh candidate",
          downloadCommand: ["scp", `${remote.user}@${remote.host}:${remote.root}/remote.safetensors`, targetPath]
        })) : []
      })
    });

    expect(result.remoteCandidateCount).toBe(1);
    const jobText = await fs.readFile(result.jobPath, "utf8");
    expect(jobText).not.toContain("secret-password");
    expect(jobText).not.toContain("hf_secretvalue");
    const job = JSON.parse(jobText) as {
      items: Array<{ assetName: string; status: string; candidates?: Array<{ provider: string }> }>;
      remoteModelSources: Array<{ host: string; user?: string; root: string }>;
    };
    expect(job.items.find((item) => item.assetName === "local.safetensors")?.status).toBe("resolved_local_exact");
    expect(job.items.find((item) => item.assetName === "remote.safetensors")?.candidates?.[0]?.provider).toBe("ssh_remote");
    expect(job.remoteModelSources[0]).toEqual({
      host: "172.16.120.97",
      user: "intel",
      root: "~/lucas/weights/models"
    });
  });

  it("treats current custom-node table local/cache paths as already sourced", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-custom-nodes-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const localNode = path.join(root, "ComfyUI", "custom_nodes", "comfyui_controlnet_aux");
    const cachedNode = path.join(root, "cache", "custom_nodes", "ComfyUI-QwenVL");
    await ensureDir(artifactPath);
    await ensureDir(localNode);
    await ensureDir(cachedNode);
    const task: MigrationTask = {
      id: "task-asset-acquisition-custom-nodes",
      name: "Asset acquisition custom nodes",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        '"already.safetensors","already.safetensors","/models/already.safetensors","/models/already.safetensors","staged","ComfyUI/models/checkpoints/already.safetensors","","","active selector","","present","complete","none","false",""',
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "| Node type(s) | Node IDs | Package/source | Local/cache path | Repository | Commit | Install status | Hidden asset evidence | State |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        `| AIO_Preprocessor | 2,76,77 | comfyui_controlnet_aux | ${localNode} | https://github.com/Fannovel16/comfyui_controlnet_aux.git | e8b689a | installed local source | hidden assets scanned | source staged |`,
        `| AILab_QwenVL | 93 | ComfyUI-QwenVL | cache/custom_nodes/ComfyUI-QwenVL | https://github.com/1038lab/ComfyUI-QwenVL.git | fcd1ada | copied into cache | model staged | source staged |`,
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "",
      redactedHumanContext: "",
      sourceSearch: async () => {
        throw new Error("source search should not run for already sourced custom nodes");
      }
    });

    expect(result.customNodeCandidateCount).toBe(0);
    const job = JSON.parse(await fs.readFile(result.jobPath, "utf8")) as {
      customNodeItems: Array<{ packageHint: string; status: string }>;
    };
    expect(job.customNodeItems).toEqual([
      expect.objectContaining({ packageHint: "comfyui_controlnet_aux", status: "source_known" }),
      expect.objectContaining({ packageHint: "ComfyUI-QwenVL", status: "source_known" })
    ]);
  });

  it("recognizes an already-installed custom node even when the evidence column is prose, not a path (real bug)", async () => {
    // Regression test for a real incident: 01-custom-nodes.md's 5-column
    // table format ("Node type | Source package or repo | Installed/source
    // evidence | State | Human action") had "package hint from workflow
    // only" in the evidence column for rgthree-comfy -- prose, not a
    // filesystem path. customNodeEvidencePaths() only recognizes evidence
    // strings that are absolute or start with "custom_nodes/"/"cache/", so
    // it returned [] and the existence check always missed the package even
    // though it was genuinely installed (symlinked from the shared NFS
    // tree), falling through to a doomed `git clone` into a directory that
    // already exists -- surfaced live as a spurious "clone failed" human
    // gate for a package that needed no action at all.
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-prose-evidence-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const comfyuiRoot = path.join(root, "ComfyUI");
    const installedNodeDir = path.join(comfyuiRoot, "custom_nodes", "rgthree-comfy");
    await ensureDir(artifactPath);
    await ensureDir(installedNodeDir);
    const task: MigrationTask = {
      id: "task-asset-acquisition-prose-evidence",
      name: "Asset acquisition prose evidence",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "| Node type | Source package or repo | Installed/source evidence | State | Human action |",
        "| --- | --- | --- | --- | --- |",
        "| Image Comparer (rgthree) | rgthree-comfy | package hint from workflow only | source known | none |",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot,
      humanContext: "",
      redactedHumanContext: "",
      sourceSearch: async () => {
        throw new Error("source search should not run for an already-installed custom node");
      }
    });

    expect(result.customNodeCandidateCount).toBe(0);
    const job = JSON.parse(await fs.readFile(result.jobPath, "utf8")) as {
      customNodeItems: Array<{ packageHint: string; status: string; sourcePath?: string }>;
    };
    expect(job.customNodeItems).toEqual([
      expect.objectContaining({
        packageHint: "rgthree-comfy",
        status: "source_known",
        sourcePath: installedNodeDir
      })
    ]);
  });

  it("searches by the real node type (not the useless 'comfy-core' hint) for a workflow-tagged-core node missing locally (Tier 1)", async () => {
    // Regression test for the resolution-side generalization: a node the
    // workflow tags cnr_id: comfy-core but that isn't in this build (see
    // intakePreflight.ts's isCustomNode fix) has packageHint "comfy-core" --
    // useless as a search query. The existing generic custom-node repo
    // search should query by nodeType instead, so it can still surface a
    // legacy/compat package the same way any other unresolved custom node
    // search would.
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-core-tier1-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const recipesRoot = path.join(root, "recipes-empty");
    await ensureDir(artifactPath);
    await ensureDir(recipesRoot);
    const task: MigrationTask = {
      id: "task-core-tier1",
      name: "Core node tier 1",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "| Node type | Source package or repo | Installed/source evidence | State | Human action |",
        "| --- | --- | --- | --- | --- |",
        "| TextEncodeBooguEdit | comfy-core | comfy-core (missing locally) | source unknown | Provide upstream commit or legacy package |",
        ""
      ].join("\n"),
      "utf8"
    );

    const queries: string[] = [];
    const result = await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "",
      redactedHumanContext: "",
      recipesRoot,
      sourceSearch: async (input) => {
        queries.push(input.query);
        return {
          config: {
            profileName: "test",
            enableNetworkSearch: true,
            allowInsecureTls: false,
            requestTimeoutSeconds: 1,
            maxResultsPerProvider: 1,
            huggingFaceEndpoint: "https://huggingface.co",
            modelScopeEndpoint: "https://modelscope.cn",
            hasHuggingFaceToken: false,
            hasCivitaiToken: false,
            hasGitHubToken: false,
            proxyConfigured: false,
            enableDownload: false,
            explicitHuggingFaceFiles: [],
            huggingFaceFallbackEndpoints: [],
            tokenEnvNames: { huggingface: [], civitai: [], github: [] },
            proxyEnvNames: []
          },
          issues: [],
          candidates: []
        };
      }
    });

    expect(queries).toEqual(["TextEncodeBooguEdit"]);
    const job = JSON.parse(await fs.readFile(result.jobPath, "utf8")) as {
      customNodeItems: Array<{ packageHint: string; nodeType: string; status: string }>;
    };
    expect(job.customNodeItems[0]).toMatchObject({ packageHint: "comfy-core", nodeType: "TextEncodeBooguEdit" });
  });

  it("drafts a recipe via upstream discovery for a workflow-tagged-core node with no existing recipe (Tier 2)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-core-tier2-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const recipesRoot = path.join(root, "recipes-empty");
    await ensureDir(artifactPath);
    await ensureDir(recipesRoot);
    const task: MigrationTask = {
      id: "task-core-tier2",
      name: "Core node tier 2",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "| Node type | Source package or repo | Installed/source evidence | State | Human action |",
        "| --- | --- | --- | --- | --- |",
        "| TextEncodeBooguEdit | comfy-core | comfy-core (missing locally) | source unknown | Provide upstream commit or legacy package |",
        ""
      ].join("\n"),
      "utf8"
    );

    let discoverCalls = 0;
    const result = await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "",
      redactedHumanContext: "",
      recipesRoot,
      sourceSearch: async () => ({
        config: {
          profileName: "test",
          enableNetworkSearch: true,
          allowInsecureTls: false,
          requestTimeoutSeconds: 1,
          maxResultsPerProvider: 1,
          huggingFaceEndpoint: "https://huggingface.co",
          modelScopeEndpoint: "https://modelscope.cn",
          hasHuggingFaceToken: false,
          hasCivitaiToken: false,
          hasGitHubToken: false,
          proxyConfigured: false,
          enableDownload: false,
          explicitHuggingFaceFiles: [],
          huggingFaceFallbackEndpoints: [],
          tokenEnvNames: { huggingface: [], civitai: [], github: [] },
          proxyEnvNames: []
        },
        issues: [],
        candidates: []
      }),
      discoverCoreNodeRecipe: async ({ nodeType, patchFile }) => {
        discoverCalls += 1;
        return {
          recipe: {
            recipeId: `${nodeType}-core-support-draft`,
            version: "0.1.0",
            nodeType,
            xpuSupport: "unknown",
            patchFile,
            knownIssues: ["Auto-drafted; not yet validated."],
            provenance: { taskOrigin: task.id, createdAt: "2026-07-24" }
          },
          patchContent: "diff --git a/comfy_extras/nodes_boogu.py b/comfy_extras/nodes_boogu.py\n",
          discovery: {
            found: true,
            confidence: "high",
            commitSha: "abc1234",
            filesTouched: ["comfy_extras/nodes_boogu.py"],
            reason: "confirmed via merge commit diff"
          }
        };
      }
    });

    expect(discoverCalls).toBe(1);
    const job = JSON.parse(await fs.readFile(result.jobPath, "utf8")) as {
      customNodeItems: Array<{
        nodeType: string;
        coreNodeRecipeDraft?: { recipe: { recipeId: string }; discovery: { confidence: string } };
      }>;
    };
    expect(job.customNodeItems[0]?.coreNodeRecipeDraft).toMatchObject({
      recipe: { recipeId: "TextEncodeBooguEdit-core-support-draft" },
      discovery: { confidence: "high" }
    });
    const stagedPatch = await fs.readFile(
      path.join(root, "artifacts", "staged-recipes", "TextEncodeBooguEdit-core-support.patch"),
      "utf8"
    );
    expect(stagedPatch).toContain("nodes_boogu.py");
  });

  it("attaches isolated verification results to a Tier 2 draft, merging a passing validationCommand into the recipe", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-core-verify-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const recipesRoot = path.join(root, "recipes-empty");
    await ensureDir(artifactPath);
    await ensureDir(recipesRoot);
    const task: MigrationTask = {
      id: "task-core-verify",
      name: "Core node verify",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "| Node type | Source package or repo | Installed/source evidence | State | Human action |",
        "| --- | --- | --- | --- | --- |",
        "| TextEncodeBooguEdit | comfy-core | comfy-core (missing locally) | source unknown | Provide upstream commit or legacy package |",
        ""
      ].join("\n"),
      "utf8"
    );

    let verifyCalledWithPatchPath = "";
    const result = await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "",
      redactedHumanContext: "",
      recipesRoot,
      sourceSearch: async () => ({
        config: {
          profileName: "test",
          enableNetworkSearch: true,
          allowInsecureTls: false,
          requestTimeoutSeconds: 1,
          maxResultsPerProvider: 1,
          huggingFaceEndpoint: "https://huggingface.co",
          modelScopeEndpoint: "https://modelscope.cn",
          hasHuggingFaceToken: false,
          hasCivitaiToken: false,
          hasGitHubToken: false,
          proxyConfigured: false,
          enableDownload: false,
          explicitHuggingFaceFiles: [],
          huggingFaceFallbackEndpoints: [],
          tokenEnvNames: { huggingface: [], civitai: [], github: [] },
          proxyEnvNames: []
        },
        issues: [],
        candidates: []
      }),
      discoverCoreNodeRecipe: async ({ nodeType, patchFile }) => ({
        recipe: {
          recipeId: `${nodeType}-core-support-draft`,
          version: "0.1.0",
          nodeType,
          xpuSupport: "unknown",
          patchFile,
          patchTarget: "comfy_extras/nodes_boogu.py",
          knownIssues: ["Auto-drafted; not yet validated."],
          provenance: { taskOrigin: task.id, createdAt: "2026-07-24" }
        },
        patchContent: "diff --git a/comfy_extras/nodes_boogu.py b/comfy_extras/nodes_boogu.py\n",
        discovery: {
          found: true,
          confidence: "high",
          commitSha: "abc1234",
          filesTouched: ["comfy_extras/nodes_boogu.py"],
          reason: "confirmed via merge commit diff"
        }
      }),
      verifyCoreNodeRecipe: async ({ stagedPatchPath }) => {
        verifyCalledWithPatchPath = stagedPatchPath;
        return {
          verified: true,
          verificationDetail: "Patch applied cleanly and TextEncodeBooguEdit is confirmed registered.",
          validationCommand: "python3 -m py_compile comfy_extras/nodes_boogu.py"
        };
      }
    });

    expect(verifyCalledWithPatchPath).toBe(
      path.join(root, "artifacts", "staged-recipes", "TextEncodeBooguEdit-core-support.patch")
    );
    const job = JSON.parse(await fs.readFile(result.jobPath, "utf8")) as {
      customNodeItems: Array<{
        coreNodeRecipeDraft?: {
          recipe: { validationCommand?: string };
          verification?: { verified: boolean; verificationDetail: string };
        };
      }>;
    };
    expect(job.customNodeItems[0]?.coreNodeRecipeDraft?.verification).toEqual({
      verified: true,
      verificationDetail: "Patch applied cleanly and TextEncodeBooguEdit is confirmed registered."
    });
    expect(job.customNodeItems[0]?.coreNodeRecipeDraft?.recipe.validationCommand).toBe(
      "python3 -m py_compile comfy_extras/nodes_boogu.py"
    );
  });

  it("attaches a failed verification without merging a validationCommand, still leaving the draft available for manual review", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-core-verify-fail-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const recipesRoot = path.join(root, "recipes-empty");
    await ensureDir(artifactPath);
    await ensureDir(recipesRoot);
    const task: MigrationTask = {
      id: "task-core-verify-fail",
      name: "Core node verify fail",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "| Node type | Source package or repo | Installed/source evidence | State | Human action |",
        "| --- | --- | --- | --- | --- |",
        "| TextEncodeBooguEdit | comfy-core | comfy-core (missing locally) | source unknown | Provide upstream commit or legacy package |",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "",
      redactedHumanContext: "",
      recipesRoot,
      sourceSearch: async () => ({
        config: {
          profileName: "test",
          enableNetworkSearch: true,
          allowInsecureTls: false,
          requestTimeoutSeconds: 1,
          maxResultsPerProvider: 1,
          huggingFaceEndpoint: "https://huggingface.co",
          modelScopeEndpoint: "https://modelscope.cn",
          hasHuggingFaceToken: false,
          hasCivitaiToken: false,
          hasGitHubToken: false,
          proxyConfigured: false,
          enableDownload: false,
          explicitHuggingFaceFiles: [],
          huggingFaceFallbackEndpoints: [],
          tokenEnvNames: { huggingface: [], civitai: [], github: [] },
          proxyEnvNames: []
        },
        issues: [],
        candidates: []
      }),
      discoverCoreNodeRecipe: async ({ nodeType, patchFile }) => ({
        recipe: {
          recipeId: `${nodeType}-core-support-draft`,
          version: "0.1.0",
          nodeType,
          xpuSupport: "unknown",
          patchFile,
          knownIssues: ["Auto-drafted; not yet validated."],
          provenance: { taskOrigin: task.id, createdAt: "2026-07-24" }
        },
        patchContent: "diff --git a/comfy_extras/nodes_boogu.py b/comfy_extras/nodes_boogu.py\n",
        discovery: { found: true, confidence: "high", commitSha: "abc1234", reason: "confirmed via merge commit diff" }
      }),
      verifyCoreNodeRecipe: async () => ({
        verified: false,
        verificationDetail: "Patch did not apply cleanly to an isolated worktree."
      })
    });

    const job = JSON.parse(await fs.readFile(result.jobPath, "utf8")) as {
      customNodeItems: Array<{
        coreNodeRecipeDraft?: {
          recipe: { validationCommand?: string };
          verification?: { verified: boolean; verificationDetail: string };
        };
      }>;
    };
    const draft = job.customNodeItems[0]?.coreNodeRecipeDraft;
    expect(draft?.verification).toEqual({
      verified: false,
      verificationDetail: "Patch did not apply cleanly to an isolated worktree."
    });
    expect(draft?.recipe.validationCommand).toBeUndefined();
  });

  it("skips upstream discovery entirely when a recipe already covers this node type (Tier 2 short-circuit)", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `asset-acquisition-core-has-recipe-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const recipesRoot = path.join(root, "recipes-existing");
    await ensureDir(artifactPath);
    await ensureDir(recipesRoot);
    await fs.writeFile(
      path.join(recipesRoot, "TextEncodeBooguEdit-core-support.json"),
      JSON.stringify({
        recipeId: "TextEncodeBooguEdit-core-support",
        version: "1.0.0",
        nodeType: "TextEncodeBooguEdit",
        xpuSupport: "patched",
        patchFile: "patches/TextEncodeBooguEdit-core-support.patch",
        knownIssues: ["already reviewed"],
        provenance: { taskOrigin: "earlier-task", createdAt: "2026-07-01", approvedBy: "tinafengfun" }
      }),
      "utf8"
    );
    const task: MigrationTask = {
      id: "task-core-has-recipe",
      name: "Core node has recipe",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-assets.csv"),
      [
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(artifactPath, "01-custom-nodes.md"),
      [
        "| Node type | Source package or repo | Installed/source evidence | State | Human action |",
        "| --- | --- | --- | --- | --- |",
        "| TextEncodeBooguEdit | comfy-core | comfy-core (missing locally) | source unknown | Provide upstream commit or legacy package |",
        ""
      ].join("\n"),
      "utf8"
    );

    let discoverCalls = 0;
    await ensureAssetAcquisitionJob({
      task,
      modelRoots: [path.join(root, "models")],
      comfyuiRoot: path.join(root, "ComfyUI"),
      humanContext: "",
      redactedHumanContext: "",
      recipesRoot,
      sourceSearch: async () => ({
        config: {
          profileName: "test",
          enableNetworkSearch: true,
          allowInsecureTls: false,
          requestTimeoutSeconds: 1,
          maxResultsPerProvider: 1,
          huggingFaceEndpoint: "https://huggingface.co",
          modelScopeEndpoint: "https://modelscope.cn",
          hasHuggingFaceToken: false,
          hasCivitaiToken: false,
          hasGitHubToken: false,
          proxyConfigured: false,
          enableDownload: false,
          explicitHuggingFaceFiles: [],
          huggingFaceFallbackEndpoints: [],
          tokenEnvNames: { huggingface: [], civitai: [], github: [] },
          proxyEnvNames: []
        },
        issues: [],
        candidates: []
      }),
      discoverCoreNodeRecipe: async () => {
        discoverCalls += 1;
        throw new Error("should not be called when a recipe already exists");
      }
    });

    expect(discoverCalls).toBe(0);
  });
});

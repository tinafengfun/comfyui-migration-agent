import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSourceProviderConfig,
  executeCandidateDownload,
  extractHuggingFaceFileSources,
  searchAssetSourceProviders,
  type AssetSourceCandidate,
  type SourceProvider
} from "./assetSourceProviders";

describe("asset source providers", () => {
  it("searches model providers through API adapters and creates token-safe download commands", async () => {
    const config = {
      ...buildSourceProviderConfig({
        NODE_ENV: "production",
        ASSET_SOURCE_SEARCH: "1",
        HF_TOKEN: "present",
        CIVITAI_TOKEN: "present",
        HF_ENDPOINT: "https://hf-mirror.example"
      }),
      requestTimeoutSeconds: 1,
      maxResultsPerProvider: 2
    };
    const responseByProvider: Record<string, unknown> = {
      huggingface: [{
        modelId: "owner/z_image_bf16",
        siblings: [{ rfilename: "z_image_bf16.safetensors", lfs: { size: 123, sha256: "a".repeat(64) } }]
      }],
      modelscope: { data: [{ modelId: "owner/z-image-modelscope" }] },
      civitai: { items: [{ id: 123, name: "moodyPornMix" }] }
    };

    const result = await searchAssetSourceProviders({
      query: "z_image_bf16",
      assetName: "z_image_bf16.safetensors",
      kind: "model",
      targetPath: "/models/diffusion_models/z_image_bf16.safetensors",
      config,
      httpJson: async (_url: string, provider: SourceProvider) => responseByProvider[provider] ?? {}
    });

    expect(result.candidates.map((candidate) => candidate.provider)).toContain("huggingface");
    expect(result.candidates.map((candidate) => candidate.provider)).toContain("modelscope");
    expect(result.candidates.map((candidate) => candidate.provider)).toContain("civitai");
    const hf = result.candidates.find((candidate) => candidate.provider === "huggingface");
    expect(hf?.downloadCommand?.join(" ")).toContain("${HF_TOKEN}");
    expect(hf?.downloadCommand?.join(" ")).not.toContain("present");
    expect(hf?.downloadCommand?.join(" ")).toContain("/models/diffusion_models/z_image_bf16.safetensors");
  });

  it("uses demo download profile defaults for HF, Civitai, GitHub, Comfy.ICU, proxy, and token placeholders", async () => {
    const config = buildSourceProviderConfig({
      NODE_ENV: "production",
      MIGRATION_AGENT_DOWNLOAD_PROFILE: "demo",
      HUGGING_FACE_HUB_TOKEN: "hf-secret",
      CIVITAI_API_TOKEN: "civitai-secret",
      GH_TOKEN: "github-secret"
    });

    expect(config.profileName).toBe("demo");
    expect(config.huggingFaceEndpoint).toBe("https://hf-mirror.com");
    expect(config.huggingFaceFallbackEndpoints).toContain("https://huggingface.co");
    expect(config.modelScopeEndpoint).toBe("https://www.modelscope.cn");
    expect(config.enableNetworkSearch).toBe(true);
    expect(config.enableDownload).toBe(true);
    expect(config.proxyConfigured).toBe(true);
    expect(config.proxySource).toBe("ASSET_DOWNLOAD_PROXY");
    expect(config.hasHuggingFaceToken).toBe(true);
    expect(config.hasCivitaiToken).toBe(true);
    expect(config.hasGitHubToken).toBe(true);
    expect(config.tokenEnvNames.huggingface).toContain("HUGGING_FACE_HUB_TOKEN");
    expect(config.tokenEnvNames.civitai).toContain("CIVITAI_TOKEN");
    expect(config.tokenEnvNames.github).toContain("GITHUB_TOKEN");

    const modelResult = await searchAssetSourceProviders({
      query: "demoCivitai",
      assetName: "demo.safetensors",
      kind: "model",
      targetPath: "/models/checkpoints/demo.safetensors",
      config,
      httpJson: async (_url: string, provider: SourceProvider) =>
        provider === "civitai"
          ? {
              items: [
                {
                  id: 456,
                  name: "demoCivitai",
                  modelVersions: [
                    {
                      files: [
                        {
                          name: "demo.safetensors",
                          sizeKB: 2,
                          downloadUrl: "https://civitai.com/api/download/models/456",
                          hashes: { SHA256: "B".repeat(64) }
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          : []
    });
    const civitai = modelResult.candidates.find((candidate) => candidate.provider === "civitai");
    const civitaiCommand = civitai?.downloadCommand?.join(" ") ?? "";
    expect(civitaiCommand).toContain("${CIVITAI_TOKEN}");
    expect(civitaiCommand).toContain("${ASSET_DOWNLOAD_PROXY}");
    expect(civitaiCommand).not.toContain("civitai-secret");
    expect(civitaiCommand).not.toContain("127.0.0.1:7890");
    expect(civitai?.sha256).toBe("b".repeat(64));

    const customNodeResult = await searchAssetSourceProviders({
      query: "custom node",
      kind: "custom_node",
      config,
      httpJson: async (_url: string, provider: SourceProvider) =>
        provider === "github"
          ? { items: [{ full_name: "owner/custom-node", html_url: "https://github.com/owner/custom-node" }] }
          : {}
    });
    expect(customNodeResult.candidates.map((candidate) => candidate.provider)).toContain("github");
    expect(customNodeResult.candidates.map((candidate) => candidate.provider)).toContain("comfyicu");
  });

  it("creates explicit HuggingFace direct and mirror candidates from operator context", async () => {
    const sources = extractHuggingFaceFileSources(
      "model path:https://huggingface.co/pengshun/zimage/blob/main/moodyPornMix_v10DPO.safetensors"
    );
    const config = {
      ...buildSourceProviderConfig({
        NODE_ENV: "production",
        ASSET_SOURCE_SEARCH: "1",
        HF_TOKEN: "present",
        https_proxy: "http://proxy.example:913"
      }),
      requestTimeoutSeconds: 1,
      maxResultsPerProvider: 3,
      explicitHuggingFaceFiles: sources,
      huggingFaceFallbackEndpoints: ["https://hf-mirror.com"]
    };

    const result = await searchAssetSourceProviders({
      query: "moodyPornMix_v10DPO",
      assetName: "moodyPornMix_v10DPO.safetensors",
      kind: "model",
      targetPath: "/models/diffusion_models/moodyPornMix_v10DPO.safetensors",
      config,
      httpJson: async (url: string) =>
        url.includes("/api/models/pengshun/zimage")
          ? {
              siblings: [
                {
                  rfilename: "moodyPornMix_v10DPO.safetensors",
                  lfs: {
                    size: 12309880080,
                    sha256: "2f462069f619335a8d831fbdc3fc44c188e3edb6234ce91e8acaf82d679501e7"
                  }
                }
              ]
            }
          : []
    });

    const commands = result.candidates.map((candidate) => candidate.downloadCommand?.join(" ") ?? "");
    expect(commands.some((command) => command.includes("huggingface.co/pengshun/zimage/resolve/main/moodyPornMix_v10DPO.safetensors"))).toBe(true);
    expect(commands.some((command) => command.includes("hf-mirror.com/pengshun/zimage/resolve/main/moodyPornMix_v10DPO.safetensors"))).toBe(true);
    expect(commands.every((command) => !command.includes("present"))).toBe(true);
    expect(result.candidates.find((candidate) => candidate.url.includes("hf-mirror.com"))?.sha256).toBe(
      "2f462069f619335a8d831fbdc3fc44c188e3edb6234ce91e8acaf82d679501e7"
    );
  });

  it("infers exact HuggingFace files from ComfyUI custom-node ckpts target paths", async () => {
    const config = {
      ...buildSourceProviderConfig({
        NODE_ENV: "production",
        ASSET_SOURCE_SEARCH: "1",
        HF_ENDPOINT: "https://hf-mirror.example"
      }),
      requestTimeoutSeconds: 1,
      maxResultsPerProvider: 3,
      huggingFaceFallbackEndpoints: ["https://huggingface.co"]
    };

    const result = await searchAssetSourceProviders({
      query: "dw-ll_ucoco_384_bs5.torchscript",
      assetName: "dw-ll_ucoco_384_bs5.torchscript.pt",
      kind: "model",
      targetPath:
        "/workspace/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt",
      config,
      httpJson: async (url: string, provider: SourceProvider) => {
        if (provider === "huggingface" && url.includes("/api/models/hr16/DWPose-TorchScript-BatchSize5")) {
          return {
            siblings: [
              {
                rfilename: "dw-ll_ucoco_384_bs5.torchscript.pt",
                lfs: { size: 135059124, sha256: "c".repeat(64) }
              }
            ]
          };
        }
        return provider === "civitai" ? { items: [] } : [];
      }
    });

    const hfCandidates = result.candidates.filter((candidate) => candidate.provider === "huggingface");
    expect(hfCandidates.map((candidate) => candidate.downloadUrl)).toContain(
      "https://hf-mirror.example/hr16/DWPose-TorchScript-BatchSize5/resolve/main/dw-ll_ucoco_384_bs5.torchscript.pt"
    );
    expect(hfCandidates.map((candidate) => candidate.downloadUrl)).toContain(
      "https://huggingface.co/hr16/DWPose-TorchScript-BatchSize5/resolve/main/dw-ll_ucoco_384_bs5.torchscript.pt"
    );
    expect(hfCandidates[0]?.downloadCommand?.join(" ")).toContain(
      "/workspace/ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt"
    );
    expect(hfCandidates[0]?.sha256).toBe("c".repeat(64));
    expect(result.candidates.map((candidate) => candidate.provider)).toContain("github");
  });

  it("searches custom-node providers through GitHub and Comfy.ICU fallback", async () => {
    const config = {
      ...buildSourceProviderConfig({ NODE_ENV: "production", ASSET_SOURCE_SEARCH: "1" }),
      maxResultsPerProvider: 2
    };

    const result = await searchAssetSourceProviders({
      query: "seedvr2_videoupscaler",
      kind: "custom_node",
      config,
      httpJson: async (_url: string, provider: SourceProvider) =>
        provider === "github"
          ? { items: [{ full_name: "owner/seedvr2_videoupscaler", html_url: "https://github.com/owner/seedvr2_videoupscaler" }] }
          : {}
    });

    expect(result.candidates.map((candidate) => candidate.provider)).toContain("github");
    expect(result.candidates.map((candidate) => candidate.provider)).toContain("comfyicu");
  });

  it("executes a curl download command to a target file", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("download-ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unexpected test server address");
      const targetPath = path.join(process.cwd(), ".demo-state", "tests", `download-${Date.now()}`, "file.bin");
      const candidate: AssetSourceCandidate = {
        provider: "huggingface",
        title: "local test download",
        url: `http://127.0.0.1:${address.port}/file.bin`,
        downloadUrl: `http://127.0.0.1:${address.port}/file.bin`,
        score: 100,
        requiresToken: false,
        notes: "test",
        downloadCommand: [
          "curl",
          "-L",
          "--fail",
          "--retry",
          "1",
          "--continue-at",
          "-",
          "--output",
          targetPath,
          `http://127.0.0.1:${address.port}/file.bin`
        ]
      };

      const result = await executeCandidateDownload(candidate);

      expect(result.targetPath).toBe(targetPath);
      expect(await fs.readFile(targetPath, "utf8")).toBe("download-ok");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

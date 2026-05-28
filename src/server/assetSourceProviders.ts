import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const demoDownloadProfileName = "demo";
const demoDefaultProxyUrl = "http://127.0.0.1:7890";
const demoSourceProviderDefaults: NodeJS.ProcessEnv = {
  ASSET_ACQUISITION_ENABLE_DOWNLOAD: "1",
  ASSET_SOURCE_MAX_RESULTS: "5",
  ASSET_SOURCE_SEARCH: "1",
  ASSET_SOURCE_TIMEOUT_SECONDS: "30",
  HF_ENDPOINT: "https://hf-mirror.com",
  HF_FALLBACK_ENDPOINTS: "https://huggingface.co",
  MODELSCOPE_ENDPOINT: "https://www.modelscope.cn"
};
export const huggingFaceTokenEnvNames = [
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HF_MIRROR_TOKEN",
  "HF_ACCESS_TOKEN"
] as const;
export const civitaiTokenEnvNames = ["CIVITAI_TOKEN", "CIVITAI_API_TOKEN"] as const;
export const githubTokenEnvNames = ["GITHUB_TOKEN", "GH_TOKEN"] as const;
export const proxyEnvNames = [
  "ASSET_DOWNLOAD_PROXY",
  "MIGRATION_AGENT_DOWNLOAD_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy"
] as const;

export type SourceProvider =
  | "huggingface"
  | "modelscope"
  | "github"
  | "civitai"
  | "comfyicu"
  | "ssh_remote";
type HttpJson = (url: string, provider: SourceProvider) => Promise<unknown>;
type ProviderSearchFn = (
  input: SearchInput,
  config: SourceProviderConfig,
  httpJson: HttpJson
) => Promise<AssetSourceCandidate[]>;

export interface AssetSourceCandidate {
  provider: SourceProvider;
  title: string;
  url: string;
  apiUrl?: string;
  downloadUrl?: string;
  sizeBytes?: number;
  sha256?: string;
  score: number;
  requiresToken: boolean;
  notes: string;
  downloadCommand?: string[];
}

export interface ProviderSearchIssue {
  provider: SourceProvider;
  message: string;
}

export interface SourceProviderConfig {
  profileName: string;
  enableNetworkSearch: boolean;
  allowInsecureTls: boolean;
  requestTimeoutSeconds: number;
  maxResultsPerProvider: number;
  huggingFaceEndpoint: string;
  modelScopeEndpoint: string;
  hasHuggingFaceToken: boolean;
  hasCivitaiToken: boolean;
  hasGitHubToken: boolean;
  proxyConfigured: boolean;
  proxySource?: string;
  proxyUrl?: string;
  enableDownload: boolean;
  explicitHuggingFaceFiles: HuggingFaceFileSource[];
  huggingFaceFallbackEndpoints: string[];
  tokenEnvNames: {
    huggingface: string[];
    civitai: string[];
    github: string[];
  };
  proxyEnvNames: string[];
}

export interface HuggingFaceFileSource {
  endpoint: string;
  repoId: string;
  revision: string;
  filename: string;
  filePath?: string;
  sourceUrl: string;
  provenance?: string;
}

export interface SearchInput {
  query: string;
  assetName?: string;
  kind: "model" | "custom_node";
  targetPath?: string;
  config?: SourceProviderConfig;
  httpJson?: (url: string, provider: SourceProvider) => Promise<unknown>;
}

export interface SearchResult {
  candidates: AssetSourceCandidate[];
  issues: ProviderSearchIssue[];
  config: SourceProviderConfig;
}

export function buildSourceProviderConfig(env: NodeJS.ProcessEnv = process.env): SourceProviderConfig {
  const effectiveEnv = sourceProviderEnv(env);
  const proxy = proxyEntry(effectiveEnv);
  const huggingFaceEndpoint = stripTrailingSlash(
    effectiveEnv.HF_ENDPOINT ?? effectiveEnv.HUGGINGFACE_ENDPOINT ?? "https://hf-mirror.com"
  );
  const huggingFaceFallbackEndpoints = (effectiveEnv.HF_FALLBACK_ENDPOINTS ?? defaultHuggingFaceFallbacks(huggingFaceEndpoint))
    .split(",")
    .map(stripTrailingSlash);
  return {
    profileName: activeDownloadProfileName(env),
    enableNetworkSearch:
      effectiveEnv.ASSET_SOURCE_SEARCH === "1" ||
      (effectiveEnv.ASSET_SOURCE_SEARCH !== "0" && effectiveEnv.NODE_ENV !== "test"),
    allowInsecureTls: effectiveEnv.ASSET_SOURCE_INSECURE_TLS === "1",
    requestTimeoutSeconds: Number(effectiveEnv.ASSET_SOURCE_TIMEOUT_SECONDS ?? "12"),
    maxResultsPerProvider: Number(effectiveEnv.ASSET_SOURCE_MAX_RESULTS ?? "5"),
    huggingFaceEndpoint,
    modelScopeEndpoint: stripTrailingSlash(effectiveEnv.MODELSCOPE_ENDPOINT ?? "https://www.modelscope.cn"),
    hasHuggingFaceToken: Boolean(huggingFaceToken(effectiveEnv)),
    hasCivitaiToken: Boolean(civitaiToken(effectiveEnv)),
    hasGitHubToken: Boolean(githubToken(effectiveEnv)),
    proxyUrl: proxy?.value,
    proxySource: proxy?.name,
    proxyConfigured: Boolean(proxy?.value),
    enableDownload: isAssetDownloadEnabled(env),
    explicitHuggingFaceFiles: [],
    huggingFaceFallbackEndpoints: uniqueStrings(huggingFaceFallbackEndpoints),
    tokenEnvNames: {
      huggingface: [...huggingFaceTokenEnvNames],
      civitai: [...civitaiTokenEnvNames],
      github: [...githubTokenEnvNames]
    },
    proxyEnvNames: [...proxyEnvNames]
  };
}

export function isDemoDownloadProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIGRATION_AGENT_DOWNLOAD_PROFILE === demoDownloadProfileName || env.MIGRATION_AGENT_DEMO_DOWNLOAD_PROFILE === "1";
}

export function isAssetDownloadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return sourceProviderEnv(env).ASSET_ACQUISITION_ENABLE_DOWNLOAD === "1";
}

export function sourceProviderEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const effectiveEnv: NodeJS.ProcessEnv = isDemoDownloadProfile(env)
    ? { ...demoSourceProviderDefaults, ...env }
    : { ...env };
  if (isDemoDownloadProfile(effectiveEnv) && !proxyEntry(effectiveEnv) && effectiveEnv.MIGRATION_AGENT_DEMO_PROXY !== "0") {
    effectiveEnv.ASSET_DOWNLOAD_PROXY = effectiveEnv.MIGRATION_AGENT_DEMO_PROXY_URL ?? demoDefaultProxyUrl;
  }
  return normalizeDownloadEnv(effectiveEnv);
}

export function normalizeDownloadEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = { ...env };
  const hfToken = huggingFaceToken(normalized);
  if (hfToken) normalized.HF_TOKEN ??= hfToken;
  const civitai = civitaiToken(normalized);
  if (civitai) normalized.CIVITAI_TOKEN ??= civitai;
  const github = githubToken(normalized);
  if (github) normalized.GITHUB_TOKEN ??= github;
  const proxy = proxyEntry(normalized);
  if (proxy?.value) {
    normalized.ASSET_DOWNLOAD_PROXY ??= proxy.value;
    normalized.HTTPS_PROXY ??= proxy.value;
    normalized.HTTP_PROXY ??= proxy.value;
    normalized.https_proxy ??= proxy.value;
    normalized.http_proxy ??= proxy.value;
    const noProxy = mergeNoProxy(normalized.NO_PROXY ?? normalized.no_proxy, ["127.0.0.1", "localhost", "::1"]);
    normalized.NO_PROXY = noProxy;
    normalized.no_proxy = noProxy;
  }
  return normalized;
}

export function extractHuggingFaceFileSources(context: string): HuggingFaceFileSource[] {
  const sources: HuggingFaceFileSource[] = [];
  const pattern = /https:\/\/(?:huggingface\.co|hf-mirror\.com)\/([^/\s`'")]+\/[^/\s`'")]+)\/(?:blob|resolve)\/([^/\s`'")]+)\/([^\s`'")]+)/g;
  for (const match of context.matchAll(pattern)) {
    const endpoint = stripTrailingSlash(new URL(match[0]).origin);
    const filePath = match[3].replace(/[),.;，。]+$/g, "");
    const filename = decodeURIComponent(path.basename(filePath));
    sources.push({
      endpoint,
      repoId: match[1],
      revision: match[2],
      filename,
      filePath,
      sourceUrl: `${endpoint}/${match[1]}/resolve/${match[2]}/${encodePathSegments(filePath)}`
    });
  }
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.endpoint}/${source.repoId}/${source.revision}/${sourceFilePath(source)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchAssetSourceProviders(input: SearchInput): Promise<SearchResult> {
  const config = input.config ?? buildSourceProviderConfig();
  const httpJson = input.httpJson ?? ((url, provider) => curlJson(url, provider, config));
  const candidates: AssetSourceCandidate[] = [];
  const issues: ProviderSearchIssue[] = [];

  if (!config.enableNetworkSearch) {
    return {
      candidates,
      issues: [{ provider: "huggingface", message: "Network provider search disabled by ASSET_SOURCE_SEARCH or test mode." }],
      config
    };
  }

  const providers: Array<[SourceProvider, ProviderSearchFn]> =
    input.kind === "model"
      ? [
          ["huggingface", searchHuggingFace],
          ["github", searchGitHub],
          ["modelscope", searchModelScope],
          ["civitai", searchCivitai]
        ]
      : [
          ["github", searchGitHub],
          ["comfyicu", searchComfyIcu]
        ];
  for (const [providerName, provider] of providers) {
    try {
      candidates.push(...(await provider(input, config, httpJson)));
    } catch (error) {
      issues.push({
        provider: providerName,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    candidates: rankCandidates(input.query, candidates).slice(0, config.maxResultsPerProvider * providers.length),
    issues,
    config
  };
}

export async function executeCandidateDownload(
  candidate: AssetSourceCandidate,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ targetPath: string; stdout: string; stderr: string }> {
  if (!candidate.downloadCommand?.length) {
    throw new Error(`Candidate has no download command: ${candidate.title}`);
  }
  const [binary, ...rawArgs] = candidate.downloadCommand;
  if (binary !== "curl") {
    throw new Error(`Unsupported download command: ${binary}`);
  }
  const runtimeEnv = sourceProviderEnv(env);
  const args = rawArgs.map((arg) => substituteEnvPlaceholders(arg, runtimeEnv));
  const outputIndex = args.indexOf("--output");
  const targetPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!targetPath) throw new Error("Download command is missing --output target path.");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const { stdout, stderr } = await execFileAsync(binary, args, {
    maxBuffer: 1024 * 1024,
    env: runtimeEnv
  });
  return { targetPath, stdout, stderr };
}

async function searchHuggingFace(
  input: SearchInput,
  config: SourceProviderConfig,
  httpJson: HttpJson
): Promise<AssetSourceCandidate[]> {
  const explicitCandidates = await searchExplicitHuggingFaceFiles(input, config, httpJson);
  const apiUrl = `${config.huggingFaceEndpoint}/api/models?search=${encodeURIComponent(input.query)}&limit=${config.maxResultsPerProvider}&full=true`;
  const response = await httpJson(apiUrl, "huggingface").catch(() => []);
  if (!Array.isArray(response)) return explicitCandidates;
  return [
    ...explicitCandidates,
    ...response.flatMap((item) => {
      const modelId = stringField(item, "modelId") || stringField(item, "id");
      if (!modelId) return [];
      const exactSibling = input.assetName ? siblingForFile(item, input.assetName) : undefined;
      const url = `${config.huggingFaceEndpoint}/${modelId}`;
      return [
        withDownloadCommand(
          {
            provider: "huggingface",
            title: modelId,
            url,
            apiUrl,
            downloadUrl: input.assetName && exactSibling
              ? `${config.huggingFaceEndpoint}/${modelId}/resolve/main/${encodeURIComponent(input.assetName)}`
              : undefined,
            sizeBytes: exactSibling?.sizeBytes,
            sha256: exactSibling?.sha256,
            score: scoreText(input.query, modelId),
            requiresToken: config.hasHuggingFaceToken,
            notes: exactSibling
              ? "HuggingFace model API search result with exact filename metadata."
              : "HuggingFace model API search result; exact filename was not present in returned metadata, so automatic download is disabled."
          },
          input,
          config
        )
      ];
    })
  ];
}

async function searchExplicitHuggingFaceFiles(
  input: SearchInput,
  config: SourceProviderConfig,
  httpJson: HttpJson
): Promise<AssetSourceCandidate[]> {
  if (!input.assetName) return [];
  const sources = uniqueHuggingFaceFileSources([
    ...config.explicitHuggingFaceFiles,
    ...inferHuggingFaceFileSources(input, config)
  ]).filter((source) => source.filename === input.assetName);
  const candidates: AssetSourceCandidate[] = [];
  for (const source of sources) {
    const metadata = await huggingFaceFileMetadata(source, config, httpJson);
    for (const endpoint of uniqueStrings([source.endpoint, ...config.huggingFaceFallbackEndpoints])) {
      const downloadUrl = `${endpoint}/${source.repoId}/resolve/${source.revision}/${encodePathSegments(sourceFilePath(source))}`;
      candidates.push(
        withDownloadCommand(
          {
            provider: "huggingface",
            title: `${source.repoId}/${sourceFilePath(source)}${endpoint === source.endpoint ? "" : ` via ${new URL(endpoint).hostname}`}`,
            url: `${endpoint}/${source.repoId}`,
            apiUrl: `${endpoint}/api/models/${source.repoId}`,
            downloadUrl,
            sizeBytes: metadata?.sizeBytes,
            sha256: metadata?.sha256,
            score: 120,
            requiresToken: config.hasHuggingFaceToken,
            notes:
              endpoint === source.endpoint
                ? (source.provenance ?? "Explicit HuggingFace file source from operator context.")
                : `${source.provenance ?? "Explicit HuggingFace file source"} using fallback endpoint after direct HuggingFace route is unavailable.`
          },
          input,
          config
        )
      );
    }
  }
  return candidates;
}

async function huggingFaceFileMetadata(
  source: HuggingFaceFileSource,
  config: SourceProviderConfig,
  httpJson: HttpJson
): Promise<{ sizeBytes?: number; sha256?: string } | undefined> {
  for (const endpoint of uniqueStrings([config.huggingFaceEndpoint, source.endpoint, ...config.huggingFaceFallbackEndpoints])) {
    try {
      const response = await httpJson(`${endpoint}/api/models/${source.repoId}?blobs=true`, "huggingface");
      return siblingForFile(response, sourceFilePath(source)) ?? siblingForFile(response, source.filename);
    } catch {
      // Metadata is best-effort; candidate execution can still attempt the exact source URL.
    }
  }
  return undefined;
}

function inferHuggingFaceFileSources(input: SearchInput, config: SourceProviderConfig): HuggingFaceFileSource[] {
  if (!input.assetName || !input.targetPath) return [];
  const normalizedTarget = input.targetPath.replaceAll("\\", "/");
  const filename = path.posix.basename(normalizedTarget);
  if (filename !== input.assetName) return [];
  const parts = normalizedTarget.split("/").filter(Boolean);
  const ckptsIndex = parts.lastIndexOf("ckpts");
  if (ckptsIndex < 0 || parts.length < ckptsIndex + 4) return [];
  const [owner, repo, ...fileParts] = parts.slice(ckptsIndex + 1);
  if (!owner || !repo || fileParts.at(-1) !== filename) return [];
  if (!isSafeHuggingFaceRepoPart(owner) || !isSafeHuggingFaceRepoPart(repo)) return [];
  const filePath = fileParts.join("/");
  return [{
    endpoint: config.huggingFaceEndpoint,
    repoId: `${owner}/${repo}`,
    revision: "main",
    filename,
    filePath,
    sourceUrl: `${config.huggingFaceEndpoint}/${owner}/${repo}/resolve/main/${encodePathSegments(filePath)}`,
    provenance: "Inferred HuggingFace file source from ComfyUI custom-node ckpts target path."
  }];
}

function uniqueHuggingFaceFileSources(sources: HuggingFaceFileSource[]): HuggingFaceFileSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.endpoint}/${source.repoId}/${source.revision}/${sourceFilePath(source)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceFilePath(source: HuggingFaceFileSource): string {
  return source.filePath || source.filename;
}

function isSafeHuggingFaceRepoPart(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

async function searchModelScope(
  input: SearchInput,
  config: SourceProviderConfig,
  httpJson: HttpJson
): Promise<AssetSourceCandidate[]> {
  const apiUrl = `${config.modelScopeEndpoint}/api/v1/models?search=${encodeURIComponent(input.query)}&pageNumber=1&pageSize=${config.maxResultsPerProvider}`;
  const response = await httpJson(apiUrl, "modelscope");
  const rows = Array.isArray(response)
    ? response
    : Array.isArray((response as { data?: unknown[] })?.data)
      ? (response as { data: unknown[] }).data
      : Array.isArray((response as { Data?: { Models?: unknown[] } })?.Data?.Models)
        ? (response as { Data: { Models: unknown[] } }).Data.Models
        : [];
  return rows.flatMap((item) => {
    const modelId =
      stringField(item, "modelId") ||
      stringField(item, "name") ||
      stringField(item, "Name") ||
      stringField(item, "Path");
    if (!modelId) return [];
    const url = `${config.modelScopeEndpoint}/models/${modelId}`;
    return [
      withDownloadCommand(
        {
          provider: "modelscope",
          title: modelId,
          url,
          apiUrl,
          score: scoreText(input.query, modelId),
          requiresToken: false,
          notes: "ModelScope API search result; use modelscope/hub snapshot APIs or model-specific file API for exact download."
        },
        input,
        config
      )
    ];
  });
}

async function searchCivitai(
  input: SearchInput,
  config: SourceProviderConfig,
  httpJson: HttpJson
): Promise<AssetSourceCandidate[]> {
  const apiUrl = `https://civitai.com/api/v1/models?query=${encodeURIComponent(input.query)}&limit=${config.maxResultsPerProvider}`;
  const response = await httpJson(apiUrl, "civitai");
  const rows = Array.isArray((response as { items?: unknown[] })?.items) ? (response as { items: unknown[] }).items : [];
  return rows.flatMap((item) => {
    const name = stringField(item, "name");
    const id = numberField(item, "id");
    if (!name || id === undefined) return [];
    const exactFile = input.assetName ? civitaiExactFile(item, input.assetName) : undefined;
    return [
      withDownloadCommand(
        {
          provider: "civitai",
          title: name,
          url: `https://civitai.com/models/${id}`,
          apiUrl,
          downloadUrl: exactFile?.downloadUrl,
          sizeBytes: exactFile?.sizeBytes,
          sha256: exactFile?.sha256,
          score: scoreText(input.query, name),
          requiresToken: config.hasCivitaiToken,
          notes: exactFile
            ? "Civitai model API exact file match. Token, if configured, is referenced by environment-variable placeholder."
            : "Civitai model API search result; version/file selection is required before exact download."
        },
        input,
        config
      )
    ];
  });
}

function civitaiExactFile(
  item: unknown,
  assetName: string
): { downloadUrl?: string; sizeBytes?: number; sha256?: string } | undefined {
  if (!item || typeof item !== "object") return undefined;
  const versions = (item as { modelVersions?: unknown[] }).modelVersions;
  if (!Array.isArray(versions)) return undefined;
  for (const version of versions) {
    if (!version || typeof version !== "object") continue;
    const files = (version as { files?: unknown[] }).files;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (stringField(file, "name") !== assetName) continue;
      const sizeKB = numberField(file, "sizeKB");
      const sizeBytes =
        numberField(file, "sizeBytes") ??
        numberField(file, "size") ??
        (sizeKB !== undefined ? Math.round(sizeKB * 1024) : undefined);
      return {
        downloadUrl: stringField(file, "downloadUrl") ?? stringField(file, "url"),
        sizeBytes,
        sha256: sha256Field(file)
      };
    }
  }
  return undefined;
}

async function searchGitHub(
  input: SearchInput,
  config: SourceProviderConfig,
  httpJson: HttpJson
): Promise<AssetSourceCandidate[]> {
  if (input.kind === "model" && input.assetName) {
    const query = `"${input.assetName}" in:file`;
    const webUrl = `https://github.com/search?q=${encodeURIComponent(query)}&type=code`;
    const fallback: AssetSourceCandidate = {
      provider: "github",
      title: `GitHub code search: ${input.assetName}`,
      url: webUrl,
      score: 5,
      requiresToken: false,
      notes: "Exact filename GitHub code-search fallback. Use it to find source registry references; binary download still requires a verified provider URL or local staging."
    };
    if (!config.hasGitHubToken) return [fallback];

    const apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${config.maxResultsPerProvider}`;
    const response = await httpJson(apiUrl, "github");
    const rows = Array.isArray((response as { items?: unknown[] })?.items) ? (response as { items: unknown[] }).items : [];
    return [
      ...rows.flatMap((item) => {
        const htmlUrl = stringField(item, "html_url");
        const filePath = stringField(item, "path");
        const repository = isObjectRecord(item) ? item.repository : undefined;
        const fullName = stringField(repository, "full_name");
        if (!htmlUrl || !filePath || !fullName) return [];
        return [{
          provider: "github" as const,
          title: `${fullName}/${filePath}`,
          url: htmlUrl,
          apiUrl,
          score: scoreText(input.assetName ?? input.query, `${fullName} ${filePath}`),
          requiresToken: true,
          notes: "GitHub code search exact filename reference; inspect the linked source to identify the canonical provider/repo before download."
        }];
      }),
      fallback
    ];
  }

  const apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(input.query)}&per_page=${config.maxResultsPerProvider}`;
  const response = await httpJson(apiUrl, "github");
  const rows = Array.isArray((response as { items?: unknown[] })?.items) ? (response as { items: unknown[] }).items : [];
  return rows.flatMap((item) => {
    const fullName = stringField(item, "full_name");
    const htmlUrl = stringField(item, "html_url");
    if (!fullName || !htmlUrl) return [];
    return [
      {
        provider: "github",
        title: fullName,
        url: htmlUrl,
        apiUrl,
        score: scoreText(input.query, fullName),
        requiresToken: config.hasGitHubToken,
        notes: "GitHub repository search result for custom-node source acquisition."
      }
    ];
  });
}

async function searchComfyIcu(input: SearchInput, config: SourceProviderConfig, _httpJson: HttpJson): Promise<AssetSourceCandidate[]> {
  const url = `https://comfy.icu/search?q=${encodeURIComponent(input.query)}`;
  const candidates: AssetSourceCandidate[] = [
    {
      provider: "comfyicu",
      title: `Comfy.ICU search: ${input.query}`,
      url,
      score: 1,
      requiresToken: false,
      notes: "Comfy.ICU has no stable public JSON API configured here; use this URL as a custom-node discovery fallback."
    }
  ];
  return candidates.slice(0, config.maxResultsPerProvider);
}

async function curlJson(url: string, provider: SourceProvider, config: SourceProviderConfig): Promise<unknown> {
  const runtimeEnv = normalizeDownloadEnv({
    ...process.env,
    ...(config.proxyUrl ? { ASSET_DOWNLOAD_PROXY: config.proxyUrl } : {})
  });
  const args = [
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--connect-timeout",
    String(Math.min(config.requestTimeoutSeconds, 10)),
    "--max-time",
    String(config.requestTimeoutSeconds),
    "-H",
    "Accept: application/json",
    url
  ];
  const tokenHeader = providerApiAuthHeader(provider, runtimeEnv);
  if (tokenHeader) args.splice(args.length - 1, 0, "-H", tokenHeader);
  if (config.allowInsecureTls) args.unshift("--insecure");
  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 1024 * 1024,
    env: {
      ...runtimeEnv
    }
  });
  return JSON.parse(stdout) as unknown;
}

function withDownloadCommand(
  candidate: AssetSourceCandidate,
  input: SearchInput,
  config: SourceProviderConfig
): AssetSourceCandidate {
  if (!candidate.downloadUrl || !input.targetPath) return candidate;
  const headers =
    candidate.provider === "huggingface" && config.hasHuggingFaceToken
      ? ["-H", "Authorization: Bearer ${HF_TOKEN}"]
      : candidate.provider === "civitai" && config.hasCivitaiToken
        ? ["-H", "Authorization: Bearer ${CIVITAI_TOKEN}"]
        : [];
  return {
    ...candidate,
    downloadCommand: [
      "curl",
      "-L",
      "--fail",
      "--retry",
      "10",
      "--retry-delay",
      "10",
      "--connect-timeout",
      "30",
      "--speed-time",
      "180",
      "--speed-limit",
      "1024",
      "--continue-at",
      "-",
      ...(config.allowInsecureTls || (candidate.provider === "huggingface" && config.proxyConfigured) ? ["--insecure"] : []),
      ...(config.proxyConfigured ? ["--proxy", "${ASSET_DOWNLOAD_PROXY}"] : []),
      ...headers,
      "--output",
      input.targetPath,
      candidate.downloadUrl
    ],
    notes: `${candidate.notes} curl honors HTTPS_PROXY/HTTP_PROXY/ALL_PROXY and CURL_CA_BUNDLE/NODE_EXTRA_CA_CERTS at execution time.`
  };
}

function siblingForFile(value: unknown, filename: string): { sizeBytes?: number; sha256?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const siblings = (value as { siblings?: unknown[] }).siblings;
  if (!Array.isArray(siblings)) return undefined;
  const sibling = siblings.find((entry) => stringField(entry, "rfilename") === filename);
  if (!sibling || typeof sibling !== "object") return undefined;
  const lfs = (sibling as { lfs?: { sha256?: unknown; size?: unknown } }).lfs;
  const sizeBytes = typeof lfs?.size === "number" ? lfs.size : numberField(sibling, "size");
  const sha256 = typeof lfs?.sha256 === "string" ? lfs.sha256 : undefined;
  return { sizeBytes, sha256 };
}

function rankCandidates(query: string, candidates: AssetSourceCandidate[]): AssetSourceCandidate[] {
  return [...candidates].sort((left, right) => right.score - left.score || left.provider.localeCompare(right.provider));
}

function scoreText(query: string, value: string): number {
  const normalizedQuery = normalize(query);
  const normalizedValue = normalize(value);
  if (!normalizedQuery || !normalizedValue) return 0;
  if (normalizedValue === normalizedQuery) return 100;
  if (normalizedValue.includes(normalizedQuery)) return 80;
  const queryTokens = new Set(normalizedQuery.split(" ").filter(Boolean));
  const valueTokens = new Set(normalizedValue.split(" ").filter(Boolean));
  let score = 0;
  for (const token of queryTokens) if (valueTokens.has(token)) score += 10;
  return score;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return typeof item[field] === "string" ? item[field] : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return typeof item[field] === "number" ? item[field] : undefined;
}

function sha256Field(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const hashes = (value as { hashes?: Record<string, unknown> }).hashes;
  const sha = hashes?.SHA256 ?? hashes?.sha256 ?? (value as Record<string, unknown>).sha256;
  return typeof sha === "string" ? sha.toLowerCase() : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function encodePathSegments(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map(stripTrailingSlash))];
}

function activeDownloadProfileName(env: NodeJS.ProcessEnv): string {
  if (isDemoDownloadProfile(env)) return demoDownloadProfileName;
  return env.MIGRATION_AGENT_DOWNLOAD_PROFILE || "default";
}

function tokenFromEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function proxyEntry(env: NodeJS.ProcessEnv): { name: string; value: string } | undefined {
  for (const name of proxyEnvNames) {
    const value = env[name];
    if (value) return { name, value };
  }
  return undefined;
}

function mergeNoProxy(current: string | undefined, required: string[]): string {
  return uniqueStrings([...(current?.split(",") ?? []), ...required].map((item) => item.trim())).join(",");
}

function substituteEnvPlaceholders(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => env[name] ?? "");
}

function defaultHuggingFaceFallbacks(primaryEndpoint: string): string {
  const endpoints = primaryEndpoint === "https://hf-mirror.com"
    ? ["https://huggingface.co"]
    : ["https://hf-mirror.com", "https://huggingface.co"];
  return endpoints.filter((endpoint) => endpoint !== primaryEndpoint).join(",");
}

function huggingFaceToken(env: NodeJS.ProcessEnv): string | undefined {
  return tokenFromEnv(env, huggingFaceTokenEnvNames);
}

function civitaiToken(env: NodeJS.ProcessEnv): string | undefined {
  return tokenFromEnv(env, civitaiTokenEnvNames);
}

function githubToken(env: NodeJS.ProcessEnv): string | undefined {
  return tokenFromEnv(env, githubTokenEnvNames);
}

function providerApiAuthHeader(provider: SourceProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (provider === "huggingface") {
    const token = huggingFaceToken(env);
    return token ? `Authorization: Bearer ${token}` : undefined;
  }
  if (provider === "civitai") {
    const token = civitaiToken(env);
    return token ? `Authorization: Bearer ${token}` : undefined;
  }
  if (provider === "github") {
    const token = githubToken(env);
    return token ? `Authorization: Bearer ${token}` : undefined;
  }
  return undefined;
}

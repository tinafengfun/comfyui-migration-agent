import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationTask } from "../shared/types";
import { ensureDir } from "./fsUtils";
import { SubJobManager } from "./subJobs";

describe("sub job manager", () => {
  const originalDownloadFlag = process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD;
  const originalDownloadProfile = process.env.MIGRATION_AGENT_DOWNLOAD_PROFILE;

  afterEach(() => {
    if (originalDownloadFlag === undefined) {
      delete process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD;
    } else {
      process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = originalDownloadFlag;
    }
    if (originalDownloadProfile === undefined) {
      delete process.env.MIGRATION_AGENT_DOWNLOAD_PROFILE;
    } else {
      process.env.MIGRATION_AGENT_DOWNLOAD_PROFILE = originalDownloadProfile;
    }
  });

  it("lists provider, custom-node, and download sub-jobs from an acquisition artifact", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const stagedPath = path.join(root, "models", "present.safetensors");
    await ensureDir(path.dirname(stagedPath));
    await fs.writeFile(stagedPath, "present", "utf8");
    const task: MigrationTask = {
      id: "task-subjobs",
      name: "Subjobs",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-acquisition-job.json"),
      JSON.stringify(
        {
          status: "waiting_for_secure_download",
          providerCandidateCount: 1,
          customNodeCandidateCount: 1,
          items: [
            {
              assetName: "present.safetensors",
              status: "already_staged",
              resolvedPath: stagedPath
            },
            {
              assetName: "missing.safetensors",
              status: "pending_secure_download",
              targetPath: path.join(root, "models", "missing.safetensors"),
              candidates: [
                {
                  provider: "huggingface",
                  title: "owner/missing",
                  url: "https://hf.example/owner/missing",
                  downloadCommand: ["curl", "-L", "--output", path.join(root, "models", "missing.safetensors"), "https://hf.example/file"]
                }
              ]
            },
            {
              assetName: "remote.safetensors",
              status: "pending_secure_download",
              targetPath: path.join(root, "models", "remote.safetensors"),
              candidates: [
                {
                  provider: "ssh_remote",
                  title: "intel@remote:/models/remote.safetensors",
                  url: "ssh://remote/models/remote.safetensors",
                  sizeBytes: 123,
                  downloadCommand: ["scp", "intel@remote:/models/remote.safetensors", path.join(root, "models", "remote.safetensors")]
                }
              ]
            }
          ],
          customNodeItems: [
            {
              packageHint: "seedvr2_videoupscaler",
              status: "candidate_sources_found",
              candidates: [{ provider: "github", title: "owner/seedvr2", url: "https://github.com/owner/seedvr2" }]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const manager = new SubJobManager();
    const jobs = await manager.listTaskSubJobs(task);

    expect(jobs.find((job) => job.id === "01-provider-discovery")?.candidateCount).toBe(2);
    expect(jobs.find((job) => job.type === "custom_node_search")?.status).toBe("completed");
    expect(jobs.find((job) => job.assetName === "present.safetensors")?.progress?.percent).toBe(100);
    const missing = jobs.find((job) => job.assetName === "missing.safetensors");
    expect(missing?.status).toBe("pending");
    expect(missing?.canStart).toBe(false);
    expect(missing?.progress?.downloadedBytes).toBe(0);
    const remote = jobs.find((job) => job.assetName === "remote.safetensors");
    expect(remote?.status).toBe("pending");
    expect(remote?.provider).toBe("ssh_remote");
    expect(remote?.candidateCount).toBe(1);
  });

  it("reports the provider-discovery sub-job as blocked (not completed) when items remain unresolved", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-unresolved-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task-subjobs-unresolved",
      name: "Subjobs unresolved",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-acquisition-job.json"),
      JSON.stringify(
        {
          status: "waiting_for_secure_download",
          providerCandidateCount: 0,
          customNodeCandidateCount: 0,
          unresolvedCount: 2,
          items: []
        },
        null,
        2
      ),
      "utf8"
    );

    const manager = new SubJobManager();
    const jobs = await manager.listTaskSubJobs(task);
    const discovery = jobs.find((job) => job.id === "01-provider-discovery");
    expect(discovery?.status).toBe("blocked");
    expect(discovery?.message).toContain("2 item(s) remain unresolved");
  });

  it("allows download sub-jobs through the demo download profile", async () => {
    delete process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD;
    process.env.MIGRATION_AGENT_DOWNLOAD_PROFILE = "demo";
    const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-demo-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task-subjobs-demo",
      name: "Subjobs demo",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-acquisition-job.json"),
      JSON.stringify(
        {
          status: "waiting_for_secure_download",
          providerCandidateCount: 1,
          items: [
            {
              assetName: "demo.safetensors",
              status: "pending_secure_download",
              targetPath: path.join(root, "models", "demo.safetensors"),
              candidates: [
                {
                  provider: "civitai",
                  title: "demo",
                  url: "https://civitai.com/models/1",
                  downloadCommand: [
                    "curl",
                    "-L",
                    "--proxy",
                    "${ASSET_DOWNLOAD_PROXY}",
                    "--output",
                    path.join(root, "models", "demo.safetensors"),
                    "https://civitai.com/api/download/models/1"
                  ]
                }
              ]
            }
          ],
          customNodeItems: []
        },
        null,
        2
      ),
      "utf8"
    );

    const manager = new SubJobManager();
    const pending = (await manager.listTaskSubJobs(task)).find((job) => job.assetName === "demo.safetensors");

    expect(pending?.canStart).toBe(true);
  });

  it("tries all executable candidates and completes on the first valid download", async () => {
    process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = "1";
    const server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "11" });
        res.end("download-ok");
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unexpected test server address");
      const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-download-${Date.now()}`);
      const artifactPath = path.join(root, "artifacts");
      const targetPath = path.join(root, "models", "missing.safetensors");
      await ensureDir(artifactPath);
      const task: MigrationTask = {
        id: "task-subjobs-download",
        name: "Subjobs download",
        status: "waiting_for_human",
        workflowPath: path.join(root, "workflow.json"),
        workspacePath: root,
        artifactPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [{ id: "01", status: "waiting_for_human" }]
      };
      await fs.writeFile(
        path.join(artifactPath, "01-acquisition-job.json"),
        JSON.stringify(
          {
            status: "waiting_for_secure_download",
            providerCandidateCount: 2,
            items: [
              {
                assetName: "missing.safetensors",
                status: "pending_secure_download",
                targetPath,
                candidates: [
                  {
                    provider: "huggingface",
                    title: "direct failing source",
                    url: `http://127.0.0.1:${address.port}/missing`,
                    downloadCommand: [
                      "curl",
                      "-L",
                      "--fail",
                      "--output",
                      targetPath,
                      `http://127.0.0.1:${address.port}/missing`
                    ]
                  },
                  {
                    provider: "huggingface",
                    title: "mirror working source",
                    url: `http://127.0.0.1:${address.port}/ok`,
                    sizeBytes: 11,
                    downloadCommand: [
                      "curl",
                      "-L",
                      "--fail",
                      "--output",
                      targetPath,
                      `http://127.0.0.1:${address.port}/ok`
                    ]
                  }
                ]
              }
            ],
            customNodeItems: []
          },
          null,
          2
        ),
        "utf8"
      );
      // Same regression fixture as the suggested-url test below — the fix
      // lives in the shared completion path, so the pre-existing
      // provider-candidate download route must also update the ledger now.
      await fs.writeFile(
        path.join(artifactPath, "01-assets.csv"),
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap\n" +
          '"missing.safetensors","missing.safetensors","","","source unknown","","","","","","missing","unresolved","none","false","not staged"\n',
        "utf8"
      );
      await fs.writeFile(
        path.join(artifactPath, "01-gate-signal.json"),
        JSON.stringify({ items: [{ name: "missing.safetensors", kind: "model asset", action: "provide" }] }, null, 2),
        "utf8"
      );
      const manager = new SubJobManager();
      const pending = (await manager.listTaskSubJobs(task)).find((job) => job.assetName === "missing.safetensors");
      expect(pending?.canStart).toBe(true);

      await manager.startSubJob(task, pending!.id);
      const completed = await waitForSubJobStatus(manager, task, pending!.id, "completed");

      expect(completed.provider).toBe("huggingface");
      expect(completed.progress?.downloadedBytes).toBe(11);
      expect(await fs.readFile(targetPath, "utf8")).toBe("download-ok");

      const csv = await fs.readFile(path.join(artifactPath, "01-assets.csv"), "utf8");
      expect(csv).toContain("human_provided");
      await expect(fs.readFile(path.join(artifactPath, "01-gate-signal.json"), "utf8")).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("startSubJobForSuggestedUrl downloads a human-approved fuzzyJudgment.suggestedUrl end-to-end", async () => {
    process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = "1";
    const server = http.createServer((req, res) => {
      if (req.url === "/suggested") {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "13" });
        res.end("suggested-src");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unexpected test server address");
      const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-suggested-${Date.now()}`);
      const artifactPath = path.join(root, "artifacts");
      const targetPath = path.join(root, "models", "suggested.safetensors");
      await ensureDir(artifactPath);
      const task: MigrationTask = {
        id: "task-subjobs-suggested",
        name: "Subjobs suggested",
        status: "waiting_for_human",
        workflowPath: path.join(root, "workflow.json"),
        workspacePath: root,
        artifactPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [{ id: "01", status: "waiting_for_human" }]
      };
      // Note: no `candidates` array at all here -- fuzzyJudgment.suggestedUrl
      // never went through the structured provider-search pipeline, only
      // `targetPath` is required for startSubJobForSuggestedUrl to work.
      await fs.writeFile(
        path.join(artifactPath, "01-acquisition-job.json"),
        JSON.stringify(
          {
            status: "waiting_for_secure_download",
            items: [
              {
                assetName: "suggested.safetensors",
                status: "pending_secure_download",
                targetPath
              }
            ],
            customNodeItems: []
          },
          null,
          2
        ),
        "utf8"
      );
      // Regression fixture for the real bug this closes: a completed
      // download used to leave 01-assets.csv/the gate-signal file untouched,
      // so the web UI showed the item as resolved (client-only optimism)
      // while Step 01's own gate still considered it an open gap.
      await fs.writeFile(
        path.join(artifactPath, "01-assets.csv"),
        "asset_name,requested_name,resolved_path,source,state,staged_path,custom_node_repo,custom_node_cache_path,wrapper_source_evidence,commit,install_status,acquisition_status,mirror_used,credential_recorded,gap\n" +
          '"suggested.safetensors","suggested.safetensors","","","source unknown","","","","","","missing","unresolved","none","false","not staged"\n',
        "utf8"
      );
      await fs.writeFile(
        path.join(artifactPath, "01-gate-signal.json"),
        JSON.stringify({ items: [{ name: "suggested.safetensors", kind: "model asset", action: "provide" }] }, null, 2),
        "utf8"
      );

      const manager = new SubJobManager();
      const started = await manager.startSubJobForSuggestedUrl(
        task,
        "suggested.safetensors",
        `http://127.0.0.1:${address.port}/suggested`
      );
      expect(started.status).toBe("running");

      const completed = await waitForSubJobStatus(manager, task, started.id, "completed");
      expect(completed.provider).toBe("suggested-url");
      expect(completed.progress?.downloadedBytes).toBe(13);
      expect(await fs.readFile(targetPath, "utf8")).toBe("suggested-src");

      // The actual regression check: ledger + gate-signal must reflect
      // resolution, not just the in-memory SubJob status above.
      const csv = await fs.readFile(path.join(artifactPath, "01-assets.csv"), "utf8");
      expect(csv).toContain("human_provided");
      expect(csv).toContain(",present,complete,");
      await expect(fs.readFile(path.join(artifactPath, "01-gate-signal.json"), "utf8")).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("startSubJobForSuggestedUrl rejects a non-http(s) URL without touching the download-enabled gate", async () => {
    process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = "1";
    const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-suggested-bad-url-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task-subjobs-suggested-bad",
      name: "Subjobs suggested bad url",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    const manager = new SubJobManager();
    await expect(
      manager.startSubJobForSuggestedUrl(task, "whatever.safetensors", "not-a-url")
    ).rejects.toThrow(/http/i);
  });

  it("startSubJobForSuggestedUrl refuses when download execution is disabled", async () => {
    delete process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD;
    delete process.env.MIGRATION_AGENT_DOWNLOAD_PROFILE;
    const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-suggested-disabled-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task-subjobs-suggested-disabled",
      name: "Subjobs suggested disabled",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    const manager = new SubJobManager();
    await expect(
      manager.startSubJobForSuggestedUrl(task, "whatever.safetensors", "https://example.com/file.safetensors")
    ).rejects.toThrow(/disabled/i);
  });

  it("rejects a 200-OK HTML error page masquerading as the requested binary asset", async () => {
    // Regression test for a real incident: a suggested-source URL redirected
    // to a live HTML page (HuggingFace's own generic page, HTTP 200) instead
    // of 404ing outright. Without sizeBytes/sha256 to check against (true for
    // any LLM-suggested URL, which never went through structured provider
    // search), the old validateDownloadedFile had nothing to catch this with.
    process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = "1";
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><head><title>Not Found</title></head><body>nope</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unexpected test server address");
      const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-html-masquerade-${Date.now()}`);
      const artifactPath = path.join(root, "artifacts");
      const targetPath = path.join(root, "models", "corrupt.safetensors");
      await ensureDir(artifactPath);
      const task: MigrationTask = {
        id: "task-subjobs-html-masquerade",
        name: "Subjobs html masquerade",
        status: "waiting_for_human",
        workflowPath: path.join(root, "workflow.json"),
        workspacePath: root,
        artifactPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [{ id: "01", status: "waiting_for_human" }]
      };
      await fs.writeFile(
        path.join(artifactPath, "01-acquisition-job.json"),
        JSON.stringify(
          { status: "waiting_for_secure_download", items: [{ assetName: "corrupt.safetensors", status: "pending_secure_download", targetPath }], customNodeItems: [] },
          null,
          2
        ),
        "utf8"
      );
      const manager = new SubJobManager();
      const started = await manager.startSubJobForSuggestedUrl(task, "corrupt.safetensors", `http://127.0.0.1:${address.port}/dead-link`);
      expect(started.status).toBe("running");

      const failed = await waitForSubJobStatus(manager, task, started.id, "waiting_for_human");
      expect(failed.error).toContain("HTML page");
      // Must not be left on disk as if it were a real asset, and must not be
      // silently accepted into the ledger.
      await expect(fs.readFile(targetPath, "utf8")).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("surfaces a human gate after every download candidate fails", async () => {
    process.env.ASSET_ACQUISITION_ENABLE_DOWNLOAD = "1";
    const root = path.join(process.cwd(), ".demo-state", "tests", `subjobs-fail-${Date.now()}`);
    const artifactPath = path.join(root, "artifacts");
    const targetPath = path.join(root, "models", "missing.safetensors");
    await ensureDir(artifactPath);
    const task: MigrationTask = {
      id: "task-subjobs-fail",
      name: "Subjobs fail",
      status: "waiting_for_human",
      workflowPath: path.join(root, "workflow.json"),
      workspacePath: root,
      artifactPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: "01", status: "waiting_for_human" }]
    };
    await fs.writeFile(
      path.join(artifactPath, "01-acquisition-job.json"),
      JSON.stringify(
        {
          status: "waiting_for_secure_download",
          providerCandidateCount: 1,
          items: [
            {
              assetName: "missing.safetensors",
              status: "pending_secure_download",
              targetPath,
              candidates: [
                {
                  provider: "huggingface",
                  title: "unreachable source",
                  url: "http://127.0.0.1:1/missing",
                  downloadCommand: ["curl", "-L", "--fail", "--max-time", "1", "--output", targetPath, "http://127.0.0.1:1/missing"]
                }
              ]
            }
          ],
          customNodeItems: []
        },
        null,
        2
      ),
      "utf8"
    );
    const manager = new SubJobManager();
    const pending = (await manager.listTaskSubJobs(task)).find((job) => job.assetName === "missing.safetensors");

    await manager.startSubJob(task, pending!.id);
    const gated = await waitForSubJobStatus(manager, task, pending!.id, "waiting_for_human");

    expect(gated.error).toContain("All 1 download candidate");
    expect(await fs.stat(targetPath).catch(() => undefined)).toBeUndefined();
  });
});

async function waitForSubJobStatus(
  manager: SubJobManager,
  task: MigrationTask,
  subJobId: string,
  status: string
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = (await manager.listTaskSubJobs(task)).find((entry) => entry.id === subJobId);
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for subjob ${subJobId} to reach ${status}`);
}

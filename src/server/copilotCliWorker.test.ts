import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config";
import { runCopilotCliWorker } from "./copilotCliWorker";
import { ensureDir } from "./fsUtils";

describe("Copilot CLI worker", () => {
  it("writes prompt and log artifacts around a controlled CLI subprocess", async () => {
    const root = path.join(process.cwd(), ".demo-state", "tests", `cli-worker-${Date.now()}`);
    await ensureDir(root);
    const fakeCli = path.join(root, "fake-copilot.sh");
    await fs.writeFile(
      fakeCli,
      "#!/usr/bin/env bash\nset -euo pipefail\necho 'fake cli received:'\ncat -\n",
      { mode: 0o755 }
    );
    await fs.chmod(fakeCli, 0o755);

    const config: AppConfig = {
      port: 0,
      projectRoot: root,
      workspaceRoot: root,
      stateRoot: root,
      draftDocRoot: root,
      comfyuiRoot: "/tmp/comfy",
      modelRoots: ["/home/intel/hf_models"],
      copilotCliPath: fakeCli,
      autoApproveAgentPermissions: false
    };

    const events: string[] = [];
    const result = await runCopilotCliWorker(
      config,
      {
        taskId: "task",
        stepId: "00",
        stepName: "Intake",
        workspacePath: root,
        artifactPath: path.join(root, "artifacts"),
        workflowPath: path.join(root, "workflow.json"),
        modelRoots: config.modelRoots,
        comfyuiRoot: config.comfyuiRoot,
        instructions: "Do the step",
        constraints: ["Do not bypass nodes."],
        requiredContext: {},
        expectedArtifacts: ["00-intake-preflight.md"],
        humanGates: [],
        hardStopRules: []
      },
      async (event) => {
        events.push(event.type);
      }
    );

    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(result.promptPath, "utf8")).toContain("Structured StepJob");
    expect(await fs.readFile(result.logPath, "utf8")).toContain("fake cli received");
    expect(events).toContain("progress");
    expect(events).toContain("step_summary");
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationTask } from "../shared/types";

interface WorkflowNode {
  id?: number | string;
  type?: string;
  mode?: number;
  inputs?: Array<{ name?: string; type?: string; link?: number | null }>;
  outputs?: Array<{ name?: string; type?: string; links?: Array<number | null> | null }>;
  properties?: Record<string, unknown>;
  widgets_values?: unknown[];
}

interface WorkflowGraph {
  nodes?: WorkflowNode[];
  links?: unknown[];
}

export interface WorkflowInventoryResult {
  artifactPath: string;
  nodeCount: number;
  linkCount: number;
  outputNodes: string[];
}

export async function ensureWorkflowInventory(task: MigrationTask, stepId = "03"): Promise<WorkflowInventoryResult> {
  const workflow = JSON.parse(await fs.readFile(task.workflowPath, "utf8")) as WorkflowGraph;
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const links = Array.isArray(workflow.links) ? workflow.links : [];
  const artifactPath = path.join(task.artifactPath, `${stepId}-inventory.md`);
  const outputNodes = nodes.filter((node) => isOutputNode(node.type)).map(formatNodeRef);
  const typeCounts = countBy(nodes.map((node) => node.type ?? "(unknown)"));
  const packageCounts = countBy(
    nodes.map((node) => packageHint(node)).filter((value): value is string => Boolean(value))
  );
  const linkedNodeIds = linkedIds(nodes);
  const disconnected = nodes.filter((node) => !linkedNodeIds.has(String(node.id ?? "")));
  const activeNodes = nodes.filter((node) => linkedNodeIds.has(String(node.id ?? "")));
  const modelWidgets = extractModelWidgets(nodes);

  const content = [
    `# ${stepId} - Workflow inventory`,
    "",
    `task_id: \`${task.id}\``,
    `workflow: \`${task.workflowPath}\``,
    `artifact_folder: \`${task.artifactPath}\``,
    "",
    "## Status",
    "",
    "Backend deterministic workflow inventory complete. The source workflow was parsed only; no ComfyUI run was started, no dependencies were installed, and no nodes were bypassed, deleted, collapsed, replaced, or rewired.",
    "",
    "## Graph summary",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Node count | ${nodes.length} |`,
    `| Link count | ${links.length} |`,
    `| Linked/active nodes | ${activeNodes.length} |`,
    `| Disconnected/utility nodes | ${disconnected.length} |`,
    `| Output/display nodes | ${outputNodes.length ? outputNodes.join(", ") : "none detected"} |`,
    "",
    "## Node type counts",
    "",
    "| Node type | Count |",
    "| --- | ---: |",
    ...[...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, count]) => `| ${cell(type)} | ${count} |`),
    "",
    "## Custom-node/package hints",
    "",
    "| Package/source hint | Count |",
    "| --- | ---: |",
    ...([...packageCounts.entries()].length
      ? [...packageCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([hint, count]) => `| ${cell(hint)} | ${count} |`)
      : ["| none | 0 |"]),
    "",
    "## Output and branch candidates",
    "",
    "| Node | Reason |",
    "| --- | --- |",
    ...(outputNodes.length
      ? outputNodes.map((node) => `| ${cell(node)} | output/display/media node |`)
      : ["| none detected | - |"]),
    "",
    "## Model/widget references",
    "",
    "| Node | Widget value |",
    "| --- | --- |",
    ...(modelWidgets.length
      ? modelWidgets.map((item) => `| ${cell(item.node)} | ${cell(item.value)} |`)
      : ["| none detected | - |"]),
    "",
    "## Disconnected or utility-looking nodes",
    "",
    "| Node | Reason |",
    "| --- | --- |",
    ...(disconnected.length
      ? disconnected.map((node) => `| ${cell(formatNodeRef(node))} | no linked inputs or outputs detected |`)
      : ["| none detected | - |"]),
    "",
    "## Node inventory",
    "",
    "| ID | Type | Package/source hint | Linked? | Inputs | Outputs |",
    "| --- | --- | --- | --- | ---: | ---: |",
    ...nodes.map((node) => {
      const id = String(node.id ?? "?");
      return `| ${cell(id)} | ${cell(node.type ?? "(unknown)")} | ${cell(packageHint(node) ?? "")} | ${linkedNodeIds.has(id) ? "yes" : "no"} | ${node.inputs?.length ?? 0} | ${node.outputs?.length ?? 0} |`;
    }),
    "",
    "## Recommended next step",
    "",
    "Continue to source audit using this inventory plus `00-intake-preflight.md`, asset/custom-node resolution, and feasibility evidence. Preserve all source nodes and keep missing source-identical assets documented as migration blockers or smoke-only risks.",
    ""
  ].join("\n");

  await fs.writeFile(artifactPath, content, "utf8");
  return {
    artifactPath,
    nodeCount: nodes.length,
    linkCount: links.length,
    outputNodes
  };
}

function linkedIds(nodes: WorkflowNode[]): Set<string> {
  const result = new Set<string>();
  for (const node of nodes) {
    const id = String(node.id ?? "");
    const inputLinked = (node.inputs ?? []).some((input) => input.link !== null && input.link !== undefined);
    const outputLinked = (node.outputs ?? []).some((output) => (output.links ?? []).some((link) => link !== null));
    if (inputLinked || outputLinked || isOutputNode(node.type)) result.add(id);
  }
  return result;
}

function extractModelWidgets(nodes: WorkflowNode[]): Array<{ node: string; value: string }> {
  const modelPattern = /\.(safetensors|ckpt|pt|pth|onnx|gguf|bin)$/i;
  const rows: Array<{ node: string; value: string }> = [];
  for (const node of nodes) {
    for (const value of node.widgets_values ?? []) {
      if (typeof value === "string" && modelPattern.test(value)) {
        rows.push({ node: formatNodeRef(node), value });
      }
    }
  }
  return rows.sort((a, b) => a.node.localeCompare(b.node));
}

function isOutputNode(type?: string): boolean {
  return /save|preview|output|video/i.test(String(type ?? ""));
}

function formatNodeRef(node: WorkflowNode): string {
  return `${node.id ?? "?"}:${node.type ?? "(unknown)"}`;
}

function packageHint(node: WorkflowNode): string | undefined {
  const properties = node.properties ?? {};
  const hint = properties.cnr_id ?? properties.aux_id;
  return typeof hint === "string" && hint ? hint : undefined;
}

function countBy(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://172.16.114.105:5173";
const API = "http://127.0.0.1:3001";

let taskId: string;

test.describe.configure({ mode: "serial" });

test.describe("Migration Agent E2E", () => {

  // Ensure a task exists for UI tests
  test("setup: create task via API", async ({ request }) => {
    // Check if there's already a task
    const listRes = await request.get(`${API}/api/tasks`);
    const listBody = await listRes.json();
    if (listBody.tasks && listBody.tasks.length > 0) {
      taskId = listBody.tasks[0].id;
      return;
    }
    // Create a minimal task
    const res = await request.post(`${API}/api/tasks`, {
      headers: { "Content-Type": "application/json" },
      data: {
        workflowFileName: "e2e-setup.json",
        workflowJson: { nodes: [], links: [], groups: [], config: {}, extra: {} },
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    taskId = body.task.id;
  });

  test("page loads with correct title and header", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator("h1")).toHaveText("XPU Migration Agent");
    await expect(page.locator(".health-dot")).toBeVisible();
  });

  test("tasks panel shows existing tasks", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator(".task-list h3")).toHaveText("Tasks");
    const items = page.locator(".task-item");
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("pipeline steps are rendered", async ({ page }) => {
    await page.goto(BASE);
    await page.locator(".task-item").first().click({ force: true });
    await page.waitForTimeout(200);
    const nodes = page.locator(".pipeline-node");
    const count = await nodes.count();
    expect(count).toBeGreaterThanOrEqual(7);
  });

  test("clicking a task selects it and shows step detail", async ({ page }) => {
    await page.goto(BASE);
    const tasks = page.locator(".task-item");
    const count = await tasks.count();
    if (count > 1) {
      await tasks.nth(1).click({ force: true });
    } else {
      await tasks.first().click({ force: true });
    }
    await expect(page.locator(".step-detail")).toBeVisible();
    await expect(page.locator(".step-detail h2")).toBeVisible();
  });

  test("clicking a pipeline step changes detail", async ({ page }) => {
    await page.goto(BASE);
    await page.locator(".task-item").first().click({ force: true });
    await page.waitForTimeout(200);
    await page.locator(".pipeline-node").nth(1).click();
    await expect(page.locator(".step-detail h2")).toContainText("Step 01");
  });

  test("step detail shows correct action buttons by status", async ({ page }) => {
    await page.goto(BASE);
    await page.locator(".task-item").first().click({ force: true });
    const btnTexts = await page.locator(".step-detail-actions .btn").allTextContents();
    const validLabels = ["Run", "Resume", "Re-run", "Starting...", "Resuming...", "Re-running..."];
    for (const t of btnTexts) {
      expect(validLabels).toContain(t);
    }
  });

  test("header Run pipeline / Stop buttons exist", async ({ page }) => {
    await page.goto(BASE);
    await page.locator(".task-item").first().click({ force: true });
    const runBtn = page.locator("header .header-actions .btn-primary");
    const stopBtn = page.locator("header .header-actions .btn-danger");
    await expect(runBtn).toBeVisible();
    await expect(stopBtn).toBeVisible();
  });

  test("artifacts tab switches view", async ({ page }) => {
    await page.goto(BASE);
    await page.locator(".task-item").first().click({ force: true });
    await page.locator(".tab", { hasText: "Artifacts" }).click();
    await expect(page.locator(".artifact-browser")).toBeVisible();
  });

  test("API health endpoint returns ok", async ({ request }) => {
    const resp = await request.get(`${API}/api/health`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.comfyuiRoot).toBeDefined();
  });

  test("API tasks endpoint returns array", async ({ request }) => {
    const resp = await request.get(`${API}/api/tasks`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(Array.isArray(body.tasks)).toBeTruthy();
  });

  test("API steps endpoint returns definitions", async ({ request }) => {
    const resp = await request.get(`${API}/api/steps`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.steps.length).toBeGreaterThanOrEqual(7);
  });
});

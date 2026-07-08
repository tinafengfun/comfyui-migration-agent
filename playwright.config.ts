import { defineConfig, devices } from "@playwright/test";

// Target a running migration agent. Override with PW_BASE_URL / PW_API when
// running against a different host (e.g. the deployed remote, or another port).
const BASE_URL = process.env.PW_BASE_URL ?? "http://172.16.114.105:5173";

// Default per-test timeout: enough for the fast UI tier. The migration tier
// overrides timeouts per-test (it drives a long-running pipeline).
const DEFAULT_TIMEOUT = Number(process.env.PW_TIMEOUT_MS ?? 30_000);

export default defineConfig({
  testDir: "./tests",
  // Specs are split into two tiers by tag, run via npm scripts:
  //   @ui        — fast, deterministic frontend GUI (no LLM/GPU)
  //   @migration — live Z-Image 双采 migration to the final step (long)
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    timeout: DEFAULT_TIMEOUT,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

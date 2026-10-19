import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "../tests/browser",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 15000 },
  reporter: "list",
  outputDir: "../.scratch/browser-results",
  use: {
    baseURL: "https://127.0.0.1:4173",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 1000 } },
    },
    { name: "phone", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: "python3 tools/test-reader.py",
    cwd: "..",
    url: "https://127.0.0.1:4173/health",
    ignoreHTTPSErrors: true,
    timeout: 30000,
    reuseExistingServer: false,
  },
});

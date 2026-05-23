// Playwright config for SAGE E2E tests.
// Serves docs/ on http://localhost:8787 and runs tests in headless Chromium.
const { defineConfig } = require("/usr/local/lib/node_modules/playwright/test.js");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8787",
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    actionTimeout: 6_000,
  },
  webServer: {
    command: "python3 -m http.server 8787 --directory docs",
    url: "http://localhost:8787/app/",
    reuseExistingServer: true,
    timeout: 10_000,
  },
});

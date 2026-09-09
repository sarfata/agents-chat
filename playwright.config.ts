import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    headless: true,
    ...(process.env.OAUTH_TEST_BROWSER_PATH
      ? { launchOptions: { executablePath: process.env.OAUTH_TEST_BROWSER_PATH } }
      : { channel: "chrome" })
  }
});

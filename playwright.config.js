import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: [["list"]],
  // The retry-with-redismiss logic under test can legitimately take up to
  // ~30s on its own (3 attempts x 10s click timeout) when a dialog never
  // closes, so the default 30s test timeout is too tight.
  timeout: 60_000,
  use: {
    headless: true,
  },
});

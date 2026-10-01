import { defineConfig } from '@playwright/test'

const port = 5198

/**
 * Without these, Chromium's GPU process tries the host's display server (e.g. WSLg's
 * Wayland in a dev container) even with a headless Ozone platform, and WebGL fails.
 */
const displayVariables = new Set(['WAYLAND_DISPLAY', 'DISPLAY'])
const browserEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !displayVariables.has(entry[0])),
)

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  // Each test loads the sample's whole view; the software renderer draws it slowly.
  timeout: 120_000,
  // Each test opens its own page, so the tests of one file can run at once. The default
  // workers, half the cores, leave cores to spare for each test's software GPU.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    launchOptions: {
      // WebGL through SwiftShader, so the tests need no GPU.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ozone-platform=headless'],
      env: browserEnv,
    },
  },
  webServer: {
    command: `vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/e2e/harness.html`,
    reuseExistingServer: !process.env.CI,
  },
})

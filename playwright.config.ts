import { defineConfig } from '@playwright/test'

// npm run test:ui: the window in each of its states, light and dark, compared with the screenshots
// in test/ui/screenshots (test/ui/window.spec.ts). It runs in Microsoft Edge as installed on
// Windows, GitHub's Windows runners included, so no browser has to be downloaded;
// PLAYWRIGHT_CHANNEL picks another one (chrome). The screenshots are Windows' own: fonts are drawn
// a little differently elsewhere.
export default defineConfig({
  testDir: 'test/ui',
  testMatch: '*.spec.ts',
  snapshotPathTemplate: '{testDir}/screenshots/{arg}-{platform}{ext}',
  outputDir: 'out/ui-results',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5179',
    channel: process.env['PLAYWRIGHT_CHANNEL'] ?? 'msedge',
    viewport: { width: 480, height: 820 },
    deviceScaleFactor: 1
  },
  // Room for the odd pixel of antialiasing that differs between two PCs.
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  webServer: {
    command: 'node scripts/ui.mjs',
    url: 'http://127.0.0.1:5179/',
    reuseExistingServer: !process.env['CI']
  }
})

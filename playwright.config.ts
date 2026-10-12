import { defineConfig, devices } from '@playwright/test'

// E2E runs against the production build. RPC traffic is mocked per test with
// page.route() / page.routeWebSocket(), so no network access is needed.
//
// Locally a preinstalled Chromium can be used with PLAYWRIGHT_CHROMIUM_PATH;
// in CI (unset) Playwright's own bundled browser is used
// (`npx playwright install --with-deps chromium`).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim() || undefined

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})

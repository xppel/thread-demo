import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5175/thread-demo/',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } },
    {
      name: 'webkit-audio',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 960 } },
    },
  ],
  webServer: {
    command: 'npm run preview -- --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175/thread-demo/',
    reuseExistingServer: false,
  },
  reporter: 'list',
});

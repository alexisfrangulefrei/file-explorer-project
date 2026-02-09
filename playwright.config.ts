import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'src/test/acceptance',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure'
  }
});

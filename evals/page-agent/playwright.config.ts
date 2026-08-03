import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { resolvePlaywrightArtifactsDir } from './report'

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: 'page-agent.eval.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  outputDir: resolvePlaywrightArtifactsDir(),
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npx vite --config evals/page-agent/vite.config.ts',
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    url: 'http://127.0.0.1:4173/?scenario=read-data',
    reuseExistingServer: true,
    timeout: 30_000
  }
})

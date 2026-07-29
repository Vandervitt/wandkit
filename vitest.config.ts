import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 各包的用例集中在根一次跑完，避免 CI 里逐包串行
    include: ['packages/*/src/**/*.spec.ts'],
    environment: 'node',
    environmentMatchGlobs: [
      // UI 包是 Web Components，需要 DOM
      ['packages/ui/**', 'jsdom'],
      ['packages/executor/**', 'jsdom'],
      ['packages/chat/**', 'jsdom']
    ]
  }
})

import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // 测试直接解析 workspace 源码，避免依赖 ignored dist 是否已提前构建。
    alias: [
      {
        find: /^wandkit$/,
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url))
      },
      {
        find: /^@wandkit\/ui$/,
        replacement: fileURLToPath(new URL('./packages/ui/src/index.ts', import.meta.url))
      },
      {
        find: /^@wandkit\/executor$/,
        replacement: fileURLToPath(new URL('./packages/executor/src/index.ts', import.meta.url))
      },
      {
        find: /^@wandkit\/chat\/ui$/,
        replacement: fileURLToPath(new URL('./packages/chat/src/ui.ts', import.meta.url))
      },
      {
        find: /^@wandkit\/chat\/bridge$/,
        replacement: fileURLToPath(new URL('./packages/chat/src/bridge.ts', import.meta.url))
      },
      {
        find: /^@wandkit\/chat$/,
        replacement: fileURLToPath(new URL('./packages/chat/src/index.ts', import.meta.url))
      },
      {
        find: /^@wandkit\/interceptor\/confirm-ui$/,
        replacement: fileURLToPath(new URL('./packages/interceptor/src/confirmUi.ts', import.meta.url))
      },
      {
        find: /^@wandkit\/interceptor$/,
        replacement: fileURLToPath(new URL('./packages/interceptor/src/index.ts', import.meta.url))
      }
    ]
  },
  test: {
    // 各包的用例集中在根一次跑完，避免 CI 里逐包串行
    include: [
      'packages/*/src/**/*.spec.ts',
      'evals/page-agent/**/*.spec.ts'
    ],
    exclude: [
      ...configDefaults.exclude,
      'evals/page-agent/**/*.eval.spec.ts'
    ],
    environment: 'node',
    environmentMatchGlobs: [
      // UI 包是 Web Components，需要 DOM
      ['packages/ui/**', 'jsdom'],
      ['packages/executor/**', 'jsdom'],
      ['packages/chat/**', 'jsdom'],
      ['packages/interceptor/**', 'jsdom'],
      ['packages/browser/**', 'jsdom'],
      ['evals/page-agent/site/**/*.spec.ts', 'jsdom']
    ]
  }
})

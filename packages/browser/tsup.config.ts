import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    'wandkit',
    '@wandkit/chat',
    '@wandkit/chat/ui',
    '@wandkit/chat/bridge',
    '@wandkit/executor',
    '@wandkit/interceptor',
    '@wandkit/interceptor/confirm-ui',
    '@wandkit/ui'
  ]
})

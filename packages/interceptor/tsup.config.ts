import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', 'confirm-ui': 'src/confirmUi.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['toolairlock', '@toolairlock/ui']
})

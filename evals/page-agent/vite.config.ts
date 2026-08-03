import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./site', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true
  }
})

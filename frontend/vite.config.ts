import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const here = process.cwd()

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@app': resolve(here, 'src'),
      '@shared': resolve(here, 'src/shared')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500
  },
  server: { host: '127.0.0.1', port: 5173 }
})

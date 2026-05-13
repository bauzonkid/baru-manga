import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const realRoot = path.resolve(__dirname)

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    preserveSymlinks: true
  },
  build: { outDir: 'dist' },
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      strict: false,
      allow: [realRoot, 'D:/manga-recap-test/app', 'D:/Claude AI/manga-recap-app']
    }
  }
})

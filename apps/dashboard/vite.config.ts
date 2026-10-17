import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const API_TARGET = process.env.DEV_API_TARGET ?? 'http://localhost:3000'
const proxy = {
  '/v1': { target: API_TARGET, changeOrigin: true },
  '/api': { target: API_TARGET, changeOrigin: true },
  '/readyz': { target: API_TARGET, changeOrigin: true },
  '/healthz': { target: API_TARGET, changeOrigin: true },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Túnel público temporário (cloudflared quick tunnel): a UI é servida na
    // mesma origem e as chamadas /v1|/api|/readyz são encaminhadas à API local,
    // evitando que o browser remoto tente acessar localhost:3000.
    allowedHosts: ['.trycloudflare.com'],
    proxy,
  },
})

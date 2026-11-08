import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api/auth': {
        target: import.meta.env.VITE_DASHBOARD_VERIFIER_AUTH_URL ?? 'http://localhost:3000/v1/auth/verifier',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/auth/, ''),
      },
      '/api': {
        target: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
      '/v1': {
        target: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})

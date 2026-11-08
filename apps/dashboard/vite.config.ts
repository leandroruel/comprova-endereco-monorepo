import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Um `.env` só para o repo: é o mesmo arquivo que os scripts do backend leem
  // (`tsx --env-file=.env`), na raiz. O Vite expõe ao cliente apenas o que
  // começa com `VITE_`, então os segredos do backend não vão para o bundle.
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/auth': {
        target: import.meta.env.VITE_DASHBOARD_ADMIN_AUTH_URL ?? 'http://localhost:3000/v1/auth/admin',
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

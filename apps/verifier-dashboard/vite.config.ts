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
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => {
          if (path.startsWith('/api/auth/')) {
            return path.replace('/api/auth/', '/v1/auth/verifier/')
          }
          return path
        },
      },
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // ponytail: dev-only proxy so the UI and API share an origin
    proxy: {
      '/upload': { target: 'http://localhost:3000', proxyTimeout: 0, timeout: 0 },
      '/progress': 'http://localhost:3000'
    }
  }
})

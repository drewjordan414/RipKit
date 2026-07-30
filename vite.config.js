import { spawn } from 'child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Start the API alongside the dev server, so `npm run dev` is the only command
// you need. Dev only — `configureServer` never runs during a build.
function apiServer () {
  let child = null

  const stop = () => {
    if (child && !child.killed) child.kill('SIGTERM')
    child = null
  }

  return {
    name: 'ripkit-api',
    configureServer () {
      child = spawn(process.execPath, ['server.js'], { stdio: 'inherit' })
      child.on('exit', (code) => {
        if (code) console.log(`\n[ripkit] API exited with code ${code} — is :3000 already in use?`)
      })
      process.once('exit', stop)
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.once(sig, () => { stop(); process.exit() })
      }
    },
    closeBundle: stop
  }
}

export default defineConfig({
  plugins: [react(), apiServer()],
  server: {
    // the UI and API share an origin in dev, same as they do in production
    proxy: {
      '/upload': 'http://localhost:3000',
      '/preview': 'http://localhost:3000',
      '/progress': 'http://localhost:3000',
      '/job': 'http://localhost:3000',
      // the archive is built on demand and can be large, so no read timeout
      '/download': { target: 'http://localhost:3000', proxyTimeout: 0, timeout: 0 },
      '/destination': 'http://localhost:3000',
      '/cancel': 'http://localhost:3000',
      '/art': 'http://localhost:3000'
    }
  }
})

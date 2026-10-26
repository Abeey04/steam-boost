// npm run dev: builds the app with source maps, runs it, and on every change builds again and
// restarts Electron. A development build reads its test settings from the environment (see
// src/main/testSeams.ts and the top of src/main/index.ts).
import { context } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { appTargets, copyStatic, root } from './build.mjs'

// The electron package's main export is the path to its binary.
const electron = createRequire(import.meta.url)('electron')

let child = null
let restartTimer = null

function launch() {
  child = spawn(electron, ['.'], { cwd: root, stdio: 'inherit' })
  child.on('exit', (code, signal) => {
    // Quit from the app (not restarted by us): stop watching too.
    if (child && !child.restarting) process.exit(code ?? (signal ? 1 : 0))
  })
}

function restart() {
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    copyStatic()
    if (child) {
      child.restarting = true
      child.kill()
    }
    launch()
  }, 150)
}

const rebuilt = {
  name: 'restart-electron',
  setup(builder) {
    builder.onEnd((result) => {
      if (result.errors.length === 0) restart()
    })
  }
}

const targets = appTargets(true)
for (const options of Object.values(targets)) {
  const watcher = await context({ ...options, plugins: [rebuilt] })
  await watcher.watch()
}
console.log('Watching src/ for changes. Ctrl+C stops.')

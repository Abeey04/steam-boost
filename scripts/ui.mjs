// npm run ui: the window, built, on made-up data in a browser, without Electron or Steam. Builds
// the renderer, then serves the playground (test/ui/index.html, every state side by side) and the
// window on its own (/window?scenario=setup), with test/ui/mock.js standing in for the preload
// API. The screenshot tests (npm run test:ui) start it the same way.
//
//   npm run ui                 http://127.0.0.1:5179
//   npm run ui -- --port 6000
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { appTargets, copyStatic, root } from './build.mjs'

const portFlag = process.argv.indexOf('--port')
const port = portFlag === -1 ? 5179 : Number(process.argv[portFlag + 1])
const ui = resolve(root, 'test/ui')
const renderer = resolve(root, 'out/renderer')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

await build(appTargets(false).renderer)
copyStatic()

createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  let file = null
  if (path === '/') file = join(ui, 'index.html')
  else if (path === '/window') file = join(ui, 'window.html')
  else if (path === '/mock.js') file = join(ui, 'mock.js')
  else if (path.startsWith('/renderer/')) {
    const inside = normalize(join(renderer, path.slice('/renderer/'.length)))
    if (inside.startsWith(renderer)) file = inside
  }
  try {
    if (!file) throw new Error('not found')
    const body = await readFile(file)
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    response.end(body)
  } catch {
    response.writeHead(404).end()
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`The window playground is on http://127.0.0.1:${port}. Ctrl+C stops it.`)
})

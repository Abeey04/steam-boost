// Builds Steam Boost with esbuild, into out/: the main process, the preload script and the window.
// The same script runs the tests and builds the command-line tool.
//
//   npm run build       out/main, out/preload, out/renderer (what electron-builder packages)
//   npm run dev         the same, rebuilt on every change, with Electron restarted (scripts/dev.mjs)
//   npm test            test/*.test.ts, bundled the same way, then run with node --test
//   npm run build:cli   out/cli/steam-boost-cli.mjs: the engine without the app, for Node 20+
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'out')

/** esbuild options for the app's three parts. `dev` keeps names and adds source maps. */
export function appTargets(dev = false) {
  const node = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: dev ? 'inline' : false,
    logLevel: 'warning'
  }
  return {
    main: {
      ...node,
      entryPoints: [resolve(root, 'src/main/index.ts')],
      outfile: resolve(out, 'main/index.js'),
      // koffi is a native module, loaded only on Linux (src/main/network/deviceBinding.ts).
      external: ['electron', 'koffi']
    },
    preload: {
      ...node,
      entryPoints: [resolve(root, 'src/preload/index.ts')],
      outfile: resolve(out, 'preload/index.js'),
      external: ['electron']
    },
    renderer: {
      bundle: true,
      platform: 'browser',
      // A classic script: the window is loaded from a file, where module scripts can be refused.
      format: 'iife',
      target: ['chrome120'],
      jsx: 'automatic',
      minify: !dev,
      sourcemap: dev ? 'inline' : false,
      define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
      // The window's look is the website's (docs/theme.css, which styles.css imports), typeface
      // included: Archivo goes next to the page as fonts/archivo-latin.woff2.
      loader: { '.woff2': 'file' },
      assetNames: 'fonts/[name]',
      entryPoints: [resolve(root, 'src/renderer/main.tsx')],
      outfile: resolve(out, 'renderer/index.js'),
      logLevel: 'warning'
    }
  }
}

/** The page the window loads, the font's licence (which goes wherever the font does), and the
 * tray and window icons the main process reads. */
export function copyStatic() {
  mkdirSync(resolve(out, 'renderer/fonts'), { recursive: true })
  cpSync(resolve(root, 'src/renderer/index.html'), resolve(out, 'renderer/index.html'))
  cpSync(resolve(root, 'docs/fonts/OFL.txt'), resolve(out, 'renderer/fonts/OFL.txt'))
  cpSync(resolve(root, 'resources'), resolve(out, 'main/assets'), { recursive: true })
}

async function buildApp() {
  rmSync(resolve(out, 'main'), { recursive: true, force: true })
  rmSync(resolve(out, 'preload'), { recursive: true, force: true })
  rmSync(resolve(out, 'renderer'), { recursive: true, force: true })
  const targets = appTargets(false)
  await Promise.all(Object.values(targets).map((options) => build(options)))
  copyStatic()
  console.log('Built out/main, out/preload and out/renderer.')
}

async function runTests() {
  const dir = resolve(root, 'test')
  const tests = readdirSync(dir).filter((name) => name.endsWith('.test.ts'))
  const outdir = resolve(out, 'test')
  rmSync(outdir, { recursive: true, force: true })
  await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['koffi', 'electron'],
    entryPoints: tests.map((name) => resolve(dir, name)),
    outdir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning'
  })
  const files = tests.map((name) => resolve(outdir, name.replace(/\.ts$/, '.mjs')))
  const { status } = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
  process.exit(status ?? 1)
}

async function buildCli() {
  await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Loaded only on Linux, and only if it's there: without it a network is reached by its
    // address alone.
    external: ['koffi'],
    entryPoints: [resolve(root, 'src/cli/cli.ts')],
    outfile: resolve(out, 'cli/steam-boost-cli.mjs'),
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info'
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2))
  if (args.has('--test')) await runTests()
  else if (args.has('--cli')) await buildCli()
  else await buildApp()
}

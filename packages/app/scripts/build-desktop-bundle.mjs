/* eslint-disable no-console */
/**
 * Desktop worker bundle builder.
 *
 * The Electrobun desktop worker (`workers/desktop/index.ts` → SWC →
 * `desktop-build/build/workers/core/index.mjs`) is a thin shim that imports
 * `@peartube/backend` source at runtime. Historically `desktop:ecopy` rsynced
 * the raw `@peartube/*` source trees into the launched `.app`, so the app was
 * only ever as fresh as the last copy — launching the `.app` directly (or a
 * partial copy) could run a stale `universal-core.js` and fail to link a newly
 * added export (e.g. `createUniversalHrpcSurface`).
 *
 * This script bare-packs the compiled worker into a single self-contained
 * `.bundle` (the same runnable format the native macOS sidecar uses), traced
 * from the real `packages/app/node_modules` graph. `pear-runtime` runs the
 * worker via `bare <entry>`, and `bare` loads `.bundle` files natively, so the
 * launcher can point at one artifact instead of a copied source tree.
 *
 * The build is mtime-gated so `desktop:start` can call it cheaply on every
 * launch and self-heal a stale bundle after a source change.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(projectRoot, '..', '..')

const entryFile = path.join(projectRoot, 'desktop-build', 'build', 'workers', 'core', 'index.mjs')
const bundleFile = path.join(projectRoot, 'desktop-build', 'build', 'workers', 'core', 'index.bundle')

// Source trees whose changes should invalidate the bundle. The worker pulls the
// shared backend core in transitively, so a change to any of these means the
// packed bundle is stale.
const sourceRoots = [
  path.join(projectRoot, 'workers', 'desktop'),
  path.join(repoRoot, 'packages', 'backend', 'src'),
  path.join(repoRoot, 'packages', 'host', 'src'),
  path.join(repoRoot, 'packages', 'core', 'src'),
  path.join(repoRoot, 'packages', 'protocol', 'src'),
  path.join(repoRoot, 'packages', 'spec', 'spec'),
]

const sourceFiles = [
  path.join(repoRoot, 'packages', 'backend', 'package.json'),
  path.join(repoRoot, 'packages', 'host', 'package.json'),
  path.join(repoRoot, 'packages', 'core', 'package.json'),
  path.join(repoRoot, 'packages', 'protocol', 'package.json'),
  path.join(repoRoot, 'packages', 'spec', 'package.json'),
]

const watchedExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.json'])

function getMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function walkNewestMtimeMs(dirPath) {
  let newest = 0
  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return newest
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build') continue
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, walkNewestMtimeMs(fullPath))
      continue
    }
    if (!entry.isFile()) continue
    if (!watchedExtensions.has(path.extname(entry.name))) continue
    newest = Math.max(newest, getMtimeMs(fullPath))
  }
  return newest
}

function getSourceNewestMtimeMs() {
  let newest = getMtimeMs(entryFile)
  for (const root of sourceRoots) newest = Math.max(newest, walkNewestMtimeMs(root))
  for (const filePath of sourceFiles) newest = Math.max(newest, getMtimeMs(filePath))
  return newest
}

function findBarePackBin() {
  const candidates = [
    path.join(projectRoot, 'node_modules', '.bin', 'bare-pack'),
    path.join(repoRoot, 'node_modules', '.bin', 'bare-pack'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('Could not locate bare-pack. Run `npm run install:all` first.')
}

// Hosts to pack native addons for. In dev we only need the host the developer
// is running on; bare-pack records linked addon resolutions for it.
function getBundleHosts() {
  return [`${process.platform}-${process.arch}`]
}

function runBarePack() {
  if (!fs.existsSync(entryFile)) {
    throw new Error(
      `Desktop worker entry not found: ${entryFile}\n` +
      'Run `npm run desktop:worker` (or `npm run desktop:build`) first.',
    )
  }

  fs.mkdirSync(path.dirname(bundleFile), { recursive: true })

  const barePackBin = findBarePackBin()
  const args = ['--out', bundleFile, '--format', 'bundle', '--linked']
  for (const host of getBundleHosts()) args.push('--host', host)
  args.push(entryFile)

  console.log(`[desktop:bundle] bare-pack ${args.join(' ')}`)
  const result = spawnSync(barePackBin, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) process.exit(result.status || 1)
}

const forced = process.env.PEARTUBE_FORCE_DESKTOP_BUNDLE === '1'
const sourceNewest = getSourceNewestMtimeMs()
const bundleMtime = getMtimeMs(bundleFile)
const missingBundle = bundleMtime === 0
const staleBundle = !missingBundle && bundleMtime < sourceNewest

if (forced || missingBundle || staleBundle) {
  const reason = forced ? 'forced rebuild' : missingBundle ? 'missing bundle' : 'stale bundle'
  console.log(`[desktop:bundle] Rebuilding desktop worker bundle (${reason})`)
  runBarePack()
  console.log(`[desktop:bundle] Wrote ${path.relative(projectRoot, bundleFile)}`)
} else {
  console.log('[desktop:bundle] Desktop worker bundle is up to date')
}

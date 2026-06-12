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
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
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
  // Gate on the real source (worker + shared backend), NOT on the SWC-emitted
  // entry: `desktop:worker` rewrites index.mjs on every build, so keying off it
  // would force a rebundle every launch. The bundle content only depends on the
  // traced source, and `workers/desktop` is included below.
  let newest = 0
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

const peartubeWorkspacePackages = ['backend', 'host', 'core', 'protocol', 'spec', 'platform']

// bare-pack resolves `@peartube/*` through node_modules. With npm `file:`
// deps those entries are symlinks to the live packages/ source, so the pack
// traces fresh code. But a stale *physical copy* (left by an older install
// state or a different package manager) would be silently inlined into the
// bundle and resurrect "does not provide an export named X" with up-to-date
// source on disk. Detect that and re-link to the live package.
function ensureLiveWorkspaceLinks() {
  const scopeDirs = [
    path.join(projectRoot, 'node_modules', '@peartube'),
    path.join(repoRoot, 'node_modules', '@peartube'),
  ]
  for (const scopeDir of scopeDirs) {
    if (!fs.existsSync(scopeDir)) continue
    for (const name of peartubeWorkspacePackages) {
      const linkPath = path.join(scopeDir, name)
      const livePath = path.join(repoRoot, 'packages', name)
      if (!fs.existsSync(linkPath) || !fs.existsSync(livePath)) continue
      let resolved
      try {
        resolved = fs.realpathSync(linkPath)
      } catch {
        continue
      }
      if (resolved === fs.realpathSync(livePath)) continue
      console.warn(
        `[desktop:bundle] ${linkPath} resolves to ${resolved} instead of the live ` +
        `${livePath} — replacing the stale copy with a symlink to live source`,
      )
      fs.rmSync(linkPath, { recursive: true, force: true })
      fs.symlinkSync(livePath, linkPath, 'dir')
    }
  }
}

// Belt-and-braces: after packing, prove the bundle actually contains the live
// source. Any packed @peartube file whose bytes differ from packages/<pkg>/...
// means bare-pack traced a stale copy — fail loudly instead of shipping a
// bundle that crashes the worker at link time.
function verifyBundleFreshness() {
  const require = createRequire(path.join(projectRoot, 'package.json'))
  const Bundle = require('bare-bundle')
  const packed = Bundle.from(fs.readFileSync(bundleFile))

  const problems = []
  let checked = 0
  for (const key of packed.keys()) {
    const match = key.match(/node_modules\/@peartube\/([^/]+)\/(.+)$/)
    if (!match) continue
    const livePath = path.join(repoRoot, 'packages', match[1], match[2])
    let liveSource
    try {
      liveSource = fs.readFileSync(livePath)
    } catch {
      continue
    }
    checked++
    if (!packed.read(key).equals(liveSource)) {
      problems.push(`${key}\n    differs from ${livePath}`)
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `[desktop:bundle] Packed bundle contains STALE @peartube source (${problems.length} file(s)):\n` +
      `  ${problems.join('\n  ')}\n` +
      'A stale physical copy of @peartube/* shadowed the live packages/ source during the pack.\n' +
      'Fix: rm -rf packages/app/node_modules/@peartube && npm run install:all, then rebuild.',
    )
  }

  console.log(`[desktop:bundle] Verified ${checked} packed @peartube file(s) match live source`)
}

function runBarePack() {
  if (!fs.existsSync(entryFile)) {
    throw new Error(
      `Desktop worker entry not found: ${entryFile}\n` +
      'Run `npm run desktop:worker` (or `npm run desktop:build`) first.',
    )
  }

  fs.mkdirSync(path.dirname(bundleFile), { recursive: true })
  ensureLiveWorkspaceLinks()

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
  verifyBundleFreshness()
  console.log(`[desktop:bundle] Wrote ${path.relative(projectRoot, bundleFile)}`)
} else {
  console.log('[desktop:bundle] Desktop worker bundle is up to date')
}

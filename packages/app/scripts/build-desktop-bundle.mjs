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
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  // Include this script's own mtime: when the packing logic/flags change (e.g.
  // dropping --linked), the bundle must be rebuilt even if no source changed —
  // otherwise a mtime-fresh bundle from the old logic is silently kept.
  let newest = getMtimeMs(fileURLToPath(import.meta.url))
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
// is running on; without --linked, bare-pack embeds that host's prebuilt
// addons into the bundle so it is self-contained.
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

// ── Static link check of the packed artifact ────────────────────────────────
// verifyBundleFreshness proves the bundle matches the live working tree — but
// if the working tree ITSELF is inconsistent (e.g. a locally-modified, stale
// universal-core.js next to an up-to-date runtime.js that imports a newer
// export), the freshness check passes and the worker still dies at link time
// with "does not provide an export named 'X'". Catch that at build time by
// verifying every named ESM import between packed @peartube files is satisfied
// by the target file's exports. The parser is intentionally conservative: it
// only flags a missing name when the target has no `export *` escape hatch.
// Validated against the real backend source (365 named imports, 0 false
// positives). Skip with PEARTUBE_SKIP_BUNDLE_LINK_CHECK=1 if it ever
// misfires.

function parseEsmExports(source) {
  const names = new Set()
  let starReexport = false
  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|class)\s*\*?\s*([\w$]+)/mg)) names.add(m[1])
  for (const m of source.matchAll(/^\s*export\s+(?:const|let|var)\s+([\w$]+)/mg)) names.add(m[1])
  for (const m of source.matchAll(/^\s*export\s*\*\s*as\s+([\w$]+)/mg)) names.add(m[1])
  if (/^\s*export\s+default\b/m.test(source)) names.add('default')
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/mg)) {
    for (const part of m[1].split(',')) {
      const token = part.trim()
      if (!token) continue
      const asMatch = token.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
      names.add(asMatch ? asMatch[2] : token)
    }
  }
  if (/^\s*export\s*\*\s*from/m.test(source)) starReexport = true
  return { names, starReexport }
}

function parseEsmNamedImports(source) {
  const imports = []
  const collect = (clause, specifier) => {
    const names = clause.split(',').map(s => s.trim()).filter(Boolean).map(token => {
      const asMatch = token.match(/^([\w$]+)\s+as\s+[\w$]+$/)
      return asMatch ? asMatch[1] : token
    })
    if (names.length > 0) imports.push({ names, specifier })
  }
  for (const m of source.matchAll(/^\s*import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/mg)) collect(m[1], m[2])
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/mg)) collect(m[1], m[2])
  return imports
}

function describeWorkingTreeState() {
  const result = spawnSync('git', ['status', '--porcelain', '--', 'packages/backend', 'packages/host', 'packages/core', 'packages/protocol'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const status = (result.stdout || '').trim()
  if (result.status !== 0) return ''
  return status
    ? `git reports locally modified files (a stale local edit is the usual culprit):\n  ${status.split('\n').join('\n  ')}`
    : 'git reports a clean working tree for the shared packages — the inconsistency may be in an unmerged/diverged checkout (compare `git log -1` with origin/main).'
}

function isOwnSourceKey(key) {
  return /@peartube\/|\/packages\//.test(key)
}

export function checkBundleLinks(packed) {
  const problems = []
  for (const key of packed.keys()) {
    if (!isOwnSourceKey(key) || !/\.(js|mjs)$/.test(key)) continue
    const source = packed.read(key).toString('utf8')
    const resolutions = packed.resolutions[key] || {}
    for (const { names, specifier } of parseEsmNamedImports(source)) {
      if (!specifier.startsWith('.')) continue
      const targetKey = resolutions[specifier]
      if (!targetKey || typeof targetKey !== 'string') continue
      if (!isOwnSourceKey(targetKey) || /\.cjs$/.test(targetKey)) continue
      let targetSource
      try {
        targetSource = packed.read(targetKey).toString('utf8')
      } catch {
        continue
      }
      const { names: exported, starReexport } = parseEsmExports(targetSource)
      if (starReexport) continue
      for (const name of names) {
        if (!exported.has(name)) {
          problems.push(`${key}\n    imports '${name}' from '${specifier}' but ${targetKey} does not export it`)
        }
      }
    }
  }
  return problems
}

function verifyBundleLinks() {
  if (process.env.PEARTUBE_SKIP_BUNDLE_LINK_CHECK === '1') {
    console.warn('[desktop:bundle] Skipping bundle link check (PEARTUBE_SKIP_BUNDLE_LINK_CHECK=1)')
    return
  }
  const require = createRequire(path.join(projectRoot, 'package.json'))
  const Bundle = require('bare-bundle')
  const packed = Bundle.from(fs.readFileSync(bundleFile))

  const problems = checkBundleLinks(packed)
  if (problems.length > 0) {
    throw new Error(
      `[desktop:bundle] Bundle FAILS to link — the worker would crash at startup (${problems.length} unresolved import(s)):\n` +
      `  ${problems.join('\n  ')}\n\n` +
      'This means the source tree itself is internally inconsistent (an importer expects an export\n' +
      'the target file does not have). ' + describeWorkingTreeState() + '\n' +
      'Fix: restore the stale file(s) from git, e.g.\n' +
      '  git checkout origin/main -- packages/backend/src\n' +
      'then rebuild with PEARTUBE_FORCE_DESKTOP_BUNDLE=1 npm run desktop:bundle.\n' +
      '(Escape hatch if this check misfires: PEARTUBE_SKIP_BUNDLE_LINK_CHECK=1)',
    )
  }
  console.log('[desktop:bundle] Bundle link check passed (all named imports satisfied)')
}

// Native-addon deps (e.g. bare-ffmpeg, imported by backend/src/thumbnail.js)
// ship as git submodules under packages/. If a submodule isn't initialized its
// `file:` dep can't link and bare-pack dies tracing it with a cryptic
// "MODULE_NOT_FOUND: Cannot find module 'bare-ffmpeg'". Catch it up front with
// an actionable message.
function ensureNativeAddonSubmodules() {
  let gitmodules = ''
  try {
    gitmodules = fs.readFileSync(path.join(repoRoot, '.gitmodules'), 'utf8')
  } catch {
    return
  }
  const missing = []
  for (const m of gitmodules.matchAll(/path\s*=\s*(packages\/bare-[^\s]+)/g)) {
    const subPath = m[1]
    if (!fs.existsSync(path.join(repoRoot, subPath, 'package.json'))) missing.push(subPath)
  }
  if (missing.length > 0) {
    throw new Error(
      `[desktop:bundle] Native addon submodule(s) not initialized: ${missing.join(', ')}\n` +
      'bare-pack needs them on disk to trace the backend (bare-ffmpeg is imported by\n' +
      'packages/backend/src/thumbnail.js). They are git submodules, untouched by git pull/checkout.\n' +
      `Fix: git submodule update --init ${missing.join(' ')} && npm run install:all\n` +
      'then rebuild with PEARTUBE_FORCE_DESKTOP_BUNDLE=1 npm run desktop:bundle.',
    )
  }
}

function runBarePack() {
  if (!fs.existsSync(entryFile)) {
    throw new Error(
      `Desktop worker entry not found: ${entryFile}\n` +
      'Run `npm run desktop:worker` (or `npm run desktop:build`) first.',
    )
  }

  fs.mkdirSync(path.dirname(bundleFile), { recursive: true })
  ensureNativeAddonSubmodules()
  ensureLiveWorkspaceLinks()

  const barePackBin = findBarePackBin()
  // No --linked: embed the host's prebuilt native addons (bare-os, bare-ffmpeg,
  // …) into the bundle so a standalone `bare index.bundle` is self-contained.
  // --linked would emit `linked:` specifiers expecting the host to provide the
  // addon frameworks (the mobile/native-sidecar model) — which a plain bare
  // subprocess does not, so it would fail with ADDON_NOT_FOUND at startup.
  const args = ['--out', bundleFile, '--format', 'bundle']
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

// Only run the build when executed directly (the test imports checkBundleLinks).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
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
    verifyBundleLinks()
    console.log(`[desktop:bundle] Wrote ${path.relative(projectRoot, bundleFile)}`)
  } else {
    console.log('[desktop:bundle] Desktop worker bundle is up to date')
  }
}

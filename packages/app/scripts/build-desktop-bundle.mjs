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
 * This script bare-packs the compiled worker into a runnable `.bundle`, traced
 * from the real `packages/app/node_modules` graph. Native `.bare` addons are
 * offloaded beside the bundle because the PearRuntime sidecar dlopens them
 * from filesystem paths. `pear-runtime` runs the worker via `bare <entry>`, so
 * the launcher can point at one JS artifact plus its sibling native addon tree
 * instead of a copied source tree.
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
const bundleDir = path.dirname(bundleFile)
const offloadedAddonsDir = path.join(bundleDir, 'node_modules')

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
// is running on; bare-pack uses this to choose the right prebuilt addons to
// offload beside the bundle.
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

function collectStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const child of Object.values(value)) collectStrings(child, output)
}

function getOffloadedNativeAddonPaths(packed) {
  const values = []
  for (const resolutions of Object.values(packed.resolutions)) collectStrings(resolutions, values)

  const relativePaths = new Set()
  for (const value of values) {
    if (!/^\/\.\.\/node_modules\/.+\.(?:bare|node)$/.test(value)) continue
    relativePaths.add(value.slice('/../'.length))
  }

  return [...relativePaths].sort().map((relativePath) => path.join(bundleDir, relativePath))
}

function readPackedBundle() {
  const require = createRequire(path.join(projectRoot, 'package.json'))
  const Bundle = require('bare-bundle')
  return Bundle.from(fs.readFileSync(bundleFile))
}

function findMissingOffloadedNativeAddons() {
  if (!fs.existsSync(bundleFile)) return []
  const packed = readPackedBundle()
  const addonPaths = getOffloadedNativeAddonPaths(packed)
  if (addonPaths.length === 0) return ['<no offloaded native addon resolutions in bundle>']
  return addonPaths.filter((addonPath) => !fs.existsSync(addonPath))
}

function verifyOffloadedNativeAddons() {
  const missing = findMissingOffloadedNativeAddons()
  if (missing.length > 0) {
    const lines = missing.map((addonPath) => (
      addonPath.startsWith('<') ? addonPath : path.relative(projectRoot, addonPath)
    ))
    throw new Error(
      `[desktop:bundle] Missing offloaded native addon file(s) needed by ${path.relative(projectRoot, bundleFile)}:\n` +
      `  ${lines.join('\n  ')}\n` +
      'PearRuntime dlopens desktop native addons from the filesystem, so the worker bundle must be built with\n' +
      '`bare-pack --offload-addons` and the generated node_modules directory must be copied beside index.bundle.\n' +
      'Fix: PEARTUBE_FORCE_DESKTOP_BUNDLE=1 npm run desktop:bundle.',
    )
  }
  console.log('[desktop:bundle] Offloaded native addon check passed')
}

// Native-addon deps (e.g. bare-ffmpeg, imported by backend/src/thumbnail.js)
// ship as git submodules under packages/. Two failure modes bare-pack reports
// only cryptically, caught here up front:
//   1. submodule not initialized -> its `file:` dep can't link, bare-pack dies
//      with "MODULE_NOT_FOUND: Cannot find module 'bare-ffmpeg'".
//   2. submodule present but not compiled -> bare-pack can't embed the addon
//      and dies looking for "prebuilds/<host>/<name>.node".
function ensureNativeAddonSubmodules() {
  let gitmodules = ''
  try {
    gitmodules = fs.readFileSync(path.join(repoRoot, '.gitmodules'), 'utf8')
  } catch {
    return
  }

  const uninitialized = []
  const unbuilt = []
  for (const m of gitmodules.matchAll(/path\s*=\s*(packages\/bare-[^\s]+)/g)) {
    const subPath = m[1]
    const absPath = path.join(repoRoot, subPath)
    if (!fs.existsSync(path.join(absPath, 'package.json'))) {
      uninitialized.push(subPath)
      continue
    }
    // cmake-bare native addon (has CMakeLists.txt) must be compiled into
    // prebuilds/<host>/ before bare-pack can embed it.
    const isNativeAddon = fs.existsSync(path.join(absPath, 'CMakeLists.txt'))
    if (!isNativeAddon) continue
    const prebuildsDir = path.join(absPath, 'prebuilds')
    let built = false
    try {
      built = fs.readdirSync(prebuildsDir).some((host) => {
        try {
          return fs.readdirSync(path.join(prebuildsDir, host)).length > 0
        } catch {
          return false
        }
      })
    } catch {
      built = false
    }
    if (!built) unbuilt.push(subPath)
  }

  if (uninitialized.length > 0) {
    throw new Error(
      `[desktop:bundle] Native addon submodule(s) not initialized: ${uninitialized.join(', ')}\n` +
      'bare-pack needs them on disk to trace the backend (bare-ffmpeg is imported by\n' +
      'packages/backend/src/thumbnail.js). They are git submodules, untouched by git pull/checkout.\n' +
      `Fix: git submodule update --init ${uninitialized.join(' ')} && npm run install:all\n` +
      'then rebuild with PEARTUBE_FORCE_DESKTOP_BUNDLE=1 npm run desktop:bundle.',
    )
  }

  if (unbuilt.length > 0) {
    const steps = unbuilt
      .map((subPath) => `  ( cd ${subPath} && npm install && npx bare-make generate && npx bare-make build && npx bare-make install )`)
      .join('\n')
    throw new Error(
      `[desktop:bundle] Native addon(s) not compiled (no prebuilds/): ${unbuilt.join(', ')}\n` +
      'bare-pack embeds each addon\'s prebuilt binary into the bundle, so they must be built once.\n' +
      'These are cmake-bare addons; build the host prebuild with:\n' +
      `${steps}\n` +
      'then rebuild with PEARTUBE_FORCE_DESKTOP_BUNDLE=1 npm run desktop:bundle.\n' +
      '(If bare-make build fails on missing FFmpeg, install it first: brew install ffmpeg pkg-config.)',
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

  fs.mkdirSync(bundleDir, { recursive: true })
  fs.rmSync(offloadedAddonsDir, { recursive: true, force: true })
  ensureNativeAddonSubmodules()
  ensureLiveWorkspaceLinks()

  const barePackBin = findBarePackBin()
  // No --linked: linked addons are the mobile/native-sidecar model. The
  // Electrobun worker runs in PearRuntime's desktop sidecar, which dlopens
  // `.bare` prebuilds from the filesystem. `--offload-addons` writes those
  // prebuilds into workers/core/node_modules and rewrites bundle resolutions to
  // `index.bundle/../node_modules/...`.
  const args = ['--offload-addons', '--base', projectRoot, '--out', bundleFile, '--format', 'bundle']
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
  const missingOffloadedAddons = !missingBundle && findMissingOffloadedNativeAddons().length > 0

  if (forced || missingBundle || staleBundle || missingOffloadedAddons) {
    const reason = forced ? 'forced rebuild' : missingBundle ? 'missing bundle' : staleBundle ? 'stale bundle' : 'missing offloaded native addons'
    console.log(`[desktop:bundle] Rebuilding desktop worker bundle (${reason})`)
    runBarePack()
    verifyBundleFreshness()
    verifyBundleLinks()
    verifyOffloadedNativeAddons()
    console.log(`[desktop:bundle] Wrote ${path.relative(projectRoot, bundleFile)}`)
  } else {
    verifyOffloadedNativeAddons()
    console.log('[desktop:bundle] Desktop worker bundle is up to date')
  }
}

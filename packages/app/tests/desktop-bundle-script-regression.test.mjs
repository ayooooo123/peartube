import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
}

test('desktop:bundle is wired into the desktop build + launch pipeline', () => {
  const { scripts } = readPackageJson()

  assert.equal(
    scripts['desktop:bundle'],
    'node ./scripts/build-desktop-bundle.mjs',
    'desktop:bundle should invoke the desktop bundle builder',
  )

  // The bundle must be (re)built after the worker is compiled.
  assert.match(
    scripts['desktop:build'],
    /npm run desktop:worker && npm run desktop:bundle/,
    'desktop:build should bundle the worker after compiling it',
  )

  // A bare `desktop:start` must be self-sufficient: recompile the worker,
  // re-bundle, AND rebuild the launcher (electrobun build, via desktop:ebuild)
  // so it can never run a stale compiled bun main that spawns a leftover
  // index.mjs.
  assert.match(
    scripts['desktop:start'],
    /npm run desktop:worker && npm run desktop:bundle && npm run desktop:ebuild/,
    'desktop:start should compile + bundle + rebuild the launcher before launch',
  )

  // ecopy must wipe any stale worker/node_modules left by older builds so the
  // .app can only ever contain the fresh bundle.
  assert.match(
    scripts['desktop:ecopy'],
    /rm -rf [^&]*\/workers [^&]*\/node_modules/,
    'desktop:ecopy should clear stale workers/node_modules before copying',
  )

  // ecopy must ship the self-contained bundle into the .app...
  assert.match(
    scripts['desktop:ecopy'],
    /rsync -a desktop-build\/build\/workers\/core\/index\.bundle /,
    'desktop:ecopy should copy index.bundle into the .app',
  )
  // ...and must NOT rsync the raw @peartube source trees anymore (the bundle
  // inlines all @peartube JS, so the copied node_modules tree was the stale
  // load path we are eliminating).
  assert.doesNotMatch(
    scripts['desktop:ecopy'],
    /packages\/(backend|host|core|protocol|spec)\//,
    'desktop:ecopy should no longer rsync @peartube source packages',
  )
  assert.doesNotMatch(
    scripts['desktop:ecopy'],
    /node_modules\/@peartube/,
    'desktop:ecopy should no longer create a node_modules/@peartube tree',
  )
})

test('desktop bundle builder packs a runnable, linked bare bundle', () => {
  const source = fs.readFileSync(path.join(appRoot, 'scripts', 'build-desktop-bundle.mjs'), 'utf8')

  assert.match(source, /'--format', 'bundle'/, 'should emit a runnable bare bundle')
  assert.match(source, /'--linked'/, 'should link native addons')
  assert.match(source, /index\.bundle/, 'should write index.bundle')
  // Must be mtime-gated so desktop:start stays cheap when nothing changed.
  assert.match(source, /staleBundle|getSourceNewestMtimeMs/, 'should be mtime-gated')
  // Must guard against a stale physical copy of @peartube/* shadowing live
  // source during the pack (the silent path back to "does not provide an
  // export named X"), and prove post-pack that bundled bytes match live source.
  assert.match(
    source,
    /ensureLiveWorkspaceLinks\(\)/,
    'should re-link stale @peartube node_modules copies before packing',
  )
  assert.match(
    source,
    /verifyBundleFreshness\(\)/,
    'should verify packed @peartube files match live source after packing',
  )
  assert.match(
    source,
    /verifyBundleLinks\(\)/,
    'should statically link-check the packed bundle after packing',
  )
})

test('bundle link check catches a stale universal-core missing an export', async () => {
  const { checkBundleLinks } = await import('../scripts/build-desktop-bundle.mjs')

  // Minimal Bundle-shaped fixture: keys() + read() + resolutions, mirroring
  // bare-bundle's surface that checkBundleLinks consumes.
  function makeBundle(files, resolutions) {
    return {
      keys: () => Object.keys(files),
      read: (key) => Buffer.from(files[key]),
      resolutions,
    }
  }

  const entryKey = '/x/node_modules/@peartube/backend/src/backend-entry.js'
  const coreKey = '/x/node_modules/@peartube/backend/src/universal-core.js'
  const importer = "import { createUniversalCore, createUniversalHrpcSurface } from './universal-core.js'\nexport function createBackend() {}\n"
  const freshCore = 'export function createUniversalCore() {}\nexport function createUniversalHrpcSurface() {}\nexport default {}\n'
  const staleCore = 'export function createUniversalCore() {}\nexport default {}\n'
  const resolutions = { [entryKey]: { './universal-core.js': coreKey } }

  const fresh = checkBundleLinks(makeBundle({ [entryKey]: importer, [coreKey]: freshCore }, resolutions))
  assert.equal(fresh.length, 0, `fresh bundle should link cleanly, got: ${fresh.join('; ')}`)

  const stale = checkBundleLinks(makeBundle({ [entryKey]: importer, [coreKey]: staleCore }, resolutions))
  assert.equal(stale.length, 1, 'stale bundle should produce exactly one problem')
  assert.match(stale[0], /createUniversalHrpcSurface/, 'problem should name the missing export')
  assert.match(stale[0], /universal-core\.js/, 'problem should name the stale file')

  // `export *` disables verification for that target (cannot check statically).
  const starCore = "export * from './elsewhere.js'\n"
  const star = checkBundleLinks(makeBundle({ [entryKey]: importer, [coreKey]: starCore }, resolutions))
  assert.equal(star.length, 0, 'export * targets should be skipped, not flagged')
})

test('bundle link check has zero false positives across the real backend source', async () => {
  const { checkBundleLinks } = await import('../scripts/build-desktop-bundle.mjs')
  const repoRoot = path.resolve(appRoot, '..', '..')

  // Build a synthetic bundle from the actual live source tree: every relative
  // import between files maps through resolutions exactly like bare-pack
  // records them. The real tree must link cleanly.
  const files = {}
  const resolutions = {}
  const roots = ['packages/backend/src', 'packages/backend/lib', 'packages/host/src', 'packages/protocol/src', 'packages/core/src']

  function walk(dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|mjs)$/.test(entry.name)) files[full] = fs.readFileSync(full, 'utf8')
    }
  }
  for (const root of roots) walk(path.join(repoRoot, root))

  for (const key of Object.keys(files)) {
    const map = {}
    for (const m of files[key].matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
      const resolved = path.resolve(path.dirname(key), m[1])
      if (files[resolved]) map[m[1]] = resolved
    }
    resolutions[key] = map
  }

  const bundle = {
    keys: () => Object.keys(files),
    read: (key) => Buffer.from(files[key]),
    resolutions,
  }
  const problems = checkBundleLinks(bundle)
  assert.equal(problems.length, 0, `live source should link cleanly, got:\n${problems.join('\n')}`)
  assert.ok(Object.keys(files).length > 50, 'sanity: should have scanned the real source tree')
})

test('desktop launcher prefers the bare bundle over the loose worker', () => {
  const source = fs.readFileSync(path.join(appRoot, 'src', 'bun', 'index.ts'), 'utf8')

  assert.match(
    source,
    /\.replace\(\/\\\.\(js\|mjs\)\$\/, '\.bundle'\)/,
    'launcher should derive a .bundle sibling path',
  )
  assert.match(
    source,
    /if \(existsSync\(bundlePath\)\) \{\s*workerPath = bundlePath/,
    'launcher should prefer the .bundle when it exists',
  )
})

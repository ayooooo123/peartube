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

  // A bare `desktop:start` must self-heal a stale bundle before launching.
  assert.match(
    scripts['desktop:start'],
    /npm run desktop:bundle &&/,
    'desktop:start should ensure a fresh bundle before launch',
  )

  // ecopy must ship the whole workers/core dir so index.bundle lands in the .app.
  assert.match(
    scripts['desktop:ecopy'],
    /rsync -a desktop-build\/build\/workers\/core\/ /,
    'desktop:ecopy should copy the workers/core directory (including index.bundle)',
  )
  assert.doesNotMatch(
    scripts['desktop:ecopy'],
    /workers\/core\/index\.mjs build/,
    'desktop:ecopy should no longer copy only index.mjs',
  )
})

test('desktop bundle builder packs a runnable, linked bare bundle', () => {
  const source = fs.readFileSync(path.join(appRoot, 'scripts', 'build-desktop-bundle.mjs'), 'utf8')

  assert.match(source, /'--format', 'bundle'/, 'should emit a runnable bare bundle')
  assert.match(source, /'--linked'/, 'should link native addons')
  assert.match(source, /index\.bundle/, 'should write index.bundle')
  // Must be mtime-gated so desktop:start stays cheap when nothing changed.
  assert.match(source, /staleBundle|getSourceNewestMtimeMs/, 'should be mtime-gated')
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

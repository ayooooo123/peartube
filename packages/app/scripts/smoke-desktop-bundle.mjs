/* eslint-disable no-console */
/**
 * Headless smoke test for the packed desktop worker bundle.
 *
 * `desktop:build` only proves the bundle *packs*; it never runs it, so a native
 * addon that packs fine but cannot be `dlopen`ed at runtime (the
 * `index.bundle/.../bare-os.bare` ENOTDIR crash this pipeline exists to prevent)
 * would sail through a build-only CI step. This runs the packed bundle with the
 * `bare` runtime and fails if any native addon (bare-os, bare-ffmpeg, …) fails
 * to load.
 *
 * We only need the bundle to boot far enough to evaluate its top-level
 * `import … from 'bare-*'` statements (and the bare-ffmpeg import pulled in by
 * @peartube/backend/thumbnail) — that is where the addon `dlopen` happens. The
 * worker is NOT meant to fully start standalone (it needs a parent IPC peer), so
 * we do not assert a clean exit: we only fail on a native-addon load error seen
 * within a short window, then kill it. Non-addon crashes (e.g. a missing IPC
 * peer) are expected and ignored.
 *
 * Runs against the bundle built for the current host (desktop:bundle targets
 * `${platform}-${arch}`), so it is meant to run on the same machine/arch that
 * built it — i.e. the macOS CI runner, or a dev Mac.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(projectRoot, '..', '..')
const bundleFile = path.join(projectRoot, 'desktop-build', 'build', 'workers', 'core', 'index.bundle')

// Unambiguous native-addon load failures. A successful boot never prints these.
// Scoped tightly so an unrelated JS error can't trip a false failure.
const ADDON_ERROR = /dlopen|ENOTDIR|errno=20|ADDON_NOT_FOUND|Cannot find addon/i
const RUN_MS = 8000

function findBareBin() {
  const candidates = [
    path.join(projectRoot, 'node_modules', '.bin', 'bare'),
    path.join(repoRoot, 'node_modules', '.bin', 'bare'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  const which = spawnSync('bash', ['-lc', 'command -v bare'], { encoding: 'utf8' })
  const found = (which.stdout || '').trim()
  if (found) return found
  throw new Error(
    'Could not locate the `bare` runtime binary (from bare-runtime). Run `npm run install:all`.',
  )
}

if (!fs.existsSync(bundleFile)) {
  console.error(`[smoke] Bundle not found: ${bundleFile}\nRun \`npm run desktop:build\` first.`)
  process.exit(1)
}

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-smoke-'))
const bareBin = findBareBin()

function cleanup() {
  try { fs.rmSync(storageDir, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`[smoke] ${bareBin} ${path.relative(projectRoot, bundleFile)} ${storageDir}`)
const child = spawn(bareBin, [bundleFile, storageDir], { cwd: projectRoot, env: process.env })

let addonError = null
const onData = (chunk) => {
  const text = chunk.toString()
  if (!addonError && ADDON_ERROR.test(text)) {
    addonError = text.trim()
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)

const timer = setTimeout(() => {
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}, RUN_MS)

child.on('error', (err) => {
  clearTimeout(timer)
  cleanup()
  console.error('[smoke] Failed to spawn bare:', err.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  cleanup()
  if (addonError) {
    console.error('\n[smoke] FAIL: a native addon failed to load in the packed bundle:\n  ' + addonError)
    console.error(
      '\n[smoke] This is the dlopen/ENOTDIR regression: the addon was not offloaded to a real\n' +
      'file beside the bundle. Check --offload-addons / --base / the staging relocation in\n' +
      'scripts/build-desktop-bundle.mjs.',
    )
    process.exit(1)
  }
  console.log(
    `[smoke] PASS: native addons loaded (bare exited code=${code} signal=${signal} after boot; ` +
    'a non-addon exit here is expected without a parent IPC peer).',
  )
  process.exit(0)
})

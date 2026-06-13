/* eslint-disable no-console */
/**
 * Headless smoke test for the packed desktop worker bundle.
 *
 * `desktop:build` only proves the bundle *packs*; it never runs it, so a native
 * addon that packs but cannot be `dlopen`ed at runtime (the
 * `index.bundle/.../bare-os.bare` ENOTDIR crash this pipeline exists to prevent)
 * would sail through a build-only CI step. This launches the packed bundle the
 * exact way the desktop launcher does — `PearRuntime.run(bundle, [storage])`
 * (see src/bun/index.ts) — and fails if any native addon (bare-os, bare-ffmpeg,
 * …) fails to load. Using pear-runtime means we exercise the real embedded bare
 * runtime and the offloaded-addon resolution (`<bundle>/../node_modules/…`).
 *
 * We only need the bundle to boot far enough to evaluate its top-level
 * `import … from 'bare-*'` statements (and the bare-ffmpeg import pulled in by
 * @peartube/backend/thumbnail) — that is where the addon `dlopen` happens. The
 * worker is NOT meant to fully start standalone (it needs a parent IPC peer), so
 * we do not require a clean run: we fail only on a native-addon load error seen
 * within a short window, then tear it down. A non-addon exit is expected.
 *
 * Run under `bun` (the launcher's runtime), so pear-runtime behaves as it does
 * in the app. Targets the bundle built for the current host.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import PearRuntime from 'pear-runtime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const bundleFile = path.join(projectRoot, 'desktop-build', 'build', 'workers', 'core', 'index.bundle')

// Unambiguous native-addon load failures. A successful boot never prints these.
// Scoped tightly so an unrelated JS/runtime error can't trip a false failure.
const ADDON_ERROR = /dlopen|ENOTDIR|errno=20|ADDON_NOT_FOUND|Cannot find addon/i
const RUN_MS = 8000

if (!fs.existsSync(bundleFile)) {
  console.error(`[smoke] Bundle not found: ${bundleFile}\nRun \`npm run desktop:build\` first.`)
  process.exit(1)
}

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-smoke-'))

function cleanup() {
  try { fs.rmSync(storageDir, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`[smoke] PearRuntime.run(${path.relative(projectRoot, bundleFile)}, [${storageDir}])`)

let worker
try {
  worker = PearRuntime.run(bundleFile, [storageDir])
} catch (err) {
  cleanup()
  console.error('[smoke] Failed to launch the bundle via pear-runtime:', err?.message || err)
  process.exit(1)
}

let addonError = null
let settled = false
let timer = null

function finish(ok, detail) {
  if (settled) return
  settled = true
  if (timer) clearTimeout(timer)
  try { worker.destroy?.() } catch { /* already gone */ }
  cleanup()
  if (!ok) {
    console.error('\n[smoke] FAIL: a native addon failed to load in the packed bundle:\n  ' + detail)
    console.error(
      '\n[smoke] This is the dlopen/ENOTDIR regression: the addon was not offloaded to a real\n' +
      'file beside the bundle. Check --offload-addons / --base / the staging relocation in\n' +
      'scripts/build-desktop-bundle.mjs.',
    )
    process.exit(1)
  }
  console.log('[smoke] PASS: ' + detail)
  process.exit(0)
}

const onData = (chunk) => {
  const text = chunk.toString()
  if (!addonError && ADDON_ERROR.test(text)) {
    addonError = text.trim()
    finish(false, addonError)
  }
}

worker.stdout?.on('data', onData)
worker.stderr?.on('data', onData)
worker.on?.('error', (err) => {
  const text = String(err?.message || err)
  if (ADDON_ERROR.test(text)) finish(false, text.trim())
})
worker.once?.('exit', (code) => {
  // No parent IPC peer, so the worker is expected to exit; reaching here without
  // an addon error means every native addon loaded.
  if (!addonError) finish(true, `native addons loaded (worker exited code=${code} after boot).`)
})

timer = setTimeout(() => {
  finish(true, 'native addons loaded (no load error within the smoke window).')
}, RUN_MS)

#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseAppTestArgs } from './lib/args.mjs'
import { ensureAndroid, ensureIos } from './ensure-avd.mjs'
import { startCapture } from './lib/capture.mjs'
import { ensureContent } from './lib/content.mjs'
import { describeWithLook, prepareForOmp, resolveBackend } from './lib/eyes.mjs'
import { summarizeJunit } from './lib/junit.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // packages/app
const MAESTRO_DIR = fileURLToPath(new URL('../../../.maestro', import.meta.url)) // repo-root .maestro
const pExecFile = promisify(execFile)

async function run() {
  const a = parseAppTestArgs(process.argv.slice(2))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (a.seed) await ensureContent()

  for (const platform of a.platforms) {
    const outDir = join(ROOT, '.artifacts', 'app-test', stamp, platform)
    mkdirSync(outDir, { recursive: true })
    const target = platform === 'android' ? await ensureAndroid(a.attach)
      : platform === 'ios' ? ensureIos(a.attach)
      : null // desktop
    if (platform === 'desktop' && !a.recordOnly) {
      console.error('[app-test] desktop is record-only in v1 — forcing --record-only')
    }
    const recordOnly = a.recordOnly || platform === 'desktop'

    const framesDir = join(outDir, 'frames')
    mkdirSync(framesDir, { recursive: true })
    const cap = startCapture(platform, target, framesDir)
    let gate = { ok: true, skipped: 0 }
    let frames = []
    try {
      if (recordOnly) {
        await new Promise(r => setTimeout(r, 5000)) // sample the current screen for ~5s
      } else {
        const flow = join(MAESTRO_DIR, `${a.flow || 'smoke'}.yaml`)
        const junitPath = join(outDir, 'result.junit.xml')
        // async so the capture timer keeps firing while Maestro drives the flow
        try {
          await pExecFile('maestro', ['test', flow, '--format', 'junit', '--output', junitPath],
            { maxBuffer: 32 * 1024 * 1024 })
        } catch { /* nonzero exit still writes junit; summarized below */ }
        try { gate = summarizeJunit(readFileSync(junitPath, 'utf8')) }
        catch { gate = { ok: false, skipped: 0 } } // maestro absent/crashed before writing junit → fail the gate
      }
    } finally {
      frames = cap.stop()
    }

    // Eyes (advisory — never fatal)
    const outBase = join(outDir, 'capture')
    if (frames.length === 0) {
      console.error('[eyes] no frames captured — skipping (advisory)')
    } else if (resolveBackend(a.eyes) === 'look') {
      try { describeWithLook(frames, outBase) } catch (e) { console.error('[eyes] look failed (advisory):', e.message) }
    } else {
      try {
        const { manifestPath } = prepareForOmp(frames, outBase)
        writeFileSync(join(outDir, 'EYES_TODO.txt'),
          `Agent: describe the ${frames.length} frames in ${manifestPath} via OMP vision ` +
          `(inspect_image / subagent) and write the result to ${outBase}.eyes.txt`)
        console.error(`[eyes] ${frames.length} frames prepared → ${manifestPath} (agent describes; see EYES_TODO.txt)`)
      } catch (e) {
        console.error('[eyes] frame prep skipped (advisory):', e.message)
      }
    }

    console.error(`[app-test] ${platform}: gate ${gate.ok ? 'PASS' : 'FAIL'} (skipped ${gate.skipped}) → ${outDir}`)
    if (!gate.ok) process.exitCode = 1
  }
}

run().catch(e => { console.error('[app-test] fatal:', e.message); process.exit(2) })

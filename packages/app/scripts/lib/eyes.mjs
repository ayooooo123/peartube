import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOOK = fileURLToPath(new URL('../look.py', import.meta.url))

export const EYES_PROMPT =
  'Describe these frames from a UI screen recording, in order: every screen shown, ' +
  'all on-screen text verbatim, layout and alignment, and any visual glitches, ' +
  'clipping, overlap, or broken states. Report only what is visible; do not judge product correctness.'

export function resolveBackend(eyes) {
  // Local-only: 'omp' (agent describes prepared frames) or 'look' (autonomous look.py).
  return eyes === 'look' ? 'look' : 'omp'
}

/** look backend: fully autonomous. Describes each frame via look.py, joins, writes <outBase>.eyes.txt. */
export function describeWithLook(frames, outBase) {
  const parts = []
  for (const f of frames) {
    const t = execFileSync('python3', [LOOK, f, EYES_PROMPT], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    parts.push(`## ${f}\n${t.trim()}`)
  }
  const text = parts.join('\n\n')
  writeFileSync(`${outBase}.eyes.txt`, text)
  return text
}

/**
 * omp backend: write a manifest of the captured frames for the agent to describe.
 * A Node CLI cannot call an OMP subagent, so it stops here; the app-review skill (agent side)
 * reads the manifest, runs inspect_image / a vision subagent, and writes <outBase>.eyes.txt.
 */
export function prepareForOmp(frames, outBase) {
  const manifest = {
    outBase,
    prompt: EYES_PROMPT,
    frames: frames.map((path, index) => ({ index, path })),
    describeTo: `${outBase}.eyes.txt`,
  }
  const manifestPath = `${outBase}.eyes-manifest.json`
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { manifestPath, manifest }
}

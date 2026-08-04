import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sampleFrames } from './frames.mjs'

const LOOK = fileURLToPath(new URL('../look.py', import.meta.url))

export const EYES_PROMPT =
  'Describe these frames from a UI screen recording, in order: every screen shown, ' +
  'all on-screen text verbatim, layout and alignment, and any visual glitches, ' +
  'clipping, overlap, or broken states. Report only what is visible; do not judge product correctness.'

export function resolveBackend(eyes) {
  // Local-only: 'omp' (agent describes prepared frames) or 'look' (autonomous look.py).
  return eyes === 'look' ? 'look' : 'omp'
}

/** look backend: fully autonomous, writes <outBase>.eyes.txt. Returns the text. */
export function describeWithLook(video, outBase) {
  const text = execFileSync('python3', [LOOK, video, EYES_PROMPT], { encoding: 'utf8' })
  writeFileSync(`${outBase}.eyes.txt`, text)
  return text
}

/**
 * omp backend: prepare frames + a manifest for the agent to describe.
 * A Node CLI cannot call an OMP subagent, so it stops here; the app-review skill
 * (agent side) reads the manifest, runs inspect_image / a vision subagent, and
 * writes <outBase>.eyes.txt.
 */
export async function prepareForOmp(video, outBase) {
  const { dir, frames } = await sampleFrames(video)
  const manifest = {
    video, outBase, prompt: EYES_PROMPT,
    frames: frames.map(f => ({ t: Number(f.t.toFixed(2)), path: f.path })),
    describeTo: `${outBase}.eyes.txt`,
  }
  const manifestPath = join(dir, 'eyes-manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { manifestPath, manifest }
}

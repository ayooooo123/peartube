import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { getSidecarAddonRoots } from '../scripts/sidecar-addon-roots.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..', '..', '..')

test('resolves bare-ffmpeg addon roots for native sidecar packaging', () => {
  const roots = getSidecarAddonRoots(repoRoot)

  assert.ok(roots.length > 0, 'expected at least one addon root')
  assert.ok(
    roots.some((root) =>
      root.includes(path.join('bare-media', 'node_modules', 'bare-ffmpeg')) ||
      root.endsWith(path.join('packages', 'bare-ffmpeg'))
    ),
    `expected bare-ffmpeg to be included in ${roots.join(', ')}`
  )

  for (const root of roots) {
    assert.equal(fs.statSync(root).isDirectory(), true)
  }
})

test('resolves bare-mpv addon roots for native sidecar packaging', () => {
  const roots = getSidecarAddonRoots(repoRoot)

  assert.ok(
    roots.some((root) =>
      root.includes(path.join('node_modules', 'bare-mpv')) ||
      root.endsWith(path.join('packages', 'bare-mpv'))
    ),
    `expected bare-mpv to be included in ${roots.join(', ')}`
  )
})

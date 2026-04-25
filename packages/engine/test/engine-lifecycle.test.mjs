import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngine } from '../src/index.mjs'
import { validateProfileRecord } from '../src/schema.mjs'

test('createEngine creates a local Hyperdrive channel with profile', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'peartube-engine-life-'))
  const engine = await createEngine({ storagePath, name: 'Alice' })

  assert.equal(typeof engine.channelKey, 'string')
  assert.ok(engine.channelKey.length > 0)

  const profile = await engine.readJson('/profile.json')
  assert.equal(profile.name, 'Alice')
  assert.equal(profile.channelKey, engine.channelKey)
  assert.equal(validateProfileRecord(profile).ok, true)

  await engine.close()
})

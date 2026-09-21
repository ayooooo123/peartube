import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Hyperbee from 'hyperbee'
import Hypercore from 'hypercore'

import { createMetaSubspaces } from '../src/meta-subspaces.js'

async function withBee(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-sub-'))
  const core = new Hypercore(dir)
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.ready()
  try {
    await fn(bee)
  } finally {
    await core.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('sub accessors round-trip and are isolated from the base keyspace', async () => {
  await withBee(async (bee) => {
    const subs = createMetaSubspaces(bee)
    await bee.put('subscriptions', { unrelated: true }) // base-level key
    await subs.downloadIntents.put('driveA:vidA', { intent: 'a' })
    await subs.channelKinds.put('cc'.repeat(32), { kind: 'autobase' })
    await subs.mediaGraphClaims.put('claim-1', { accepted: true })

    assert.deepEqual((await subs.downloadIntents.get('driveA:vidA'))?.value, { intent: 'a' })
    assert.deepEqual((await subs.channelKinds.get('cc'.repeat(32)))?.value, { kind: 'autobase' })
    assert.deepEqual((await subs.mediaGraphClaims.get('claim-1'))?.value, { accepted: true })

    // A full-sub scan returns only that sub's keys (decoded), not base keys.
    const diKeys = []
    for await (const n of subs.downloadIntents.createReadStream()) diKeys.push(n.key)
    assert.deepEqual(diKeys, ['driveA:vidA'])

    await subs.downloadIntents.del('driveA:vidA')
    assert.equal(await subs.downloadIntents.get('driveA:vidA'), null)
    // Base key untouched by sub operations.
    assert.deepEqual((await bee.get('subscriptions'))?.value, { unrelated: true })
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Corestore from 'corestore'

test('deterministic keyPair lookup resolves the same key as a named core', async () => {
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'peartube-meta-core-'))

  let store = null
  let namedCore = null
  let keyPairCore = null

  try {
    store = new Corestore(storagePath, { wait: false })
    await store.ready()

    namedCore = store.get({ name: 'peartube-meta' })
    await namedCore.ready()

    const keyPair = await store.createKeyPair('peartube-meta')
    keyPairCore = store.get({ keyPair })
    await keyPairCore.ready()

    assert.deepEqual(
      Buffer.from(namedCore.key),
      Buffer.from(keyPairCore.key)
    )
  } finally {
    try { await keyPairCore?.close?.() } catch {}
    try { await namedCore?.close?.() } catch {}
    try { await store?.close?.() } catch {}
    await fs.rm(storagePath, { recursive: true, force: true })
  }
})

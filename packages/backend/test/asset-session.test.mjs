import test from 'brittle'

import { createAssetSession } from '../src/assets/asset-session.js'

function rendition(id = '1', blocked = false) {
  return {
    renditionId: `rendition-${id}`,
    superseded: false,
    blocked,
    core: { key: id.repeat(64).slice(0, 64), length: 10, treeHash: `${Number(id) + 1}`.repeat(64).slice(0, 64), byteLength: 1024 },
  }
}

test('asset session opens only manifest-approved rendition cores', async (t) => {
  const opened = []
  const session = createAssetSession({ manifest: { body: { renditions: [rendition('1')] } }, openCore: key => opened.push(key) })
  t.is(await session.authorizeCore({ renditionId: 'rendition-1', coreKey: '1'.repeat(64) }), true)
  t.is(await session.authorizeCore({ renditionId: 'rendition-1', coreKey: '2'.repeat(64) }), false)
  t.is(await session.authorizeCore({ renditionId: 'missing', coreKey: '1'.repeat(64) }), false)
  t.alike(opened, ['1'.repeat(64)])
})

test('asset session rejects private metadata, superseded, blocked, and unknown cores before replication opens', async (t) => {
  const opened = []
  const session = createAssetSession({ manifest: { body: { renditions: [rendition('1'), { ...rendition('2'), superseded: true }, rendition('3', true)] } }, openCore: key => opened.push(key) })
  t.is(await session.authorizeCore({ renditionId: 'private-metadata', coreKey: '9'.repeat(64) }), false)
  t.is(await session.authorizeCore({ renditionId: 'rendition-2', coreKey: '2'.repeat(64) }), false)
  t.is(await session.authorizeCore({ renditionId: 'rendition-3', coreKey: '3'.repeat(64) }), false)
  t.alike(opened, [])
})

test('asset session disconnect releases discoveries, core sessions, and reservations', async (t) => {
  const session = createAssetSession({ manifest: { body: { renditions: [rendition('1')] } } })
  await session.authorizeCore({ renditionId: 'rendition-1', coreKey: '1'.repeat(64) })
  t.is(session.activeCoreCount(), 1)
  session.close()
  t.is(session.activeCoreCount(), 0)
})

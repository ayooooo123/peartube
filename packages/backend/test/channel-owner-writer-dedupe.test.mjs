/* eslint-disable no-empty */
import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'

import { createChannel, loadChannel } from '../src/storage.js'

function mkCtx () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-owner-writer-'))
  const store = new Corestore(dir)
  return {
    dir,
    store,
    channels: new Map(),
    metaDb: { async put () {} },
    swarm: null
  }
}

async function cleanup (ctx) {
  try { await ctx.store.close() } catch {}
  try { fs.rmSync(ctx.dir, { recursive: true, force: true }) } catch {}
}

// A fresh channel must list exactly one device (the creator) and never a
// phantom "synced device". Regression for the owner writer-key divergence:
// createChannel used to open without the writer keypair the load paths use, so
// the owner ended up with two writer-table records across sessions.
test('fresh channel has a single owner writer using the load-path writer key', async (t) => {
  const ctx = mkCtx()
  await ctx.store.ready()
  t.teardown(() => cleanup(ctx))

  const writerKeyName = `peartube-channel-writer:${'ab'.repeat(32)}`
  const { channel } = await createChannel(ctx, { encrypt: false, writerKeyName })

  // Mirror the identity-creation flow which names the local device.
  await channel.ensureLocalBlobDrive({ deviceName: 'My Phone' })

  // The owner writer key must be the one derived from the writer key name —
  // the SAME key every later loadChannel(writerKeyName) open uses — so creation
  // and load agree on a single owner record.
  const expectedWriterKeyHex = Buffer.from((await ctx.store.createKeyPair(writerKeyName)).publicKey).toString('hex')

  const writers = await channel.listWriters()
  t.is(writers.length, 1, 'exactly one writer after creation')
  t.is(writers[0].deviceName, 'My Phone', 'the single writer is the named local device')
  t.is(writers[0].keyHex, expectedWriterKeyHex, 'owner writer key matches the writer-key-name derivation used on load')
})

// Reloading the owner's channel — with OR without the writer key name — must not
// mint a second owner record.
test('reloading the owner channel does not add a phantom synced device', async (t) => {
  const ctx = mkCtx()
  await ctx.store.ready()
  t.teardown(() => cleanup(ctx))

  const writerKeyName = `peartube-channel-writer:${'cd'.repeat(32)}`
  const { channel, channelKeyHex } = await createChannel(ctx, { encrypt: false, writerKeyName })
  await channel.ensureLocalBlobDrive({ deviceName: 'Laptop' })
  await channel.close()
  ctx.channels.delete(channelKeyHex)

  // Reload the way startup does (with the writer key name).
  const reloaded = await loadChannel(ctx, channelKeyHex, { writerKeyName, preferWritable: true })
  let writers = await reloaded.listWriters()
  t.is(writers.length, 1, 'no phantom owner after a writer-keyed reload')
  t.is(writers[0].deviceName, 'Laptop')
  await reloaded.close()
  ctx.channels.delete(channelKeyHex)

  // Reload the way a racing read path does (no writer key name) — the fallback
  // writer-key derivation must adopt the existing owner instead of duplicating.
  const reloadedPlain = await loadChannel(ctx, channelKeyHex, { preferWritable: true })
  writers = await reloadedPlain.listWriters()
  t.is(writers.length, 1, 'no phantom owner after a fallback-keyed reload')
  t.is(writers[0].deviceName, 'Laptop')
})

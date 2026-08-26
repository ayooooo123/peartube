/**
 * Verifies the personal-sync HRPC commands are wired end-to-end:
 * registerSharedHandlers resolves each command to backend.api.<method>, the
 * handler is invoked with the decoded request, and a real PersonalStore-backed
 * api returns the correct response envelope.
 */
import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'

import { registerSharedHandlers, SHARED_HANDLER_NAMES } from '../src/hrpc-handlers.js'
import { createApi } from '../src/api.js'
import { PersonalStore } from '../src/personal/personal-store.js'
import { installSeedPinIdentityMutationHooks } from '../src/seed-pin/index.js'

const PERSONAL_HANDLERS = [
  'GetPlaylists', 'GetPlaylistItems', 'CreatePlaylist', 'UpdatePlaylist', 'DeletePlaylist',
  'AddToPlaylist', 'RemoveFromPlaylist', 'LogWatchHistory', 'GetWatchHistory',
  'GetResumePosition', 'ListResumePositions', 'SetPersonalSetting', 'GetPersonalSettings',
  'ProvisionPersonalEncryption'
]

test('raw personal encryption secret is not exposed as a shared app HRPC handler', (t) => {
  t.absent(SHARED_HANDLER_NAMES.includes('GetPersonalEncryptionSecret'), 'shared app RPC must not expose key export')
})

test('identity mutation hooks await personal store activation before returning', async (t) => {
  let releaseActivation
  const activation = new Promise((resolve) => { releaseActivation = resolve })
  const events = []
  const identityManager = {
    async setActiveIdentity(publicKey) {
      events.push(`identity:${publicKey}`)
      return { publicKey }
    },
  }
  const removeHooks = installSeedPinIdentityMutationHooks({
    identityManager,
    onMutation: async () => {
      events.push('personal:start')
      await activation
      events.push('personal:ready')
    },
  })

  let settled = false
  const pending = identityManager.setActiveIdentity('publisher').then((result) => {
    settled = true
    return result
  })
  await new Promise((resolve) => setImmediate(resolve))

  t.is(settled, false)
  t.alike(events, ['identity:publisher', 'personal:start'])
  releaseActivation()
  t.alike(await pending, { publicKey: 'publisher' })
  t.alike(events, ['identity:publisher', 'personal:start', 'personal:ready'])
  removeHooks()
})

test('identity mutation hooks serialize identity and personal-store activation transactions', async t => {
  let releaseB
  const bActivation = new Promise(resolve => { releaseB = resolve })
  let activePublicKey = 'identity-a'
  const events = []
  const identityManager = {
    getActivePublicKey() { return activePublicKey },
    async setActiveIdentity(publicKey) {
      activePublicKey = publicKey
      events.push(`identity:${publicKey}`)
    },
  }
  const removeHooks = installSeedPinIdentityMutationHooks({
    identityManager,
    onMutation: async () => {
      const publicKey = activePublicKey
      events.push(`personal:${publicKey}:start`)
      if (publicKey === 'identity-b') await bActivation
      events.push(`personal:${publicKey}:ready`)
    },
  })

  const switchB = identityManager.setActiveIdentity('identity-b')
  await new Promise(resolve => setImmediate(resolve))
  const switchC = identityManager.setActiveIdentity('identity-c')
  await new Promise(resolve => setImmediate(resolve))
  t.alike(
    events,
    ['identity:identity-b', 'personal:identity-b:start'],
    'C cannot persist while the B PersonalStore transaction is in flight',
  )

  releaseB()
  await Promise.all([switchB, switchC])
  t.alike(events, [
    'identity:identity-b',
    'personal:identity-b:start',
    'personal:identity-b:ready',
    'identity:identity-c',
    'personal:identity-c:start',
    'personal:identity-c:ready',
  ])
  removeHooks()
})

test('identity mutation hooks compensate every mutation that changes the active identity', async t => {
  let activePublicKey = 'identity-a'
  const rollbacks = []
  const identityManager = {
    getActivePublicKey() { return activePublicKey },
    async setActiveIdentity(publicKey) {
      activePublicKey = publicKey
    },
    async addPairedChannelIdentity() {
      activePublicKey = 'identity-b'
      return { publicKey: activePublicKey }
    },
  }
  const removeHooks = installSeedPinIdentityMutationHooks({
    identityManager,
    onMutation: async mutation => {
      if (mutation.method === 'addPairedChannelIdentity') throw new Error('PersonalStore activation rejected')
    },
    onRollback: async rollback => {
      rollbacks.push(rollback)
    },
  })

  await t.exception(
    identityManager.addPairedChannelIdentity('channel-b'),
    /PersonalStore activation rejected/,
  )
  t.is(activePublicKey, 'identity-a', 'the previously active identity is restored')
  t.is(rollbacks.length, 1)
  t.is(rollbacks[0].mutation.method, 'addPairedChannelIdentity')
  t.is(rollbacks[0].failedPublicKey, 'identity-b')
  removeHooks()
})

test('personal-sync commands are registered as shared handlers', (t) => {
  for (const name of PERSONAL_HANDLERS) {
    t.ok(SHARED_HANDLER_NAMES.includes(name), `${name} in SHARED_HANDLER_NAMES`)
  }
})

test('personal-sync HRPC commands round-trip through the api + PersonalStore', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-wiring-'))
  const store = new Corestore(dir)
  await store.ready()
  const personal = new PersonalStore(store, {})
  await personal.ready()

  // Minimal ctx: createApi only needs ctx.personal for these methods.
  const ctx = { personal, metaDb: { async get () { return null }, async put () {} }, channels: new Map() }
  const api = createApi({ ctx, seedingManager: null, videoStats: null })

  // Capture registered handlers from a fake rpc exposing on<Name>(fn).
  const handlers = {}
  const fakeRpc = {}
  for (const name of SHARED_HANDLER_NAMES) {
    fakeRpc[`on${name}`] = (fn) => { handlers[name] = fn }
  }
  registerSharedHandlers(fakeRpc, { api })

  const call = (name, req) => handlers[name](req)

  const created = await call('CreatePlaylist', { name: 'Watch Later' })
  t.ok(created.success && created.id, 'CreatePlaylist returns { success, id }')

  await call('AddToPlaylist', { playlistId: created.id, channelKey: 'c'.repeat(64), videoId: 'v1' })
  const items = await call('GetPlaylistItems', { playlistId: created.id })
  t.is(items.items.length, 1, 'GetPlaylistItems returns { items: [1] }')

  const playlists = await call('GetPlaylists', {})
  t.is(playlists.playlists.length, 1, 'GetPlaylists returns { playlists: [1] }')

  await call('LogWatchHistory', { videoKey: 'vk1', title: 'Ep', duration: 600, position: 90 })
  const hist = await call('GetWatchHistory', { limit: 10 })
  t.is(hist.entries[0].videoKey, 'vk1', 'GetWatchHistory returns { entries } newest-first')
  const resume = await call('GetResumePosition', { videoKey: 'vk1' })
  t.ok(resume.found && resume.resume.position === 90, 'GetResumePosition returns { found, resume }')

  await call('SetPersonalSetting', { key: 'theme', value: JSON.stringify('dark') })
  const settings = await call('GetPersonalSettings', {})
  const theme = settings.settings.find((s) => s.key === 'theme')
  t.is(JSON.parse(theme.value), 'dark', 'settings round-trip JSON-encoded values')

  await call('DeletePlaylist', { id: created.id })
  t.is((await call('GetPlaylists', {})).playlists.length, 0, 'DeletePlaylist removes it')

  await personal.close()
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

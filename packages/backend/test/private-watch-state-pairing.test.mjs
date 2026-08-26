/**
 * Personal-store device pairing.
 *
 * Viewer state lives in the encrypted PersonalStore and never leaves the device
 * unless the user explicitly pairs another of their own devices. These tests
 * pin that contract: invites are user-initiated, single-use and expire within
 * five minutes; exactly one concurrent redemption wins; a replay loses; a paired
 * device merges state; revocation rotates forward into a new encrypted epoch
 * that every retained device must re-pair into; the keychain secret leaves the
 * backend only in the redeem response; there is no unencrypted fallback; and
 * none of it touches publisher-channel pairing.
 */
import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createPersonalManager } from '../src/personal/personal-manager.js'
import { PersonalStore, PERSONAL_INVITE_MAX_TTL_MS } from '../src/personal/personal-store.js'
import { createPersonalApi } from '../src/api/personal.js'
import { SHARED_HANDLER_NAMES } from '../src/hrpc-handlers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendSrc = path.join(here, '../src')
const schema = JSON.parse(fs.readFileSync(path.join(here, '../../spec/spec/schema/schema.json'), 'utf8'))

const PERSONAL_PAIRING_HANDLERS = [
  'CreatePersonalDeviceInvite',
  'RedeemPersonalDeviceInvite',
  'ListPersonalDevices',
  'RevokePersonalDevice',
]
const PUBLISHER_PAIRING_METHODS = ['createDeviceInvite', 'pairDevice', 'listDevices']

function memoryMetaDb() {
  const rows = new Map()
  return {
    async get(key) { return rows.has(key) ? { value: rows.get(key) } : null },
    async put(key, value) { rows.set(key, value) },
  }
}

function freshSecretHex() {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

/** Peer discovery over a local DHT is not instant; poll instead of guessing. */
async function waitFor(check, { timeout = 30000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/** One device: its own corestore, swarm and personal manager. */
async function createDevice(t, { bootstrap = null, metaDb = memoryMetaDb(), onActiveStoreChanged = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-pairing-'))
  const store = new Corestore(dir)
  await store.ready()
  const swarm = bootstrap ? new Hyperswarm({ bootstrap }) : null
  const ctx = { store, swarm, metaDb, personal: null, channels: new Map() }
  const personalManager = createPersonalManager({ ctx, identityManager: null, onActiveStoreChanged })
  ctx.personalManager = personalManager
  const api = createPersonalApi({ ctx })

  t.teardown(async () => {
    await personalManager.close().catch(() => {})
    if (swarm) await swarm.destroy().catch(() => {})
    await store.close().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  })

  return { dir, store, swarm, ctx, personalManager, api }
}

test('personal pairing commands are registered as shared HRPC handlers', (t) => {
  for (const name of PERSONAL_PAIRING_HANDLERS) {
    t.ok(SHARED_HANDLER_NAMES.includes(name), `${name} in SHARED_HANDLER_NAMES`)
  }
})

test('the keychain secret leaves the backend only in the redeem response', async (t) => {
  const responsesWithSecret = schema.schema
    .filter((type) => type.name.endsWith('-response'))
    .filter((type) => (type.fields || []).some((field) => field.name === 'secret'))
    .map((type) => type.name)
  t.alike(responsesWithSecret, ['redeem-personal-device-invite-response'], 'only the redeem response carries a secret')

  const provision = schema.schema.find((type) => type.name === 'provision-personal-encryption-response')
  t.absent(
    (provision.fields || []).some((field) => field.name === 'secret'),
    'provisioning never hands a secret back to the platform'
  )
  const provisionRequest = schema.schema.find((type) => type.name === 'provision-personal-encryption-request')
  t.ok(
    (provisionRequest.fields || []).find((field) => field.name === 'secret')?.required,
    'the platform must supply the secret; the backend never generates one'
  )

  const device = await createDevice(t)
  const provisioned = await device.api.provisionPersonalEncryption({ secret: freshSecretHex(), deviceLocal: true })
  t.ok(provisioned.success && provisioned.encrypted, 'the device-local store opened encrypted')
  t.absent('secret' in provisioned, 'provisionPersonalEncryption response has no secret field')

  const devices = await device.api.listPersonalDevices()
  t.absent('secret' in devices, 'listPersonalDevices response has no secret field')
  t.absent(devices.devices.some((entry) => 'secret' in entry), 'no device roster entry carries a secret')
})

test('a device without a secure vault stays device-local with pairing disabled', async (t) => {
  const source = fs.readFileSync(path.join(backendSrc, 'personal/personal-manager.js'), 'utf8')
  t.absent(/allowUnencrypted/.test(source), 'no unencrypted-store option survives in the manager')
  t.absent(/ensureActiveUnencrypted/.test(source), 'no unencrypted fallback entry point survives')

  const device = await createDevice(t)
  t.is(typeof device.personalManager.ensureActiveUnencrypted, 'undefined', 'unencrypted fallback is not callable')
  t.is(
    await device.personalManager.openForIdentity({ publicKey: 'a'.repeat(64) }),
    null,
    'no secret, no store: viewer state stays device-local'
  )
  t.is(device.ctx.personal, null, 'nothing was opened unencrypted')

  t.alike(
    await device.api.createPersonalDeviceInvite({}),
    { success: false, error: 'personal-store-unavailable' },
    'inviting is refused without an encrypted store'
  )
  t.alike(
    await device.api.listPersonalDevices(),
    { success: false, error: 'personal-store-unavailable' },
    'listing devices is refused without an encrypted store'
  )
  t.alike(
    await device.api.revokePersonalDevice({ keyHex: 'b'.repeat(64), secret: freshSecretHex() }),
    { success: false, error: 'personal-store-unavailable' },
    'revoking is refused without an encrypted store'
  )
  t.alike(
    await device.api.redeemPersonalDeviceInvite({ inviteCode: 'not a real invite' }),
    { success: false, error: 'invalid-invite-code' },
    'a malformed invite is rejected structurally, never thrown'
  )
})

test('personal pairing rejects bad input structurally instead of throwing', async (t) => {
  const device = await createDevice(t)
  const secret = freshSecretHex()
  await device.personalManager.provisionSecret({ secret, deviceLocal: true })
  t.ok(device.ctx.personal?.encrypted, 'the device-local store opened encrypted')

  t.alike(
    await device.api.createPersonalDeviceInvite({}),
    { success: false, error: 'personal-pairing-unavailable' },
    'no swarm, no pairing'
  )
  t.alike(
    await device.api.revokePersonalDevice({ keyHex: 'nope', secret: freshSecretHex() }),
    { success: false, error: 'invalid-device-key' }
  )
  t.alike(
    await device.api.revokePersonalDevice({ keyHex: 'b'.repeat(64), secret: 'too-short' }),
    { success: false, error: 'personal-secret-required' },
    'revocation demands a fresh 32-byte platform secret'
  )
  t.alike(
    await device.api.revokePersonalDevice({ keyHex: device.ctx.personal.localKeyHex, secret: freshSecretHex() }),
    { success: false, error: 'cannot-revoke-local-device' }
  )
  t.alike(
    await device.api.revokePersonalDevice({ keyHex: 'b'.repeat(64), secret }),
    { success: false, error: 'personal-secret-reused' },
    'rotation must move forward onto a new secret'
  )
})

test('a revoke that cannot finish tells the platform whether the rotation is durable', async (t) => {
  const rosterKey = b4a.toString(crypto.randomBytes(32), 'hex')

  // Nowhere durable to record the new epoch: refuse before touching anything.
  const vaultless = await createDevice(t, { metaDb: null })
  await vaultless.personalManager.provisionSecret({ secret: freshSecretHex(), deviceLocal: true })
  await vaultless.ctx.personal.addWriter(rosterKey, { deviceName: 'Other' })
  t.alike(
    await vaultless.api.revokePersonalDevice({ keyHex: rosterKey, secret: freshSecretHex() }),
    { success: false, error: 'personal-epoch-unavailable' },
    'rotation is refused when the new epoch namespace cannot be recorded'
  )

  // The epoch write itself fails, so nothing durable happened: the platform
  // keeps the secret it already held.
  const rows = new Map()
  let failEpochWrite = false
  const unreliableMetaDb = {
    async get(key) { return rows.has(key) ? { value: rows.get(key) } : null },
    async put(key, value) {
      if (failEpochWrite && key.startsWith('personal-epoch:')) throw new Error('meta write failed')
      rows.set(key, value)
    },
  }
  const unrotated = await createDevice(t, { metaDb: unreliableMetaDb })
  const keptSecret = freshSecretHex()
  await unrotated.personalManager.provisionSecret({ secret: keptSecret, deviceLocal: true })
  await unrotated.ctx.personal.addWriter(rosterKey, { deviceName: 'Other' })
  const untouched = unrotated.ctx.personal
  failEpochWrite = true
  t.alike(
    await unrotated.api.revokePersonalDevice({ keyHex: rosterKey, secret: freshSecretHex() }),
    { success: false, error: 'personal-revoke-failed' },
    'a rotation that never became durable reports the unambiguous failure'
  )
  t.is(unrotated.ctx.personal, untouched, 'the active store is untouched')
  t.is(unrotated.ctx.personal.secretHex, keptSecret, 'and is still keyed by the secret the platform holds')
  t.ok(
    (await unrotated.api.logWatchHistory({ videoKey: 'after:failed-rotation', position: 1 })).success,
    'and takes writes again: a rotation that never happened does not leave the store frozen'
  )

  // The epoch is durable but activation fails: the platform must keep the
  // secret it just supplied, because a restart reopens the rotated store.
  let failActivation = false
  const incomplete = await createDevice(t, {
    onActiveStoreChanged: async () => { if (failActivation) throw new Error('activation failed') },
  })
  await incomplete.personalManager.provisionSecret({ secret: freshSecretHex(), deviceLocal: true })
  await incomplete.ctx.personal.addWriter(rosterKey, { deviceName: 'Other' })
  failActivation = true
  t.alike(
    await incomplete.api.revokePersonalDevice({ keyHex: rosterKey, secret: freshSecretHex() }),
    { success: false, error: 'personal-revoke-incomplete' },
    'a durable rotation reports the ambiguous failure the platform must not roll back'
  )
  const epoch = (await incomplete.ctx.metaDb.get('personal-epoch:device-local'))?.value
  t.is(epoch?.epoch, 1, 'the rotated epoch is recorded so a restart lands on it')
  t.ok(/^[0-9a-f]{64}$/.test(epoch?.bootstrapKey || ''), 'with the new epoch bootstrap key')
  t.absent('secret' in epoch, 'and the epoch record never stores the secret')
  t.ok(
    (await incomplete.api.logWatchHistory({ videoKey: 'after:incomplete-rotation', position: 1 })).success,
    'the store the caller is left on still takes writes rather than staying frozen'
  )
})

test('watch state is written to the device-local encrypted store with identity and ordering', async (t) => {
  const device = await createDevice(t)
  await device.personalManager.provisionSecret({ secret: freshSecretHex(), deviceLocal: true })

  const identity = { entityRef: 'entity:tt1', editionRef: 'edition:1080p', memberRef: 'member:s1e1' }
  const logged = await device.api.logWatchHistory({
    identity,
    videoKey: 'legacy:key',
    title: 'Episode One',
    duration: 1200,
    position: 300,
    saved: true,
  })
  t.ok(logged.success && typeof logged.eventId === 'string', 'the write path returns an event id')

  const [record] = await device.ctx.personal.listProgress()
  t.alike(record.identity, identity, 'media identity is persisted on the canonical progress record')
  t.is(record.saved, true, 'the library flag is persisted')
  t.is(record.positionSec, 300, 'position is persisted')
  t.is(record.order.playbackGeneration, 0, 'the first watch is generation zero')
  t.ok(record.order.lamport > 0 && record.order.writerKey.length === 64, 'the write is Lamport-stamped by this writer')

  await device.api.logWatchHistory({ identity, videoKey: 'legacy:key', position: 5, playbackGeneration: 2 })
  const [replayed] = await device.ctx.personal.listProgress()
  t.is(replayed.order.playbackGeneration, 2, 'an explicit replay starts a higher playback generation')
  t.is(replayed.positionSec, 5, 'and may reset the position')
  t.is(replayed.saved, true, 'without dropping library state')
  t.ok(replayed.order.lamport > record.order.lamport, 'the Lamport clock advances')
})

test('a write issued mid-rotation is refused as pending, then replays into the new epoch', async (t) => {
  const rosterKey = b4a.toString(crypto.randomBytes(32), 'hex')
  const rows = new Map()
  // The rotation window is only observable from inside it: pause on the epoch
  // record, written after the snapshot and before the active store is swapped.
  let onEpochRecorded = null
  const gatedMetaDb = {
    async get(key) { return rows.has(key) ? { value: rows.get(key) } : null },
    async put(key, value) {
      rows.set(key, value)
      if (!key.startsWith('personal-epoch:') || !onEpochRecorded) return
      const hook = onEpochRecorded
      onEpochRecorded = null
      await hook()
    },
  }

  const device = await createDevice(t, { metaDb: gatedMetaDb })
  await device.personalManager.provisionSecret({ secret: freshSecretHex(), deviceLocal: true })
  const abandoned = device.ctx.personal
  await abandoned.addWriter(rosterKey, { deviceName: 'Other' })
  await device.api.logWatchHistory({ videoKey: 'before:rotation', title: 'Before', duration: 600, position: 30 })

  const midRotation = {}
  onEpochRecorded = async () => {
    midRotation.store = device.ctx.personal
    midRotation.write = await device.api.logWatchHistory({ videoKey: 'mid:rotation', title: 'Mid', duration: 600, position: 42 })
    midRotation.read = await device.api.getWatchHistory({ limit: 10 })
  }

  const revoked = await device.api.revokePersonalDevice({ keyHex: rosterKey, secret: freshSecretHex() })
  t.ok(revoked.success, 'the rotation completes')
  t.is(midRotation.store, abandoned, 'the write really did race the swap: the abandoned epoch was still active')
  t.alike(
    midRotation.write,
    { success: false, error: 'personal-store-rotating' },
    'a write during the rotation is refused as pending instead of landing in the abandoned epoch'
  )
  t.is(midRotation.read.entries.length, 1, 'reads keep working while the epoch is frozen')

  const rotated = device.ctx.personal
  t.is(rotated.keyHex, revoked.bootstrapKey, 'the new epoch is active')
  t.absent(
    (await rotated.listProgress()).some((record) => record.videoKey === 'mid:rotation'),
    'the refused write was not silently carried anywhere'
  )

  const replay = await device.api.logWatchHistory({ videoKey: 'mid:rotation', title: 'Mid', duration: 600, position: 42 })
  t.ok(replay.success, 'the caller replays the pending write once the rotation finishes')
  const progress = await rotated.listProgress()
  t.is(progress.length, 2, 'the new epoch holds the carried-over write plus the replay')
  t.is(
    progress.find((record) => record.videoKey === 'mid:rotation')?.positionSec,
    42,
    'the replayed write landed in the new epoch'
  )
})

test('legacy resume rows migrate the first time a store is opened for an identity', async (t) => {
  const device = await createDevice(t)
  const publicKey = 'a'.repeat(64)
  const secret = freshSecretHex()
  const channelKey = 'b'.repeat(64)

  // A store written before canonical progress records existed: the history op
  // carries its fields flat, so applying it maintains a legacy `resume/` row.
  const legacyOp = (videoId) => ({
    type: 'log-history',
    videoKey: `${channelKey}:${videoId}`,
    channelKey,
    videoId,
    title: `Legacy ${videoId}`,
    duration: 900,
    position: 300,
    timestamp: Date.now(),
  })
  const legacy = new PersonalStore(device.store, { namespace: `peartube-personal:${publicKey}`, secret })
  await legacy.ready()
  await legacy._append(legacyOp('ep1'))
  const bootstrapKey = legacy.keyHex
  t.is((await legacy.listProgress()).length, 0, 'the legacy store holds no canonical progress record')
  t.is((await legacy.listResume()).length, 1, 'only the legacy resume row')
  await legacy.close()

  await device.personalManager.provisionSecret({ publicKey, secret })
  const store = await device.personalManager.openForIdentity({ publicKey, personalKey: bootstrapKey })
  t.ok(store?.writable, 'the manager reopened the legacy store writable')

  const [record] = await store.listProgress()
  t.is(record?.videoKey, `${channelKey}:ep1`, 'opening the store migrated the legacy row into a progress record')
  t.is(record.positionSec, 300, 'carrying its resume position')
  t.alike(
    await store.migrateLegacyResume(),
    { migrated: 0, retained: 0 },
    'and dropped the legacy source, because its replacement read back'
  )
  t.is((await device.ctx.metaDb.get('personal-resume-migrated'))?.value, true, 'the migration is recorded once per device')

  // The legacy row is the only copy of that watch state until the progress
  // record reads back, so a migration that cannot confirm it keeps the source.
  const stalled = new PersonalStore(device.store, { namespace: 'peartube-personal:stalled', secret: freshSecretHex() })
  t.teardown(() => stalled.close().catch(() => {}))
  await stalled.ready()
  await stalled._append(legacyOp('ep9'))
  const converged = stalled._readProgressRecord.bind(stalled)
  stalled._readProgressRecord = async () => null
  t.alike(
    await stalled.migrateLegacyResume(),
    { migrated: 0, retained: 1 },
    'a replacement that never reads back leaves the legacy row in place'
  )
  stalled._readProgressRecord = converged
  t.alike(await stalled.migrateLegacyResume(), { migrated: 1, retained: 0 }, 'and the retry completes the migration')
  t.is((await stalled.getResume(`${channelKey}:ep9`))?.position, 300, 'the resume position survives either way')

  // A legacy row that appears after the flag is recorded is left alone: the
  // migration runs once per device, exactly like the subscription migration.
  await store._append(legacyOp('ep2'))
  await device.personalManager.close()
  const reopenedCtx = { store: device.store, swarm: null, metaDb: device.ctx.metaDb, personal: null, channels: new Map() }
  const reopened = createPersonalManager({ ctx: reopenedCtx, identityManager: null })
  t.teardown(() => reopened.close().catch(() => {}))
  await reopened.provisionSecret({ publicKey, secret })
  const reopenedStore = await reopened.openForIdentity({ publicKey, personalKey: bootstrapKey })
  t.alike(
    await reopenedStore.migrateLegacyResume(),
    { migrated: 1, retained: 0 },
    'the second open did not migrate again'
  )
})

test('rotation takes the abandoned epoch off its discovery topic', async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const owner = await createDevice(t, { bootstrap: testnet.bootstrap })
  const rosterKey = b4a.toString(crypto.randomBytes(32), 'hex')

  await owner.personalManager.provisionSecret({ secret: freshSecretHex(), deviceLocal: true })
  const abandoned = owner.ctx.personal
  const abandonedTopic = abandoned.discoveryKey
  t.ok(owner.swarm.status(abandonedTopic), 'the live epoch announces its discovery topic')
  await abandoned.addWriter(rosterKey, { deviceName: 'Other' })

  const revoked = await owner.api.revokePersonalDevice({ keyHex: rosterKey, secret: freshSecretHex() })
  t.ok(revoked.success, 'the rotation completes')
  t.absent(
    owner.swarm.status(abandonedTopic),
    'the abandoned epoch left its discovery topic, so it stops announcing and replicating'
  )
  t.ok(owner.swarm.status(owner.ctx.personal.discoveryKey), 'while the new epoch announces its own')
})

test('personal pairing never touches publisher-channel pairing', async (t) => {
  for (const relative of ['personal/personal-manager.js', 'api/personal.js']) {
    const source = fs.readFileSync(path.join(backendSrc, relative), 'utf8')
    const imports = [...source.matchAll(/^import[^\n]*from '([^']+)'/gm)].map((match) => match[1])
    t.absent(
      imports.some((specifier) => /channel|storage\.js|pairing\.js/.test(specifier)),
      `${relative} imports no channel/publisher-pairing module`
    )
  }

  // Publisher pairing stays in its own api group (api/pairing.js), reachable
  // only through Studio. Personal pairing never reaches for channel state.
  const exploding = new Proxy({}, {
    get() { throw new Error('publisher channel state must not be touched by personal pairing') },
  })
  const ctx = { store: null, swarm: null, metaDb: memoryMetaDb(), personal: null, channels: exploding }
  const api = createPersonalApi({ ctx })
  for (const method of PUBLISHER_PAIRING_METHODS) {
    t.absent(method in api, `personal api does not expose publisher ${method}`)
  }
  t.alike(await api.createPersonalDeviceInvite({}), { success: false, error: 'personal-store-unavailable' })
  t.alike(await api.listPersonalDevices(), { success: false, error: 'personal-store-unavailable' })
  t.alike(await api.redeemPersonalDeviceInvite({ inviteCode: 'x' }), { success: false, error: 'personal-store-unavailable' })
  t.alike(await api.revokePersonalDevice({ keyHex: 'a'.repeat(64), secret: freshSecretHex() }), {
    success: false,
    error: 'personal-store-unavailable',
  })
})

test('invites clamp, serialize and expire; pairing merges state; revocation rotates forward', async (t) => {
  t.timeout(10 * 60 * 1000)
  const testnet = await createTestnet(3, t.teardown)

  const owner = await createDevice(t, { bootstrap: testnet.bootstrap })
  const first = await createDevice(t, { bootstrap: testnet.bootstrap })
  const second = await createDevice(t, { bootstrap: testnet.bootstrap })
  const retained = await createDevice(t, { bootstrap: testnet.bootstrap })

  const ownerSecret = freshSecretHex()
  await owner.personalManager.provisionSecret({ secret: ownerSecret, deviceLocal: true })
  t.ok(owner.ctx.personal?.encrypted && owner.ctx.personal?.writable, 'owner store is encrypted and writable')

  const channelKey = 'a'.repeat(64)
  await owner.ctx.personal.subscribe(channelKey, { name: 'Carried Over' })
  await owner.ctx.personal.logHistory({
    videoKey: `${channelKey}:ep1`,
    channelKey,
    videoId: 'ep1',
    title: 'Episode One',
    duration: 1200,
    position: 480,
    saved: true,
  })

  // --- invites are clamped to five minutes -----------------------------------
  const invite = await owner.api.createPersonalDeviceInvite({ expiresInMs: 60 * 60 * 1000 })
  const mintedAt = Date.now()
  t.ok(invite.success && typeof invite.inviteCode === 'string' && invite.inviteCode.length > 0, 'invite minted')
  t.ok(
    invite.expiresAt - mintedAt <= PERSONAL_INVITE_MAX_TTL_MS,
    'a one-hour request is clamped to the five-minute ceiling'
  )
  t.ok(invite.expiresAt > mintedAt, 'the clamped invite is still live')
  t.absent('secret' in invite, 'minting an invite never exposes the secret')

  const reminted = await owner.api.createPersonalDeviceInvite({})
  t.not(reminted.inviteCode, invite.inviteCode, 'every create mints a fresh single-use invite')

  // --- exactly one concurrent redemption wins --------------------------------
  const [firstResult, secondResult] = await Promise.all([
    first.personalManager.redeemPersonalDeviceInvite({ inviteCode: invite.inviteCode, deviceName: 'First', timeoutMs: 45000 }),
    second.personalManager.redeemPersonalDeviceInvite({ inviteCode: invite.inviteCode, deviceName: 'Second', timeoutMs: 45000 }),
  ])
  const winners = [firstResult, secondResult].filter((result) => result.success)
  const losers = [firstResult, secondResult].filter((result) => !result.success)
  t.is(winners.length, 1, 'exactly one concurrent redemption of a single-use invite succeeds')
  t.is(losers.length, 1, 'the concurrent loser is refused')
  t.ok(
    ['personal-pairing-timeout', 'personal-pairing-rejected', 'personal-pairing-failed'].includes(losers[0].error),
    `loser reports a structured pairing failure (${losers[0].error})`
  )

  const paired = firstResult.success ? first : second
  const rejected = firstResult.success ? second : first
  t.is(winners[0].secret, ownerSecret, 'the joining device receives the keychain secret exactly once')
  t.is(winners[0].bootstrapKey, owner.ctx.personal.keyHex, 'and the personal-store bootstrap key')

  const roster = await owner.api.listPersonalDevices()
  t.is(roster.devices.length, 2, 'the owner grants exactly one new writer')
  t.is(roster.devices.filter((device) => device.self).length, 1, 'the local writer is marked self')
  t.is(roster.devices.find((device) => !device.self).deviceName, paired === first ? 'First' : 'Second')

  // --- a replayed invite is rejected -----------------------------------------
  const replay = await rejected.personalManager.redeemPersonalDeviceInvite({
    inviteCode: invite.inviteCode,
    deviceName: 'Replay',
    timeoutMs: 20000,
  })
  t.absent(replay.success, 'replaying a consumed invite fails')
  t.is((await owner.api.listPersonalDevices()).devices.length, 2, 'the replay grants no extra writer')

  // --- a paired device merges state ------------------------------------------
  t.ok(paired.ctx.personal?.writable, 'the paired device opened writable')
  t.ok(paired.ctx.personal?.encrypted, 'and encrypted with the shared keychain secret')
  const mergedSubscriptions = await paired.ctx.personal.listSubscriptions()
  t.is(mergedSubscriptions.length, 1, 'subscriptions replicated to the paired device')
  t.is(mergedSubscriptions[0].name, 'Carried Over')
  const mergedProgress = await paired.ctx.personal.listProgress()
  t.is(mergedProgress.length, 1, 'watch progress replicated to the paired device')
  t.is(mergedProgress[0].positionSec ?? mergedProgress[0].position, 480, 'position survived the merge')

  await paired.ctx.personal.subscribe('c'.repeat(64), { name: 'From Paired Device' })
  const writtenBack = await waitFor(async () => {
    await owner.ctx.personal.update()
    return (await owner.ctx.personal.listSubscriptions()).length === 2
  })
  t.ok(writtenBack, 'the paired device writes back into the shared store')

  // --- a second device joins so revocation has something to retain -----------
  const retainedInvite = await owner.api.createPersonalDeviceInvite({})
  const retainedResult = await retained.personalManager.redeemPersonalDeviceInvite({
    inviteCode: retainedInvite.inviteCode,
    deviceName: 'Retained',
    timeoutMs: 120000,
  })
  t.ok(retainedResult.success, 'a second device pairs')
  t.is((await owner.api.listPersonalDevices()).devices.length, 3, 'two paired devices plus this one')

  // --- revocation rotates forward into a new encrypted epoch -----------------
  const revokedKey = paired.ctx.personal.localKeyHex
  const abandoned = owner.ctx.personal
  const abandonedKey = abandoned.keyHex
  const abandonedTopic = abandoned.discoveryKey
  const rotatedSecret = freshSecretHex()
  const revoked = await owner.api.revokePersonalDevice({ keyHex: revokedKey, secret: rotatedSecret, deviceName: 'First' })

  t.ok(revoked.success, 'revocation succeeds')
  t.absent('secret' in revoked, 'the revoke response never carries the secret')
  t.not(revoked.bootstrapKey, abandonedKey, 'revocation rotates onto a new store epoch')
  t.is(revoked.remainingDeviceCount, 1, 'only this device is authorized in the new epoch')
  t.absent(
    owner.swarm.status(abandonedTopic),
    'the old epoch stops joining and replicating: its discovery topic is gone from the swarm'
  )
  t.is(owner.ctx.personal.keyHex, revoked.bootstrapKey, 'the new epoch is active')
  t.is(owner.ctx.personal.secretHex, rotatedSecret, 'keyed by the freshly supplied platform secret')

  const rotatedRoster = await owner.api.listPersonalDevices()
  t.is(rotatedRoster.devices.length, 1, 'the new epoch authorizes only the local writer')
  t.ok(rotatedRoster.devices[0].self)
  t.absent(
    rotatedRoster.devices.some((device) => device.keyHex === revokedKey),
    'the revoked device is not a writer in the new epoch'
  )
  t.is((await owner.ctx.personal.listSubscriptions()).length, 2, 'bounded state is carried into the new epoch')
  t.is((await owner.ctx.personal.listProgress()).length, 1, 'watch progress is carried into the new epoch')

  t.alike(
    await owner.api.revokePersonalDevice({ keyHex: revokedKey, secret: freshSecretHex() }),
    { success: false, error: 'device-not-found' },
    'the revoked device cannot be revoked twice'
  )

  // --- retained devices must re-pair -----------------------------------------
  t.not(retained.ctx.personal?.keyHex, revoked.bootstrapKey, 'a retained device is still on the abandoned epoch')
  const rejoin = await owner.api.createPersonalDeviceInvite({})
  const rejoined = await retained.personalManager.redeemPersonalDeviceInvite({
    inviteCode: rejoin.inviteCode,
    deviceName: 'Retained Again',
    timeoutMs: 120000,
  })
  t.ok(rejoined.success, 'a retained device regains access only by re-pairing')
  t.is(rejoined.secret, rotatedSecret, 'and receives the new epoch secret')
  t.is(retained.ctx.personal?.keyHex, revoked.bootstrapKey, 'the retained device is now on the new epoch')
  t.is((await owner.api.listPersonalDevices()).devices.length, 2, 'the re-paired device is authorized again')

  // --- the revoked device cannot write the new epoch -------------------------
  const intruder = new PersonalStore(paired.store, {
    namespace: 'peartube-personal-revoked-device',
    key: revoked.bootstrapKey,
    secret: ownerSecret,
    swarm: paired.swarm,
  })
  t.teardown(() => intruder.close().catch(() => {}))
  await intruder.ready()
  await intruder.setupPairing(paired.swarm)
  t.absent(await intruder.waitForWritable(8000).catch(() => false), 'the revoked device never becomes writable again')
  await t.exception(
    intruder.subscribe('d'.repeat(64), { name: 'Revoked write' }),
    /not writable/,
    'and cannot append to the new epoch'
  )
})

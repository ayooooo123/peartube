import test from 'brittle'

import { resolveRelayConfig } from '../src/config.js'
import {
  createRelaySeedPinAdmission,
  createRelaySeedPinCapacityPolicy,
  createRelaySeedPinReleasePolicy,
} from '../src/seed-pin-admission.js'

const TRUSTED_IDENTITY = '11'.repeat(32)
const OWNER_IDENTITY = '12'.repeat(32)
const FOREIGN_IDENTITY = '13'.repeat(32)
const ALLOWED_CHANNEL = '21'.repeat(32)
const FOREIGN_CHANNEL = '22'.repeat(32)
const DAY_MS = 24 * 60 * 60 * 1000

function verified (identityPublicKey, channelKey) {
  return {
    valid: true,
    identityPublicKey,
    requesterDevicePublicKey: '31'.repeat(32),
    channelKey,
  }
}

test('relay config includes strict seed-pin defaults and canonical trusted identity keys', (t) => {
  const config = resolveRelayConfig({
    seedPin: {
      trustedClients: [TRUSTED_IDENTITY.toUpperCase(), TRUSTED_IDENTITY, OWNER_IDENTITY],
    },
  }, { env: {} })

  t.alike(config.seedPin, {
    enabled: true,
    maxBytes: 536870912000,
    maxConcurrent: 2,
    retentionDays: 30,
    trustedClients: [TRUSTED_IDENTITY, OWNER_IDENTITY],
  })
})

test('relay config rejects ambiguous or unsafe seed-pin values', (t) => {
  const invalid = [
    { enabled: 'true' },
    { enabled: 1 },
    { maxBytes: 0 },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
    { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxConcurrent: 0 },
    { maxConcurrent: 65 },
    { maxConcurrent: 1.5 },
    { retentionDays: -1 },
    { retentionDays: 1.5 },
    { retentionDays: Number.POSITIVE_INFINITY },
    { retentionDays: Number.MAX_SAFE_INTEGER },
    { trustedClients: TRUSTED_IDENTITY },
    { trustedClients: [` ${TRUSTED_IDENTITY}`] },
    { trustedClients: [{ type: 'device', publicKey: TRUSTED_IDENTITY }] },
    { trustedClients: ['ab'] },
  ]
  for (const seedPin of invalid) {
    t.exception(() => resolveRelayConfig({ seedPin }, { env: {} }), JSON.stringify(seedPin))
  }

  t.is(resolveRelayConfig({ seedPin: { enabled: false, retentionDays: 0 } }, { env: {} }).seedPin.enabled, false)
})

test('relay seed-pin admission requires explicit authenticated identity or channel authorization', async (t) => {
  const config = resolveRelayConfig({
    admission: {
      owners: [OWNER_IDENTITY],
      channels: [ALLOWED_CHANNEL],
    },
    seedPin: {
      trustedClients: [TRUSTED_IDENTITY],
    },
  }, { env: {} })
  const admission = createRelaySeedPinAdmission({ config })

  t.is(await admission({ verified: verified(TRUSTED_IDENTITY, FOREIGN_CHANNEL) }), true, 'trusted authenticated client may submit its bound channel')
  t.is(await admission({ verified: verified(OWNER_IDENTITY, FOREIGN_CHANNEL) }), true, 'existing owner allowlist authorizes its bound channels')
  t.is(await admission({ verified: verified(FOREIGN_IDENTITY, ALLOWED_CHANNEL) }), true, 'explicit channel allowlist authorizes the verified descriptor owner')
  t.is(await admission({ verified: verified(FOREIGN_IDENTITY, FOREIGN_CHANNEL) }), false)
  t.is(await admission({
    verified: verified(FOREIGN_IDENTITY, FOREIGN_CHANNEL),
    remotePublicKey: TRUSTED_IDENTITY,
    trustedRelayKeys: [TRUSTED_IDENTITY],
  }), false, 'transport keys and live-peer status never authorize')
  t.is(await admission({ verified: { ...verified(TRUSTED_IDENTITY, FOREIGN_CHANNEL), valid: false } }), false)
})

test('relay capacity atomically accounts persisted progress and exact active reservations', async (t) => {
  const requestA = '41'.repeat(32)
  const requestB = '42'.repeat(32)
  const requestC = '43'.repeat(32)
  let usage = {
    version: 1,
    activeCount: 2,
    reservedBytes: 0,
    downloadedBytes: 60,
    usedBytes: 60,
  }
  const pinStore = {
    async getActiveUsage () { return { ...usage } },
  }
  const capacity = createRelaySeedPinCapacityPolicy({ pinStore, maxBytes: 100 })

  t.is(await capacity({
    phase: 'reserve',
    requestId: requestB,
    reservedBytes: 50,
    downloadedBytes: 20,
    persistedUsageBytes: 20,
  }), true, 'replaces the same durable request usage instead of double counting it')
  t.is(await capacity({ phase: 'reserve', requestId: requestC, reservedBytes: 11 }), false, 'accounts durable 60 + exact replacement delta 30')
  usage = { version: 1, activeCount: 2, reservedBytes: 50, downloadedBytes: 60, usedBytes: 90 }
  await capacity.persisted(requestB)
  t.is(await capacity({
    phase: 'progress',
    requestId: requestB,
    downloadedBytes: 45,
    persistedReservedBytes: 50,
    persistedUsageBytes: 50,
  }), true)
  t.alike(capacity.snapshot(), { maxBytes: 100, reservedBytes: 90, reservations: 2 })

  usage = { version: 1, activeCount: 1, reservedBytes: 0, downloadedBytes: 40, usedBytes: 40 }
  await capacity.release(requestB)
  t.alike(capacity.snapshot(), { maxBytes: 100, reservedBytes: 40, reservations: 1 })

  const atomic = createRelaySeedPinCapacityPolicy({
    pinStore: { async getActiveUsage () { return { version: 1, activeCount: 0, reservedBytes: 0, downloadedBytes: 0, usedBytes: 0 } } },
    maxBytes: 100,
  })
  const results = await Promise.all([
    atomic({ phase: 'reserve', requestId: requestA, reservedBytes: 60 }),
    atomic({ phase: 'reserve', requestId: requestB, reservedBytes: 60 }),
  ])
  t.is(results.filter(Boolean).length, 1, 'one-process reservation updates are serialized')

  const disabledCapacity = createRelaySeedPinCapacityPolicy({
    pinStore: { async getActiveUsage () { return { version: 1, activeCount: 0, reservedBytes: 0, downloadedBytes: 0, usedBytes: 0 } } },
    maxBytes: 0,
  })
  t.is(await disabledCapacity({ phase: 'reserve', requestId: requestC, reservedBytes: 1 }), false, 'zero capacity accepts no pins; disabling uses seedPin.enabled=false')
})

test('successful durable refresh reconciles earlier committed pending reservations', async (t) => {
  const requestA = '51'.repeat(32)
  const requestB = '52'.repeat(32)
  const requestC = '53'.repeat(32)
  let usage = { version: 1, activeCount: 2, reservedBytes: 0, downloadedBytes: 0, usedBytes: 0 }
  let failNextUsageRead = false
  const pinStore = {
    async getActiveUsage () {
      if (failNextUsageRead) {
        failNextUsageRead = false
        throw new Error('transient ledger read')
      }
      return { ...usage }
    },
  }
  const capacity = createRelaySeedPinCapacityPolicy({ pinStore, maxBytes: 100 })
  await capacity.ready
  t.is(await capacity({ phase: 'reserve', requestId: requestA, reservedBytes: 60 }), true)
  usage = { version: 1, activeCount: 2, reservedBytes: 60, downloadedBytes: 0, usedBytes: 60 }
  failNextUsageRead = true
  await t.exception(capacity.persisted(requestA))
  t.is(await capacity({ phase: 'reserve', requestId: requestC, reservedBytes: 5 }), true)

  t.is(await capacity({ phase: 'reserve', requestId: requestB, reservedBytes: 30 }), true)
  usage = { version: 1, activeCount: 2, reservedBytes: 90, downloadedBytes: 0, usedBytes: 90 }
  await capacity.persisted(requestB)
  t.alike(capacity.snapshot(), { maxBytes: 100, reservedBytes: 95, reservations: 2 })
})

test('relay capacity readiness uses one bounded aggregate read without listing active pins', async (t) => {
  let usageReads = 0
  const pinStore = {
    async getActiveUsage () {
      usageReads++
      return {
        version: 1,
        activeCount: 1025,
        reservedBytes: 1025,
        downloadedBytes: 1025,
        usedBytes: 1025,
      }
    },
    async listActive () {
      throw new Error('capacity readiness must not scan active records')
    },
  }
  const capacity = createRelaySeedPinCapacityPolicy({ pinStore, maxBytes: 1026 })
  await capacity.ready
  t.is(usageReads, 1)
  t.alike(capacity.snapshot(), { maxBytes: 1026, reservedBytes: 1025, reservations: 1025 })
  t.is(await capacity({
    phase: 'reserve',
    requestId: 'ff'.repeat(32),
    reservedBytes: 1,
  }), true, 'new exact reservation uses the durable aggregate ledger')
})

test('relay release policy enforces completed retention and defines zero as no retention', async (t) => {
  const now = 2_000_000_000_000
  const retained = createRelaySeedPinReleasePolicy({ retentionDays: 30, now: () => now })
  const record = {
    status: {
      state: 'complete',
      completedAt: now - (30 * DAY_MS) + 1,
    },
  }

  t.is(await retained({ action: 'release', record }), false)
  record.status.completedAt--
  t.is(await retained({ action: 'release', record }), true, 'release is allowed at the exact retention boundary')
  t.is(await retained({ action: 'cancel', record: { status: { state: 'pinning', completedAt: null } } }), true)
  t.is(await retained({ action: 'release', record: { status: { state: 'complete', completedAt: null } } }), false, 'malformed completion fails closed')

  const noRetention = createRelaySeedPinReleasePolicy({ retentionDays: 0, now: () => now })
  t.is(await noRetention({ action: 'release', record }), true, 'zero days means immediate release/no retention')
})

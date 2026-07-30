import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRelayService } from '../src/service.js'
import { RelayCatalog } from '../src/catalog.js'
import { resolveRelayConfig } from '../src/config.js'

function makeLogger() {
  const noop = () => {}
  const ns = { info: noop, warn: noop, error: noop, debug: noop }
  return { relay: ns, admission: ns, mirror: ns, archive: ns, status: ns, download: ns, library: ns, runtime: ns }
}

async function makeService(t, { maxBytes, retention = {}, channels = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-quota-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))

  const config = resolveRelayConfig({
    storage: { path: dir, maxBytes },
    retention
  }, { env: {} })

  const catalog = await RelayCatalog.open({ storagePath: dir, catalogPath: config.paths.catalog })
  for (const channel of channels) {
    await catalog.upsertChannel(channel)
  }

  const calls = []
  const runtime = {
    async start() {},
    async close() {},
    setCandidateHandler() {},
    getNetworkStats: () => ({}),
    cacheManager: {
      async removeChannel(channelKey) {
        calls.push(['cache-remove', channelKey])
        return true
      },
      async enforceQuota() {
        calls.push(['cache-enforce'])
      }
    },
    seeder: {
      async unseedChannel({ driveKey }) {
        calls.push(['seeder-unseed', driveKey])
        return { unseeded: true }
      }
    }
  }

  const service = await createRelayService({
    config,
    catalog,
    logger: makeLogger(),
    runtimeFactory: async () => runtime,
    mirrorChannel: async () => ({}),
    writeStatusFile: () => {}
  })

  return { service, catalog, calls }
}

test('quota eviction removes discovery channels oldest-first and keeps protected content', async (t) => {
  const { service, catalog, calls } = await makeService(t, {
    maxBytes: 250,
    channels: [
      { channelKey: 'aa'.repeat(32), retentionClass: 'private', bytes: 100, mirroredAt: 1 },
      { channelKey: 'bb'.repeat(32), retentionClass: 'allowlist', bytes: 100, mirroredAt: 2 },
      { channelKey: 'cc'.repeat(32), retentionClass: 'discovery', bytes: 100, mirroredAt: 3 },
      { channelKey: 'dd'.repeat(32), retentionClass: 'discovery', bytes: 100, mirroredAt: 4 }
    ]
  })

  const state = await service.enforceQuota()

  t.is(state.overQuota, false)
  t.alike(state.lastEvictions.map((eviction) => eviction.channelKey), ['cc'.repeat(32), 'dd'.repeat(32)])
  t.is(catalog.getChannel('cc'.repeat(32)), null)
  t.is(catalog.getChannel('dd'.repeat(32)), null)
  t.ok(catalog.getChannel('aa'.repeat(32)))
  t.ok(catalog.getChannel('bb'.repeat(32)))
  t.ok(calls.find((call) => call[0] === 'seeder-unseed' && call[1] === 'cc'.repeat(32)))
  t.ok(calls.find((call) => call[0] === 'cache-remove' && call[1] === 'cc'.repeat(32)))
  t.ok(calls.find((call) => call[0] === 'cache-enforce'))
})

test('quota stays loudly over-limit when only protected content remains', async (t) => {
  const { service, catalog } = await makeService(t, {
    maxBytes: 100,
    channels: [
      { channelKey: 'aa'.repeat(32), retentionClass: 'private', bytes: 150, mirroredAt: 1 },
      { channelKey: 'bb'.repeat(32), retentionClass: 'allowlist', bytes: 150, mirroredAt: 2 }
    ]
  })

  const state = await service.enforceQuota()

  t.is(state.overQuota, true)
  t.alike(state.lastEvictions, [])
  t.ok(catalog.getChannel('aa'.repeat(32)))
  t.ok(catalog.getChannel('bb'.repeat(32)))
})

test('allowlist channels become evictable when protectAllowlist is disabled', async (t) => {
  const { service, catalog } = await makeService(t, {
    maxBytes: 100,
    retention: { protectAllowlist: false },
    channels: [
      { channelKey: 'aa'.repeat(32), retentionClass: 'private', bytes: 100, mirroredAt: 1 },
      { channelKey: 'bb'.repeat(32), retentionClass: 'allowlist', bytes: 100, mirroredAt: 2 },
      { channelKey: 'cc'.repeat(32), retentionClass: 'discovery', bytes: 100, mirroredAt: 3 }
    ]
  })

  const state = await service.enforceQuota()

  t.is(state.overQuota, false)
  t.alike(state.lastEvictions.map((eviction) => eviction.retentionClass), ['discovery', 'allowlist'])
  t.ok(catalog.getChannel('aa'.repeat(32)))
  t.is(catalog.getChannel('bb'.repeat(32)), null)
  t.is(catalog.getChannel('cc'.repeat(32)), null)
})

test('under-quota relays evict nothing', async (t) => {
  const { service, calls } = await makeService(t, {
    maxBytes: 1000,
    channels: [
      { channelKey: 'aa'.repeat(32), retentionClass: 'discovery', bytes: 100, mirroredAt: 1 }
    ]
  })

  const state = await service.enforceQuota()
  t.is(state.overQuota, false)
  t.alike(state.lastEvictions, [])
  t.absent(calls.find((call) => call[0] === 'seeder-unseed'))
})

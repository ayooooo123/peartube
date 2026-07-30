import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLibraryManager } from '../src/library.js'
import { LibraryInventory } from '../src/library-inventory.js'
import { RelayCatalog } from '../src/catalog.js'
import { resolveRelayConfig } from '../src/config.js'

function dirent(name, type) {
  return {
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file'
  }
}

function makeFs(tree, sizes = {}) {
  return {
    readdirSync(path) {
      const entries = tree[path]
      if (!entries) throw new Error(`ENOENT: ${path}`)
      return entries
    },
    statSync(path) {
      return { size: sizes[path] ?? 1024, mtimeMs: 1 }
    },
    existsSync(path) {
      return Boolean(tree[path])
    }
  }
}

function makePublisher(calls, keyByChannelName = {}) {
  let nextKey = 10
  return {
    async ensureAnonymousChannel({ channelName }) {
      calls.push(['ensure', channelName])
      const suffix = keyByChannelName[channelName] || String(nextKey++).padStart(2, '0')
      return { channel: { id: channelName }, channelKey: suffix.repeat(32), publicBeeKey: 'be'.repeat(32) }
    },
    async importVideo({ filePath, title, mimeType }) {
      calls.push(['import', filePath])
      return {
        videoId: `video-${title}`,
        metadata: {
          uploadedAt: 1,
          size: 100,
          mimeType,
          blobId: `blob:${title}`,
          blobsCoreKey: 'cb'.repeat(32)
        }
      }
    },
    async publishChannel(channelInfo) {
      calls.push(['publish', channelInfo.channelKey])
    },
    async publishCatalog(channelInfo) {
      calls.push(['publish-catalog', channelInfo.channelKey])
    },
    async retainAssets(channelInfo) {
      calls.push(['retain', channelInfo.channelKey])
    },
    async seedChannel(channelInfo) {
      calls.push(['seed', channelInfo.channelKey])
    }
  }
}

function makeRuntime(calls) {
  return {
    cacheManager: {
      async addChannel(channelKey, publicBeeKey, source) {
        calls.push(['cache-add', channelKey, source])
        return true
      },
      async removeChannel(channelKey) {
        calls.push(['cache-remove', channelKey])
        return true
      }
    },
    seeder: {
      async seedChannel({ driveKey }) {
        calls.push(['seeder-seed', driveKey])
        return { catalogEntry: null }
      },
      async unseedChannel({ driveKey }) {
        calls.push(['seeder-unseed', driveKey])
        return { unseeded: true }
      }
    },
    publicFeed: {
      async unpublishChannel(driveKey) {
        calls.push(['feed-unpublish', driveKey])
        return true
      }
    }
  }
}

async function makeHarness(t, { folders, capBytes = 0, hiverelay = null, keyByChannelName } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-library-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))

  const config = resolveRelayConfig({
    storage: { path: dir },
    library: { enabled: true, folders, caps: { maxBytes: capBytes } }
  }, { env: {} })

  const calls = []
  const inventory = await LibraryInventory.open({ inventoryPath: config.paths.libraryInventory })
  const catalog = await RelayCatalog.open({ storagePath: dir, catalogPath: config.paths.catalog })
  const runtime = makeRuntime(calls)
  const publisher = makePublisher(calls, keyByChannelName)

  const manager = createLibraryManager({
    config,
    runtime,
    catalog,
    inventory,
    createPublisher: () => publisher,
    hiverelay,
    logger: null,
    fsModule: makeHarness.fs
  })

  return { config, calls, inventory, catalog, runtime, manager, dir }
}

test('private audience imports and seeds without touching the public feed', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, { '/media/Family/kid.mp4': 100 })

  const { calls, inventory, catalog, manager } = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }]
  })

  const result = await manager.scanOnce()
  t.is(result.imported, 1)

  // The base publisher's publishChannel (public feed announce) must never run.
  t.absent(calls.find((call) => call[0] === 'publish'))
  t.ok(calls.find((call) => call[0] === 'cache-add' && call[2] === 'private'))
  t.ok(calls.find((call) => call[0] === 'seeder-seed'))

  const item = inventory.getItem('/media/Family/kid.mp4')
  t.is(item.audience, 'private')
  t.is(item.state, 'self-only')

  const channels = catalog.getChannels()
  t.is(channels.length, 1)
  t.is(channels[0].retentionClass, 'private')
  t.is(channels[0].source, 'library')
})

test('public audience requires confirmation before anything is imported', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Movies': [dirent('film.mp4', 'file')]
  }, { '/media/Movies/film.mp4': 100 })

  const { calls, inventory, manager } = await makeHarness(t, {
    folders: [{ path: '/media/Movies', audience: 'public' }]
  })

  const result = await manager.scanOnce()
  t.is(result.imported, 0)
  t.is(calls.filter((call) => call[0] === 'import').length, 0)
  t.alike(manager.getStatusSection().awaitingPublicConfirmation, ['/media/Movies'])
  t.is(inventory.getItems().length, 0)

  await inventory.confirmFolder('/media/Movies')
  const confirmed = await manager.scanOnce()
  t.is(confirmed.imported, 1)
  // Main local-drive-mirror announces via publishCatalog (not legacy publishChannel).
  t.ok(
    calls.find((call) => call[0] === 'publish' || call[0] === 'publish-catalog'),
    'public import must announce via publish/publishCatalog'
  )
  t.alike(manager.getStatusSection().awaitingPublicConfirmation, [])
})

test('a restarted manager does not re-import unchanged files', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, { '/media/Family/kid.mp4': 100 })

  const first = await makeHarness(t, { folders: [{ path: '/media/Family' }] })
  await first.manager.scanOnce()
  t.is(first.calls.filter((call) => call[0] === 'import').length, 1)

  // Simulate a process restart: fresh manager over the same persisted inventory.
  const reopened = await LibraryInventory.open({ inventoryPath: first.config.paths.libraryInventory })
  const calls = []
  const manager = createLibraryManager({
    config: first.config,
    runtime: makeRuntime(calls),
    catalog: first.catalog,
    inventory: reopened,
    createPublisher: () => makePublisher(calls),
    logger: null,
    fsModule: makeHarness.fs
  })

  const second = await manager.scanOnce()
  t.is(second.imported, 0)
  t.is(second.skipped, 1)
  t.is(calls.filter((call) => call[0] === 'import').length, 0)
})

test('library cap pauses imports loudly', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, { '/media/Family/kid.mp4': 100 })

  const harness = await makeHarness(t, { folders: [{ path: '/media/Family' }], capBytes: 50 })
  await harness.manager.scanOnce()
  await harness.inventory.upsertItem({ path: '/media/Family/kid.mp4', bytes: 100, state: 'published' })

  const second = await harness.manager.scanOnce()
  t.is(second.skipped, true)
  t.is(second.reason, 'cap-reached')
  t.is(harness.manager.getStatusSection().importsPaused, true)
})

test('unseed round-trip releases the channel and never touches originals', async (t) => {
  const tree = {
    '/media/Family': [dirent('kid.mp4', 'file')]
  }
  makeHarness.fs = makeFs(tree, { '/media/Family/kid.mp4': 100 })

  const { calls, inventory, catalog, manager } = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }]
  })

  await manager.scanOnce()
  const item = inventory.getItem('/media/Family/kid.mp4')
  const channelKey = item.channelKey
  t.ok(channelKey)

  const result = await manager.unseed('/media/Family')
  t.is(result.unseeded, 1)
  t.alike(result.channelsReleased, [channelKey])
  t.ok(calls.find((call) => call[0] === 'seeder-unseed' && call[1] === channelKey))
  t.ok(calls.find((call) => call[0] === 'cache-remove' && call[1] === channelKey))
  t.is(catalog.getChannel(channelKey), null)
  t.is(inventory.getItem('/media/Family/kid.mp4').state, 'unseeded')

  // The originals are still on disk (fake fs untouched) and a rescan must not
  // silently re-import something the operator deliberately withdrew.
  t.ok(tree['/media/Family'].length === 1)
  const rescan = await manager.scanOnce()
  t.is(rescan.imported, 0)
  t.is(inventory.getItem('/media/Family/kid.mp4').state, 'unseeded')
})

test('unseed by videoId only releases the channel when it was the last item', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('one.mp4', 'file'), dirent('two.mp4', 'file')]
  }, { '/media/Family/one.mp4': 100, '/media/Family/two.mp4': 100 })

  const { calls, inventory, manager } = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }]
  })

  await manager.scanOnce()
  const first = await manager.unseed('video-one')
  t.is(first.unseeded, 1)
  t.alike(first.channelsReleased, [])
  t.absent(calls.find((call) => call[0] === 'seeder-unseed'))

  const second = await manager.unseed('video-two')
  t.is(second.unseeded, 1)
  t.is(second.channelsReleased.length, 1)
  t.ok(calls.find((call) => call[0] === 'seeder-unseed'))
  t.is(inventory.getItems().filter((item) => item.state === 'unseeded').length, 2)
})

test('durability ladder: no relay → self-only, pending relay → pending-approval, accepted → durable', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, { '/media/Family/kid.mp4': 100 })

  const noRelay = await makeHarness(t, { folders: [{ path: '/media/Family', audience: 'private' }] })
  await noRelay.manager.scanOnce()
  t.is(noRelay.inventory.getItem('/media/Family/kid.mp4').state, 'self-only')

  const seedCalls = []
  const pendingRelay = {
    endpoint: 'http://relay.local',
    async detect() { return { detected: true, info: {} } },
    async seedCores({ keys, maxStorageBytes }) {
      seedCalls.push({ keys, maxStorageBytes })
      return { submitted: true, results: keys.map((key) => ({ key, status: 'pending-approval' })) }
    },
    async unseedCores() { return { withdrawn: true, results: [] } }
  }
  const pending = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }],
    hiverelay: pendingRelay
  })
  await pending.manager.scanOnce()
  t.is(pending.inventory.getItem('/media/Family/kid.mp4').state, 'pending-approval')
  t.ok(seedCalls[0].keys.length > 0)
  t.is(seedCalls[0].maxStorageBytes, 100)

  const acceptedRelay = {
    ...pendingRelay,
    async seedCores({ keys }) {
      return { submitted: true, results: keys.map((key) => ({ key, status: 'accepted' })) }
    }
  }
  const accepted = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }],
    hiverelay: acceptedRelay
  })
  await accepted.manager.scanOnce()
  const item = accepted.inventory.getItem('/media/Family/kid.mp4')
  t.is(item.state, 'durable')
  t.is(item.relay.endpoint, 'http://relay.local')
  t.ok(item.relay.lastVerifiedAt)

  const unreachableRelay = {
    ...pendingRelay,
    async detect() { return { detected: false, error: 'connection-refused' } }
  }
  const unreachable = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }],
    hiverelay: unreachableRelay
  })
  await unreachable.manager.scanOnce()
  t.is(unreachable.inventory.getItem('/media/Family/kid.mp4').state, 'self-only')
})

test('resumeIncompleteUnseeds finishes withdrawals left by a crash', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, { '/media/Family/kid.mp4': 100 })

  const harness = await makeHarness(t, { folders: [{ path: '/media/Family', audience: 'private' }] })
  await harness.manager.scanOnce()
  const item = harness.inventory.getItem('/media/Family/kid.mp4')
  await harness.inventory.setState(item.path, 'unseeding')

  const resumed = await harness.manager.resumeIncompleteUnseeds()
  t.is(resumed.resumed, 1)
  t.is(harness.inventory.getItem(item.path).state, 'unseeded')
  t.ok(harness.calls.find((call) => call[0] === 'seeder-unseed'))
})

test('validateFolders throws loudly for missing mounts', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Exists': [dirent('a.mp4', 'file')]
  })

  const harness = await makeHarness(t, {
    folders: [{ path: '/media/Exists' }, { path: '/media/Missing' }]
  })
  t.exception(() => harness.manager.validateFolders(), /\/media\/Missing/)
})

// Regression (audit F1/state): a no-op rescan must NOT zero the channel's
// catalog bytes — that corrupts quota accounting.
test('a no-op rescan preserves catalog channel bytes', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, { '/media/Family/kid.mp4': 4242 })

  const { catalog, inventory, manager } = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }]
  })

  await manager.scanOnce()
  const channelKey = inventory.getItem('/media/Family/kid.mp4').channelKey
  t.is(catalog.getChannel(channelKey).bytes, 4242)

  // Second scan imports nothing (unchanged file) but still runs the republish
  // path; bytes must stay intact, not reset to 0.
  const second = await manager.scanOnce()
  t.is(second.imported, 0)
  t.is(catalog.getChannel(channelKey).bytes, 4242)
})

// Regression (audit F1/privacy): unseeding a PUBLIC channel must retract it
// from the public feed, or the runtime re-seeds it on the next tick.
test('unseeding a public channel retracts it from the feed', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Movies': [dirent('film.mp4', 'file')]
  }, { '/media/Movies/film.mp4': 100 })

  const { calls, inventory, manager } = await makeHarness(t, {
    folders: [{ path: '/media/Movies', audience: 'public', confirmed: true }]
  })

  await manager.scanOnce()
  const channelKey = inventory.getItem('/media/Movies/film.mp4').channelKey

  await manager.unseed('/media/Movies')
  const unpublish = calls.find((call) => call[0] === 'feed-unpublish')
  t.ok(unpublish, 'public unseed calls publicFeed.unpublishChannel')
  t.is(unpublish[1], channelKey)
})

// Regression (audit F1/privacy): a PRIVATE channel was never on the feed, so
// unseed must NOT call unpublishChannel.
test('unseeding a private channel does not touch the feed', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, { '/media/Family/kid.mp4': 100 })

  const { calls, manager } = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }]
  })

  await manager.scanOnce()
  await manager.unseed('/media/Family')
  t.absent(calls.find((call) => call[0] === 'feed-unpublish'))
})

// Regression (audit F2/state): a withdrawn item whose file is later modified
// must stay withdrawn, not silently resurrect.
test('a modified unseeded file is not silently resurrected', async (t) => {
  const sizes = { '/media/Family/kid.mp4': 100 }
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, sizes)

  const { inventory, manager, calls } = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }]
  })

  await manager.scanOnce()
  await manager.unseed('/media/Family')
  t.is(inventory.getItem('/media/Family/kid.mp4').state, 'unseeded')

  // Operator edits the file (size changes → new fingerprint).
  sizes['/media/Family/kid.mp4'] = 200
  const importsBefore = calls.filter((call) => call[0] === 'import').length
  const rescan = await manager.scanOnce()
  t.is(rescan.imported, 0)
  t.is(calls.filter((call) => call[0] === 'import').length, importsBefore)
  t.is(inventory.getItem('/media/Family/kid.mp4').state, 'unseeded')
})

// Regression (audit F5/state): concurrent unseed + scan must not interleave
// and resurrect the unseeded item (serialized by the shared lock).
test('concurrent scan and unseed do not race-resurrect an item', async (t) => {
  makeHarness.fs = makeFs({
    '/media/Family': [dirent('kid.mp4', 'file')]
  }, { '/media/Family/kid.mp4': 100 })

  const { inventory, manager } = await makeHarness(t, {
    folders: [{ path: '/media/Family', audience: 'private' }]
  })

  await manager.scanOnce()

  // Fire a scan and an unseed without awaiting between them; the lock must
  // serialize so the item ends up unseeded, never republished.
  const scanP = manager.scanOnce()
  const unseedP = manager.unseed('/media/Family')
  await Promise.all([scanP, unseedP])

  t.is(inventory.getItem('/media/Family/kid.mp4').state, 'unseeded')
})

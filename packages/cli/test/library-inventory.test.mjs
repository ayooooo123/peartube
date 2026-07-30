import test from 'brittle'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { LibraryInventory } from '../src/library-inventory.js'

function makeInventoryPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-library-inventory-'))
  t.teardown(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'db', 'library-inventory.json')
}

test('inventory persists items across reopen', async (t) => {
  const inventoryPath = makeInventoryPath(t)

  const first = await LibraryInventory.open({ inventoryPath })
  await first.upsertItem({
    path: '/media/a.mp4',
    fingerprint: '/media/a.mp4:100:1',
    videoId: 'video-a',
    channelKey: 'aa'.repeat(32),
    publicBeeKey: 'bb'.repeat(32),
    audience: 'private',
    bytes: 100,
    state: 'published'
  })

  const second = await LibraryInventory.open({ inventoryPath })
  const item = second.getItem('/media/a.mp4')
  t.is(item.videoId, 'video-a')
  t.is(item.state, 'published')
  t.is(item.bytes, 100)

  const seen = new Map(second.seenEntries())
  t.is(seen.get('/media/a.mp4').fingerprint, '/media/a.mp4:100:1')
})

test('inventory rejects unknown states and requires a path', async (t) => {
  const inventory = await LibraryInventory.open({ inventoryPath: makeInventoryPath(t) })

  await t.exception(() => inventory.upsertItem({ path: '/media/x.mp4', state: 'bogus' }), /Invalid library item state/)
  await t.exception(() => inventory.upsertItem({ state: 'published' }), /require a path/)
})

test('unseeded items keep their fingerprint but drop preview refs from seen entries', async (t) => {
  const inventory = await LibraryInventory.open({ inventoryPath: makeInventoryPath(t) })
  await inventory.upsertItem({
    path: '/media/a.mp4',
    fingerprint: 'fp-a',
    previewVideo: { id: 'video-a' },
    state: 'published'
  })
  await inventory.setState('/media/a.mp4', 'unseeded')

  const seen = new Map(inventory.seenEntries())
  t.is(seen.get('/media/a.mp4').fingerprint, 'fp-a')
  t.is(seen.get('/media/a.mp4').previewVideo, null)
})

test('findItems matches videoId, channelKey, and folder prefix', async (t) => {
  const inventory = await LibraryInventory.open({ inventoryPath: makeInventoryPath(t) })
  await inventory.upsertItem({ path: '/media/Family/a.mp4', videoId: 'video-a', channelKey: 'cc'.repeat(32), state: 'published' })
  await inventory.upsertItem({ path: '/media/Other/b.mp4', videoId: 'video-b', channelKey: 'dd'.repeat(32), state: 'published' })

  t.is(inventory.findItems('video-a').length, 1)
  t.is(inventory.findItems('cc'.repeat(32)).length, 1)
  t.is(inventory.findItems('/media/Family').length, 1)
  t.is(inventory.findItems('/media/Family/a.mp4').length, 1)
  t.is(inventory.findItems('/media/Fam').length, 0)
  t.is(inventory.findItems('nope').length, 0)
})

test('folder confirmations persist and summary counts states and bytes', async (t) => {
  const inventoryPath = makeInventoryPath(t)
  const inventory = await LibraryInventory.open({ inventoryPath })

  t.is(inventory.isFolderConfirmed('/media/Public'), false)
  await inventory.confirmFolder('/media/Public')
  t.is(inventory.isFolderConfirmed('/media/Public'), true)

  await inventory.upsertItem({ path: '/a', bytes: 10, state: 'published' })
  await inventory.upsertItem({ path: '/b', bytes: 20, state: 'durable' })
  await inventory.upsertItem({ path: '/c', bytes: 30, state: 'unseeded' })

  const reopened = await LibraryInventory.open({ inventoryPath })
  t.is(reopened.isFolderConfirmed('/media/Public'), true)

  const summary = reopened.summary()
  t.is(summary.total, 3)
  t.is(summary.counts.published, 1)
  t.is(summary.counts.durable, 1)
  t.is(summary.counts.unseeded, 1)
  t.is(summary.totalBytes, 30)
})

// Regression (audit F3): a corrupt/torn inventory file must not crash-loop
// startup — it is quarantined and a clean slate is used.
test('a corrupt inventory file is quarantined, not fatal', async (t) => {
  const inventoryPath = makeInventoryPath(t)
  const first = await LibraryInventory.open({ inventoryPath })
  await first.upsertItem({ path: '/a', bytes: 10, state: 'published' })

  // Simulate a torn write (truncated JSON).
  writeFileSync(inventoryPath, '{"version":1,"items":{"/a":{"stat')

  const reopened = await LibraryInventory.open({ inventoryPath })
  t.is(reopened.getItems().length, 0, 'starts clean instead of throwing')
  const quarantined = readdirSync(dirname(inventoryPath)).filter((name) => name.includes('.corrupt-'))
  t.ok(quarantined.length >= 1, 'corrupt file is quarantined for forensics')
})

// Regression (audit F3): writes are atomic (temp + rename), so no partial
// file is observable and the target always parses.
test('persist writes atomically and leaves no stray temp file', async (t) => {
  const inventoryPath = makeInventoryPath(t)
  const inventory = await LibraryInventory.open({ inventoryPath })
  await inventory.upsertItem({ path: '/a', bytes: 10, state: 'published' })

  t.ok(existsSync(inventoryPath))
  t.absent(existsSync(`${inventoryPath}.tmp`), 'temp file is renamed away, not left behind')
  t.execution(() => JSON.parse(readFileSync(inventoryPath, 'utf8')), 'target file always parses')
})

// Regression (audit F2/privacy): a running service picks up an out-of-band
// `library confirm` via reloadConfirmedFolders without a restart.
test('reloadConfirmedFolders picks up an out-of-band confirm', async (t) => {
  const inventoryPath = makeInventoryPath(t)
  const service = await LibraryInventory.open({ inventoryPath })
  await service.upsertItem({ path: '/a', bytes: 10, state: 'published' })

  // A separate CLI instance confirms a folder while the service holds its own
  // in-memory copy that predates the confirm.
  const cli = await LibraryInventory.open({ inventoryPath })
  await cli.confirmFolder('/media/Public')

  t.is(service.isFolderConfirmed('/media/Public'), false, 'stale in-memory does not see it yet')
  service.reloadConfirmedFolders()
  t.is(service.isFolderConfirmed('/media/Public'), true, 'reload picks it up without restart')
})

// Regression (audit F2/privacy): the running service's next persist must NOT
// erase a confirmation written out-of-band (merge-on-persist, union is safe).
test('a service persist does not erase an out-of-band confirmation', async (t) => {
  const inventoryPath = makeInventoryPath(t)
  const service = await LibraryInventory.open({ inventoryPath })
  await service.upsertItem({ path: '/a', bytes: 10, state: 'published' })

  const cli = await LibraryInventory.open({ inventoryPath })
  await cli.confirmFolder('/media/Public')

  // The service (whose in-memory confirmedFolders is empty) persists again.
  // Previously this overwrote the file and erased the confirmation.
  await service.upsertItem({ path: '/b', bytes: 20, state: 'published' })
  const onDisk = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  t.ok(onDisk.confirmedFolders['/media/Public'], 'confirmation survives the service persist')
})

import test from 'brittle'

import { PublicFeedManager } from '../src/public-feed.js'

const DRIVE_KEY = '11'.repeat(32)
const LIVE_CORE_KEY = 'ab'.repeat(32)

function createMetaDb() {
  const entries = new Map()
  return {
    async put(key, value) { entries.set(key, value) },
    async get(key) { return entries.has(key) ? { value: entries.get(key) } : null },
    async del(key) { entries.delete(key) },
  }
}

function createManager(t) {
  const manager = new PublicFeedManager(null, createMetaDb())
  t.teardown(() => { try { manager.stop?.() } catch { /* best effort */ } })
  manager.addEntry(DRIVE_KEY, 'local', null, { channelName: 'streamer' })
  return manager
}

function liveStream(overrides = {}) {
  return {
    videoId: 'vid-1',
    liveCoreKey: LIVE_CORE_KEY,
    title: 'going live',
    startedAt: 12345,
    ...overrides,
  }
}

test('setChannelLiveStreams announces and clears live streams on the local entry', (t) => {
  const manager = createManager(t)

  t.ok(manager.setChannelLiveStreams(DRIVE_KEY, [liveStream()]), 'announce changes the entry')

  const entry = manager.entries.get(DRIVE_KEY)
  t.is(entry.liveStreams.length, 1)
  t.is(entry.liveStreams[0].liveCoreKey, LIVE_CORE_KEY)
  t.ok(entry.liveUpdatedAt > 0)

  const serialized = manager._serializeEntry(entry)
  t.alike(serialized.liveStreams, entry.liveStreams, 'live streams ride the gossip wire shape')
  t.is(serialized.liveUpdatedAt, entry.liveUpdatedAt)

  const feedEntry = manager.getFeed().find((e) => e.driveKey === DRIVE_KEY)
  t.is(feedEntry.liveStreams.length, 1, 'getFeed exposes live streams')

  // End of stream: clearing wins and the empty state still carries the clock.
  t.ok(manager.setChannelLiveStreams(DRIVE_KEY, []), 'clearing changes the entry')
  t.is(manager.entries.get(DRIVE_KEY).liveStreams.length, 0)
  const cleared = manager._serializeEntry(manager.entries.get(DRIVE_KEY))
  t.ok(cleared.liveUpdatedAt > 0, 'clock still serialized after clearing')
  t.absent(cleared.liveStreams, 'no empty array on the wire')

  t.absent(manager.setChannelLiveStreams('99'.repeat(32), [liveStream()]), 'unknown channel is a no-op')
})

test('live announcements merge last-writer-wins on liveUpdatedAt', (t) => {
  const manager = createManager(t)
  manager.setChannelLiveStreams(DRIVE_KEY, [liveStream()])
  const entry = manager.entries.get(DRIVE_KEY)
  const liveClock = entry.liveUpdatedAt

  // Stale gossip (older clock, different list) must not clobber live state.
  const staleApplied = manager._applyEntrySnapshot(DRIVE_KEY, {
    liveUpdatedAt: liveClock - 1000,
    liveStreams: [],
  })
  t.absent(staleApplied, 'stale snapshot ignored')
  t.is(entry.liveStreams.length, 1)

  // Newer gossip clears it (the broadcaster ended the stream elsewhere).
  const newerApplied = manager._applyEntrySnapshot(DRIVE_KEY, {
    liveUpdatedAt: liveClock + 1000,
    liveStreams: [],
  })
  t.ok(newerApplied, 'newer snapshot applies')
  t.is(entry.liveStreams.length, 0)

  // Same clock, same list: clock bookkeeping only, no change/no re-gossip.
  const sameApplied = manager._applyEntrySnapshot(DRIVE_KEY, {
    liveUpdatedAt: liveClock + 2000,
    liveStreams: [],
  })
  t.absent(sameApplied, 'identical list does not mark the entry changed')
  t.is(entry.liveUpdatedAt, liveClock + 2000, 'clock still advances')
})

test('live stream sanitizer enforces key format and caps the list', (t) => {
  const manager = createManager(t)

  const sanitized = manager._sanitizeLiveStreams([
    liveStream(),
    liveStream({ videoId: 'vid-2', liveCoreKey: 'not-a-key' }),
    liveStream({ videoId: '' }),
    null,
    'garbage',
    ...Array.from({ length: 10 }, (_, i) => liveStream({ videoId: `vid-extra-${i}` })),
  ])

  t.ok(sanitized.length <= 4, 'list capped at 4')
  t.ok(sanitized.every((s) => /^[a-f0-9]{64}$/.test(s.liveCoreKey)), 'invalid core keys dropped')
  t.ok(sanitized.every((s) => s.videoId.length > 0), 'entries without videoId dropped')
  t.is(manager._sanitizeLiveStreams('nope').length, 0)
  t.is(manager._sanitizeLiveStreams(undefined).length, 0)
})

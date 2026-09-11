import assert from 'node:assert/strict'
import test from 'node:test'
import { PersonalStore } from '../src/personal/personal-store.js'

class MemoryBeeView {
  constructor() {
    this.entries = new Map()
  }

  async get(key) {
    if (!this.entries.has(key)) return null
    return { key, value: JSON.parse(JSON.stringify(this.entries.get(key))) }
  }

  async put(key, value) {
    this.entries.set(key, JSON.parse(JSON.stringify(value)))
  }

  async del(key) {
    this.entries.delete(key)
  }

  async *createReadStream(opts = {}) {
    const sortedKeys = Array.from(this.entries.keys()).sort()
    for (const key of sortedKeys) {
      if (opts.gte && key < opts.gte) continue
      if (opts.lt && key >= opts.lt) continue
      yield { key, value: JSON.parse(JSON.stringify(this.entries.get(key))) }
    }
  }
}

test('PersonalStore._applyData is deterministic across different clocks for incomplete legacy subscribe ops', async () => {
  const legacyOp = { type: 'subscribe', channelKey: 'chan-abc', name: 'Test Channel' }

  const view1 = new MemoryBeeView()
  const view2 = new MemoryBeeView()

  // Apply under simulated different clocks
  const realDateNow = Date.now
  try {
    Date.now = () => 1_000_000
    await PersonalStore._applyData(view1, legacyOp)

    Date.now = () => 9_999_999
    await PersonalStore._applyData(view2, legacyOp)
  } finally {
    Date.now = realDateNow
  }

  const stored1 = await view1.get('sub/chan-abc')
  const stored2 = await view2.get('sub/chan-abc')

  assert.deepEqual(stored1, stored2)
  assert.equal(stored1.value.subscribedAt, 0, 'missing subscribedAt deterministically defaults to 0')
})

test('PersonalStore._applyData is deterministic across different clocks for incomplete legacy put-playlist ops', async () => {
  const legacyOp = { type: 'put-playlist', id: 'pl-1', name: 'Favorites', description: 'Favs' }

  const view1 = new MemoryBeeView()
  const view2 = new MemoryBeeView()

  const realDateNow = Date.now
  try {
    Date.now = () => 111_111
    await PersonalStore._applyData(view1, legacyOp)

    Date.now = () => 888_888
    await PersonalStore._applyData(view2, legacyOp)
  } finally {
    Date.now = realDateNow
  }

  const stored1 = await view1.get('playlist/pl-1')
  const stored2 = await view2.get('playlist/pl-1')

  assert.deepEqual(stored1, stored2)
  assert.equal(stored1.value.createdAt, 0)
  assert.equal(stored1.value.updatedAt, 0)
})

test('PersonalStore._applyData is deterministic across different clocks for incomplete legacy add-playlist-item ops', async () => {
  const legacyOp = { type: 'add-playlist-item', playlistId: 'pl-1', videoKey: 'vid-xyz', channelKey: 'chan-1', videoId: 'v1' }

  const view1 = new MemoryBeeView()
  const view2 = new MemoryBeeView()

  const realDateNow = Date.now
  try {
    Date.now = () => 222_222
    await PersonalStore._applyData(view1, legacyOp)

    Date.now = () => 777_777
    await PersonalStore._applyData(view2, legacyOp)
  } finally {
    Date.now = realDateNow
  }

  const stored1 = await view1.get('playlist-item/pl-1/vid-xyz')
  const stored2 = await view2.get('playlist-item/pl-1/vid-xyz')

  assert.deepEqual(stored1, stored2)
  assert.equal(stored1.value.addedAt, 0)
})

test('PersonalStore._applyData is deterministic for incomplete legacy log-history ops without randomId or clock drift', async () => {
  const legacyOp = {
    type: 'log-history',
    event: {
      channelKey: 'chan-1',
      videoId: 'v-1',
      videoKey: 'chan-1:v-1',
      title: 'Episode 1',
      position: 42,
      duration: 100
    }
  }

  const view1 = new MemoryBeeView()
  const view2 = new MemoryBeeView()

  const realDateNow = Date.now
  try {
    Date.now = () => 333_333
    await PersonalStore._applyData(view1, legacyOp)

    Date.now = () => 666_666
    await PersonalStore._applyData(view2, legacyOp)
  } finally {
    Date.now = realDateNow
  }

  const keys1 = Array.from(view1.entries.keys()).filter((k) => k.startsWith('history/'))
  const keys2 = Array.from(view2.entries.keys()).filter((k) => k.startsWith('history/'))

  assert.equal(keys1.length, 1)
  assert.deepEqual(keys1, keys2, 'history keys must be bit-for-bit identical across peers')

  const entry1 = view1.entries.get(keys1[0])
  const entry2 = view2.entries.get(keys2[0])

  assert.deepEqual(entry1, entry2)
  assert.equal(entry1.timestamp, 0)
  assert.ok(typeof entry1.eventId === 'string' && entry1.eventId.length > 0)
})

test('PersonalStore._applyData is deterministic for incomplete legacy set-setting ops', async () => {
  const legacyOp = { type: 'set-setting', key: 'theme', value: 'dark' }

  const view1 = new MemoryBeeView()
  const view2 = new MemoryBeeView()

  const realDateNow = Date.now
  try {
    Date.now = () => 444_444
    await PersonalStore._applyData(view1, legacyOp)

    Date.now = () => 555_555
    await PersonalStore._applyData(view2, legacyOp)
  } finally {
    Date.now = realDateNow
  }

  const stored1 = await view1.get('setting/theme')
  const stored2 = await view2.get('setting/theme')

  assert.deepEqual(stored1, stored2)
  assert.equal(stored1.value.updatedAt, 0)
})

test('PersonalStore._apply is deterministic for incomplete legacy add-writer ops', async () => {
  const legacyNode = {
    value: { type: 'add-writer', key: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', deviceName: 'Old Phone' }
  }
  const fakeHost = { addWriter: async () => {} }

  const view1 = new MemoryBeeView()
  const view2 = new MemoryBeeView()

  const realDateNow = Date.now
  try {
    Date.now = () => 123_456
    await PersonalStore._apply([legacyNode], view1, fakeHost)

    Date.now = () => 654_321
    await PersonalStore._apply([legacyNode], view2, fakeHost)
  } finally {
    Date.now = realDateNow
  }

  const stored1 = await view1.get(`writer/${legacyNode.value.key}`)
  const stored2 = await view2.get(`writer/${legacyNode.value.key}`)

  assert.deepEqual(stored1, stored2)
  assert.equal(stored1.value.addedAt, 0)
})

test('PersonalStore._applyData silently ignores malformed ops missing required keys', async () => {
  const view = new MemoryBeeView()

  await PersonalStore._applyData(view, { type: 'subscribe' })
  await PersonalStore._applyData(view, { type: 'unsubscribe' })
  await PersonalStore._applyData(view, { type: 'put-playlist' })
  await PersonalStore._applyData(view, { type: 'delete-playlist' })
  await PersonalStore._applyData(view, { type: 'add-playlist-item' })
  await PersonalStore._applyData(view, { type: 'remove-playlist-item' })
  await PersonalStore._applyData(view, { type: 'set-setting' })
  await PersonalStore._applyData(view, { type: 'delete-setting' })

  assert.equal(view.entries.size, 0, 'malformed operations with missing identifiers must not write undefined keys')
})

test('PersonalStore._apply does not collapse multiple incomplete history nodes and replays identically across clocks', async () => {
  const writerKey = Buffer.from('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 'hex')
  const node1 = {
    from: { key: writerKey },
    length: 1,
    value: {
      type: 'log-history',
      event: { channelKey: 'chan-1', videoId: 'v-1', videoKey: 'chan-1:v-1', title: 'Ep 1', position: 10, duration: 100 }
    }
  }
  const node2 = {
    from: { key: writerKey },
    length: 2,
    value: {
      type: 'log-history',
      event: { channelKey: 'chan-1', videoId: 'v-2', videoKey: 'chan-1:v-2', title: 'Ep 2', position: 20, duration: 100 }
    }
  }

  const view1 = new MemoryBeeView()
  const view2 = new MemoryBeeView()

  const realDateNow = Date.now
  try {
    Date.now = () => 100_000
    await PersonalStore._apply([node1, node2], view1, {})

    Date.now = () => 900_000
    await PersonalStore._apply([node1, node2], view2, {})
  } finally {
    Date.now = realDateNow
  }

  const keys1 = Array.from(view1.entries.keys()).filter((k) => k.startsWith('history/')).sort()
  const keys2 = Array.from(view2.entries.keys()).filter((k) => k.startsWith('history/')).sort()

  assert.equal(keys1.length, 2, 'two distinct incomplete history nodes must yield two distinct history keys')
  assert.deepEqual(keys1, keys2, 'history keys must be bit-for-bit identical across peer clocks')

  for (let i = 0; i < keys1.length; i++) {
    assert.deepEqual(view1.entries.get(keys1[i]), view2.entries.get(keys2[i]))
  }
})

test('PersonalStore._apply preserves two distinct history rows for identical payloads at two lengths', async () => {
  const writerKey = Buffer.from('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 'hex')
  const identicalPayload = {
    type: 'log-history',
    event: { channelKey: 'chan-1', videoId: 'v-1', videoKey: 'chan-1:v-1', title: 'Ep 1', position: 10, duration: 100 }
  }
  const node1 = {
    from: { key: writerKey },
    length: 1,
    value: JSON.parse(JSON.stringify(identicalPayload))
  }
  const node2 = {
    from: { key: writerKey },
    length: 2,
    value: JSON.parse(JSON.stringify(identicalPayload))
  }

  const view = new MemoryBeeView()
  await PersonalStore._apply([node1, node2], view, {})

  const historyKeys = Array.from(view.entries.keys()).filter((k) => k.startsWith('history/'))
  assert.equal(historyKeys.length, 2, 'identical legacy payloads at different lengths must produce two distinct history rows')
})

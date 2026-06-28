import test from 'brittle'
import {
  normalizeRelayKey,
  loadRelayLinks,
  addRelayLink,
  removeRelayLink,
  relayLinkKeys,
} from '../src/relay-links.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function fakeMetaDb() {
  const map = new Map()
  return {
    async get(key) { return map.has(key) ? { value: map.get(key) } : null },
    async put(key, value) { map.set(key, value) },
  }
}

test('normalizeRelayKey validates 64-char hex', (t) => {
  t.is(normalizeRelayKey(A), A)
  t.is(normalizeRelayKey(A.toUpperCase()), A, 'lowercases')
  t.is(normalizeRelayKey('  ' + A + '  '), A, 'trims')
  t.is(normalizeRelayKey('xyz'), null)
  t.is(normalizeRelayKey('a'.repeat(63)), null)
  t.is(normalizeRelayKey(''), null)
})

test('add/load/remove round trip with persistence', async (t) => {
  const db = fakeMetaDb()
  await addRelayLink(db, { mirrorKey: A, label: 'Home relay' })
  await addRelayLink(db, { mirrorKey: B })

  const list = await loadRelayLinks(db)
  t.is(list.length, 2)
  t.is(list.find((l) => l.mirrorKey === A).label, 'Home relay')
  t.alike(relayLinkKeys(list).sort(), [A, B].sort())

  t.is(await removeRelayLink(db, B), true)
  t.is(await removeRelayLink(db, B), false, 'removing twice is a no-op')
  t.is((await loadRelayLinks(db)).length, 1)
})

test('addRelayLink rejects an invalid key', async (t) => {
  const db = fakeMetaDb()
  await t.exception(() => addRelayLink(db, { mirrorKey: 'not-a-key' }))
})

test('re-adding updates the label and preserves addedAt', async (t) => {
  const db = fakeMetaDb()
  const first = await addRelayLink(db, { mirrorKey: A, label: 'One' })
  const second = await addRelayLink(db, { mirrorKey: A, label: 'Two' })
  t.is(second.addedAt, first.addedAt, 'addedAt is stable')
  t.is(second.label, 'Two')
})

test('loadRelayLinks tolerates corrupt/missing entries', async (t) => {
  const db = fakeMetaDb()
  await db.put('relay-links-v1', [{ mirrorKey: A }, { mirrorKey: 'bad' }, null, { label: 'no key' }])
  const list = await loadRelayLinks(db)
  t.is(list.length, 1)
  t.is(list[0].mirrorKey, A)
})

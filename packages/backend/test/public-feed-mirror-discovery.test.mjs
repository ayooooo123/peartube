import test from 'node:test'
import assert from 'node:assert/strict'

import { PublicFeedManager } from '../src/public-feed.js'

function makeMetaDb() {
  return { async get() { return null }, async put() {}, async del() {}, createReadStream() { return [] } }
}

function makeFeed() {
  const feed = new PublicFeedManager({}, makeMetaDb())
  // Avoid debounced metaDb persistence timers firing after the test ends.
  feed._schedulePersistDiscovered = () => {}
  return feed
}

const DRIVE_KEY = 'cd'.repeat(32)
const PUBLIC_BEE_KEY = 'ef'.repeat(32)
const RELAY_KEY = 'ab'.repeat(32)

test('relayMirrorKey survives the serialize round-trip on a relay-serving entry', () => {
  const relay = makeFeed()
  relay.addEntry(DRIVE_KEY, 'relay-cache', PUBLIC_BEE_KEY, { relayMirrorKey: RELAY_KEY })
  const wire = relay._serializeEntry(relay.entries.get(DRIVE_KEY))
  assert.equal(wire.relayServing, true)
  assert.equal(wire.relayMirrorKey, RELAY_KEY)
})

test('a received relay-serving entry surfaces its mirror key via onRelayMirrorKey', () => {
  const client = makeFeed()
  const adopted = []
  client.setOnRelayMirrorKey((k) => adopted.push(k))
  client.addEntry(DRIVE_KEY, 'peer', PUBLIC_BEE_KEY, { relayServing: true, relayMirrorKey: RELAY_KEY })
  assert.deepEqual(adopted, [RELAY_KEY])
  assert.equal(client.entries.get(DRIVE_KEY).relayMirrorKey, RELAY_KEY)
})

test('a non-relay-serving entry does not surface a mirror key', () => {
  const client = makeFeed()
  const adopted = []
  client.setOnRelayMirrorKey((k) => adopted.push(k))
  client.addEntry(DRIVE_KEY, 'peer', PUBLIC_BEE_KEY, { relayServing: false, relayMirrorKey: RELAY_KEY })
  assert.deepEqual(adopted, [])
})

test('a mirror key applied via a later snapshot update is surfaced', () => {
  const client = makeFeed()
  const adopted = []
  client.addEntry(DRIVE_KEY, 'peer', PUBLIC_BEE_KEY, { relayServing: true })
  client.setOnRelayMirrorKey((k) => adopted.push(k))
  client._applyEntrySnapshot(DRIVE_KEY, { relayMirrorKey: RELAY_KEY })
  assert.deepEqual(adopted, [RELAY_KEY])
})

test('invalid mirror keys are ignored', () => {
  const client = makeFeed()
  const adopted = []
  client.setOnRelayMirrorKey((k) => adopted.push(k))
  client.addEntry(DRIVE_KEY, 'relay-cache', PUBLIC_BEE_KEY, { relayMirrorKey: 'not-a-valid-key' })
  assert.deepEqual(adopted, [])
  assert.equal(client.entries.get(DRIVE_KEY).relayMirrorKey, null)
})

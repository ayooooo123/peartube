import test from 'brittle'
import { encode, decode } from '../src/channel/channel-hyperdb-spec/hyperdb/messages.js'

// The writer record gained a trailing optional `swarmKeyHex` field (flag bit
// 128) so devices can advertise the swarm/Noise key they replicate under. These
// tests pin the wire format: the new field round-trips, and records written
// without it (every record that predates this change) still decode correctly.
// NAME is the hyperdb value encoding — it omits keyHex (the collection key).
const NAME = '@peartubeChannel/writer/hyperdb#1'

test('writer codec round-trips swarmKeyHex alongside the existing fields', (t) => {
  const rec = {
    role: 'device',
    deviceName: 'phone',
    blobDriveKey: 'bb'.repeat(32),
    addedAt: 5,
    updatedAt: 6,
    removedAt: 0,
    banned: false,
    swarmKeyHex: 'cc'.repeat(32)
  }
  const out = decode(NAME, encode(NAME, rec))
  t.is(out.role, 'device')
  t.is(out.deviceName, 'phone')
  t.is(out.blobDriveKey, rec.blobDriveKey)
  t.is(out.addedAt, 5)
  t.is(out.updatedAt, 6)
  t.is(out.banned, false)
  t.is(out.swarmKeyHex, rec.swarmKeyHex)
})

test('a writer record without swarmKeyHex decodes to null (legacy-compatible)', (t) => {
  const rec = { role: 'owner', addedAt: 1, banned: true }
  const out = decode(NAME, encode(NAME, rec))
  t.is(out.swarmKeyHex, null, 'absent field defaults to null')
  t.is(out.role, 'owner')
  t.is(out.addedAt, 1)
  t.is(out.banned, true)
})

test('swarmKeyHex is purely additive: only a trailing field, other fields unchanged', (t) => {
  const base = { role: 'device', deviceName: 'tv', addedAt: 9, banned: true }
  const without = encode(NAME, base)
  const withKey = encode(NAME, { ...base, swarmKeyHex: 'dd'.repeat(32) })

  t.ok(withKey.byteLength > without.byteLength, 'swarmKeyHex appends bytes')

  // Old-shaped record: bit 128 clear -> null. New-shaped: bit 128 set -> value.
  const oldDecoded = decode(NAME, without)
  t.is(oldDecoded.swarmKeyHex, null)
  t.is(oldDecoded.deviceName, 'tv')
  t.is(oldDecoded.banned, true)

  const newDecoded = decode(NAME, withKey)
  t.is(newDecoded.swarmKeyHex, 'dd'.repeat(32))
  t.is(newDecoded.deviceName, 'tv')
  t.is(newDecoded.banned, true)
})

// The cast structs at the edge (src/cast-control.js): a receiver state with every stand-in and one with every field
// set come back equal after the bytes, and each command an app sends reaches the receiver as the object it applied
// before v2, with only its action's arguments. These fail before v2: cast messages were free-form JSON.
import test from 'node:test'
import assert from 'node:assert/strict'
import c from 'compact-encoding'
import b4a from 'b4a'
import { getEncoding } from '../spec/hyperschema/index.js'
import { commandFromWire, commandToWire, pairedFromWire, pairedToWire, stateFromWire, stateToWire } from '../src/cast-control.js'
import { idleCastState } from '../src/cast.js'

const STATE = getEncoding('@peartube/cast-state')
const COMMAND = getEncoding('@peartube/cast-command')
const PAIRED = getEncoding('@peartube/cast-paired')
const stateTrip = state => stateFromWire(c.decode(STATE, c.encode(STATE, stateToWire(state))))
const commandTrip = cmd => commandFromWire(c.decode(COMMAND, c.encode(COMMAND, commandToWire(cmd, 'token'))))

test('a state with every stand-in round-trips to an equal object', () => {
  const idle = { ...idleCastState(), videoDecoder: null, droppedFrames: null }
  assert.deepEqual(stateTrip(idle), idle)
  // The idle bytes, as the contract pins them (updatedAt 0).
  assert.equal(b4a.toString(c.encode(STATE, stateToWire({ ...idle, updatedAt: 0 })), 'hex'), '00000469646c650000000000000000000000f03f030300000001')
})

test('a state with every field set round-trips to an equal object', () => {
  const full = {
    status: 'playing',
    mode: 'private-p2p',
    entry: { key: 'k'.repeat(64), id: 'imdb:tt0079944', title: 'Stalker (1979)', size: 2 ** 53 - 1, sha256: 'a'.repeat(64) },
    positionMs: 61_000,
    durationMs: 9_660_000,
    playing: true,
    buffering: true,
    ended: true,
    p2pPeers: 3,
    cachedBytes: 123_456_789,
    seeding: true,
    volume: 0.5,
    muted: true,
    tracks: [
      { stream: 0, kind: 'video', codec: 'hevc', language: null, title: null },
      { stream: 1, kind: 'audio', codec: 'aac', language: 'rus', title: 'Original' },
      { stream: 2, kind: 'subtitle', codec: 'subrip', language: 'eng', title: 'English' }
    ],
    audio: 1,
    subtitle: -1,
    error: 'Decoder failed',
    updatedAt: 1_763_600_000_000,
    videoDecoder: 'MediaCodec hevc',
    droppedFrames: 0
  }
  assert.deepEqual(stateTrip(full), full)
})

test('a state is bounded before it is encoded', () => {
  const tracks = Array.from({ length: 200 }, (_, i) => ({ stream: i, kind: 'subtitle', codec: 'c'.repeat(40), language: 'l'.repeat(40), title: 't'.repeat(80) }))
  const out = stateTrip({ ...idleCastState(), tracks, error: 'e'.repeat(300), positionMs: 1234.5, durationMs: -5, droppedFrames: 2 ** 60 })
  assert.equal(out.tracks.length, 128)
  assert.equal(out.tracks[0].codec.length, 32)
  assert.equal(out.tracks[0].language.length, 32)
  assert.equal(out.tracks[0].title.length, 64)
  assert.equal(out.error.length, 256)
  assert.equal(out.positionMs, 1235, 'whole milliseconds')
  assert.equal(out.durationMs, null, 'a duration that is not above 0 is unknown')
  assert.equal(out.droppedFrames, 2 ** 52 - 1, 'a telemetry count beyond the int range is capped, not an encode failure')
})

// Every string at its bound, in 3-byte UTF-8 characters (the most bytes per UTF-16 code unit), 128 tracks, an entry
// and the largest numbers: the state still fits one envelope frame, so a state push can never fail to encode.
test('the largest state the bounds allow fits one 64 KiB frame', () => {
  const s = n => '€'.repeat(n + 10) // longer than every bound, cut by the edge
  const big = 2 ** 53 - 1
  const state = {
    status: s(32),
    mode: s(32),
    entry: { key: s(256), id: s(128), title: s(80), size: big, sha256: s(64) },
    positionMs: big,
    durationMs: big,
    playing: true,
    buffering: true,
    ended: true,
    p2pPeers: big,
    cachedBytes: big,
    seeding: true,
    volume: 0.123456789,
    muted: true,
    tracks: Array.from({ length: 300 }, () => ({ stream: -(2 ** 52), kind: s(16), codec: s(32), language: s(32), title: s(64) })),
    audio: -(2 ** 52),
    subtitle: -(2 ** 52),
    error: s(256),
    updatedAt: big,
    videoDecoder: s(64),
    droppedFrames: big
  }
  const value = c.encode(STATE, stateToWire(state))
  const frame = c.encode(getEncoding('@peartube/frame'), { kind: 3, op: 3, id: 0, value })
  assert.ok(frame.byteLength <= 65_536, `the largest state frame is ${frame.byteLength} bytes`)
  const back = stateFromWire(c.decode(STATE, value))
  assert.equal(back.tracks.length, 128)
  assert.equal(back.entry.key.length, 256)
  assert.equal(back.error.length, 256)
})

test('a cut string stays well formed', () => {
  const out = stateTrip({ ...idleCastState(), error: 'x'.repeat(255) + '😀' }) // the pair straddles the 256 bound
  assert.equal(out.error.length, 256)
  assert.equal(out.error.isWellFormed(), true)
})

test('each command reaches the receiver as the object the app sent, with only its action\'s arguments', () => {
  // What the apps and the web UI send through castControl (src/cast.js castControl, worklet castControl).
  const sent = [
    { action: 'play' },
    { action: 'pause' },
    { action: 'togglePlay' },
    { action: 'stop' },
    { action: 'status' },
    { action: 'seek', positionMs: 90_000 },
    { action: 'skip', deltaMs: -10_000 }, // every back-10-s button: CastScreen.swift, CastScreens.kt, cast_screen.rs, ui.js
    { action: 'skip', deltaMs: 10_000 },
    { action: 'selectAudio', stream: 2 },
    { action: 'selectAudio', stream: -1 },
    { action: 'selectSubtitle', stream: 0 },
    { action: 'volume', volume: 0.25 },
    { action: 'volume', muted: true },
    { action: 'volume', muted: false },
    { action: 'volume', volume: 0, muted: false }
  ]
  for (const cmd of sent) assert.deepEqual(commandTrip(cmd), cmd, JSON.stringify(cmd))
  const load = {
    action: 'load',
    entry: { key: 'k', id: 'imdb:tt0079944', title: 'Stalker (1979)', size: 3145739, sha256: 'b'.repeat(64) },
    magnetUrl: 'peartube://watch/abc',
    startPositionMs: 5000
  }
  assert.deepEqual(commandTrip(load), load)
})

test('a command\'s numbers are made whole, and an argument of another action does not travel', () => {
  assert.deepEqual(commandTrip({ action: 'seek', positionMs: 1234.5 }), { action: 'seek', positionMs: 1235 }, 'the iOS fractional seek')
  assert.deepEqual(commandTrip({ action: 'skip', deltaMs: -10_000.4 }), { action: 'skip', deltaMs: -10_000 }, 'a skip keeps its sign')
  assert.deepEqual(commandTrip({ action: 'seek', positionMs: -50 }), { action: 'seek', positionMs: 0 }, 'an absolute time is 0 or more')
  assert.deepEqual(commandTrip({ action: 'pause', positionMs: 7, stream: 3, extra: 'x' }), { action: 'pause' })
  assert.deepEqual(commandTrip({ action: 'volume', volume: 7 }), { action: 'volume', volume: 1 }, 'volume is 0 to 1')
  const wire = commandToWire({ action: 'volume', muted: true }, 't')
  assert.equal(wire.volume, -1, 'a volume command that only mutes leaves the volume as it is')
  assert.equal(wire.muted, 1)
})

// A stand-in means "none" both ways: an explicit null travels as an omitted argument does, and comes back as null.
test('a stand-in is the exact inverse of none: stream null is -1, an empty load link is null', () => {
  for (const action of ['selectAudio', 'selectSubtitle']) {
    assert.equal(commandToWire({ action, stream: null }, 't').stream, -1, `${action} stream: null`)
    assert.equal(commandToWire({ action }, 't').stream, -1, `${action} without a stream`)
    assert.deepEqual(commandTrip({ action, stream: null }), { action, stream: -1 })
  }
  assert.deepEqual(commandTrip({ action: 'load', startPositionMs: 0 }), { action: 'load', magnetUrl: null, startPositionMs: 0 }, 'a load without a link')
  assert.deepEqual(commandTrip({ action: 'load', magnetUrl: null, startPositionMs: 0 }), { action: 'load', magnetUrl: null, startPositionMs: 0 })
})

test('a pairing answer carries the public key as 32 bytes and gives it back as hex', () => {
  const paired = { deviceId: 'dev', name: 'Living Room', publicKey: 'ab'.repeat(32), token: '' }
  const bytes = c.encode(PAIRED, pairedToWire(paired))
  assert.equal(c.decode(PAIRED, bytes).publicKey.byteLength, 32)
  assert.deepEqual(pairedFromWire(c.decode(PAIRED, bytes)), paired)
})

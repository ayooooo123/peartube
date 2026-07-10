import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FCAST_PORT,
  FCAST_PROTOCOL_VERSION,
  Opcode,
  PlaybackState,
  MAX_MESSAGE_LENGTH,
  encodeMessage,
  FCastDecoder,
} from '../src/cast/fcast-protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('fcast constants match the published protocol', () => {
  assert.equal(FCAST_PORT, 46899)
  assert.equal(FCAST_PROTOCOL_VERSION, 2)
  assert.equal(Opcode.PLAY, 1)
  assert.equal(Opcode.PAUSE, 2)
  assert.equal(Opcode.RESUME, 3)
  assert.equal(Opcode.STOP, 4)
  assert.equal(Opcode.SEEK, 5)
  assert.equal(Opcode.PLAYBACK_UPDATE, 6)
  assert.equal(Opcode.VOLUME_UPDATE, 7)
  assert.equal(Opcode.SET_VOLUME, 8)
  assert.equal(Opcode.PLAYBACK_ERROR, 9)
  assert.equal(Opcode.SET_SPEED, 10)
  assert.equal(Opcode.VERSION, 11)
  assert.equal(Opcode.PING, 12)
  assert.equal(Opcode.PONG, 13)
  assert.equal(PlaybackState.IDLE, 0)
  assert.equal(PlaybackState.PLAYING, 1)
  assert.equal(PlaybackState.PAUSED, 2)
})

test('encodeMessage frames a JSON body with a little-endian length header', () => {
  const body = { container: 'video/mp4', url: 'http://192.168.1.5:8080/v.mp4', time: 0, speed: 1 }
  const message = encodeMessage(Opcode.PLAY, body)
  const json = Buffer.from(JSON.stringify(body), 'utf8')

  assert.equal(message.readUInt32LE(0), 1 + json.length, 'length covers opcode + body')
  assert.equal(message[4], Opcode.PLAY)
  assert.deepEqual(message.slice(5), json)
})

test('encodeMessage frames bare opcodes with length 1', () => {
  const message = encodeMessage(Opcode.PING)
  assert.equal(message.length, 5)
  assert.equal(message.readUInt32LE(0), 1)
  assert.equal(message[4], Opcode.PING)
})

test('decoder reassembles messages across arbitrary chunk boundaries', () => {
  const stream = Buffer.concat([
    encodeMessage(Opcode.VERSION, { version: 2 }),
    encodeMessage(Opcode.PLAYBACK_UPDATE, { time: 12.5, duration: 300, state: 1, speed: 1 }),
    encodeMessage(Opcode.PONG),
  ])

  // Feed the stream one byte at a time — the worst possible fragmentation.
  const decoder = new FCastDecoder()
  const messages = []
  for (let i = 0; i < stream.length; i++) {
    messages.push(...decoder.push(stream.slice(i, i + 1)))
  }

  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0], { opcode: Opcode.VERSION, body: { version: 2 } })
  assert.deepEqual(messages[1], { opcode: Opcode.PLAYBACK_UPDATE, body: { time: 12.5, duration: 300, state: 1, speed: 1 } })
  assert.deepEqual(messages[2], { opcode: Opcode.PONG, body: null })
})

test('decoder handles multiple messages arriving in one chunk', () => {
  const chunk = Buffer.concat([
    encodeMessage(Opcode.PING),
    encodeMessage(Opcode.VOLUME_UPDATE, { volume: 0.5 }),
  ])
  const messages = new FCastDecoder().push(chunk)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].opcode, Opcode.PING)
  assert.deepEqual(messages[1].body, { volume: 0.5 })
})

test('decoder rejects invalid frame lengths instead of buffering forever', () => {
  const zero = Buffer.alloc(4) // length 0 is invalid (opcode byte is mandatory)
  assert.throws(() => new FCastDecoder().push(zero), /Invalid FCast message length/)

  const huge = Buffer.alloc(4)
  huge.writeUInt32LE(MAX_MESSAGE_LENGTH + 1, 0)
  assert.throws(() => new FCastDecoder().push(huge), /Invalid FCast message length/)
})

test('decoder tolerates malformed JSON bodies', () => {
  const bad = Buffer.from('{nope', 'utf8')
  const frame = Buffer.alloc(4 + 1 + bad.length)
  frame.writeUInt32LE(1 + bad.length, 0)
  frame[4] = Opcode.PLAYBACK_UPDATE
  bad.copy(frame, 5)

  const messages = new FCastDecoder().push(frame)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].opcode, Opcode.PLAYBACK_UPDATE)
  assert.equal(messages[0].body, null)
})

// --- Integration wiring (source-level, same style as the discovery tests:
// the cast modules import bare-* packages and cannot be loaded under node) ---

const readSource = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', 'cast', rel), 'utf8')

test('discovery queries and recognizes the _fcast._tcp service', () => {
  const discoverySource = readSource('discovery.js')
  assert.match(discoverySource, /FCAST: '_fcast\._tcp\.local\.'/, 'FCast mDNS service type should be declared')
  assert.match(discoverySource, /Object\.values\(ServiceType\)/, 'queries should cover every service type')
  assert.match(discoverySource, /_fcast\._tcp'\) \? 'fcast'/, 'PTR answers should map the fcast service to the fcast protocol')
  assert.match(discoverySource, /fcast: 46899/, 'manual fcast devices should default to port 46899')
})

test('cast context routes fcast devices to FCastDevice', () => {
  const indexSource = readSource('index.js')
  assert.match(indexSource, /FCAST: 'fcast'/, 'ProtocolType should declare fcast')
  assert.match(indexSource, /ProtocolType\.FCAST\)[\s\S]{0,40}new FCastDevice\(deviceInfo\)/, 'createDevice should branch to FCastDevice')
  assert.match(indexSource, /export \{ FCastDevice \} from '\.\/fcast\.js'/, 'FCastDevice should be re-exported')
})

test('fcast device speaks the protocol through the shared codec', () => {
  const fcastSource = readSource('fcast.js')
  assert.match(fcastSource, /from '\.\/fcast-protocol\.js'/, 'device should use the shared codec')
  assert.match(fcastSource, /tcp\.createConnection\(this\.deviceInfo\.port \|\| FCAST_PORT, this\.deviceInfo\.host\)/, 'device should connect over plain TCP on the fcast port')
  assert.match(fcastSource, /Opcode\.VERSION, \{ version: FCAST_PROTOCOL_VERSION \}/, 'device should advertise its protocol version on connect')
  assert.match(fcastSource, /Opcode\.PONG/, 'device should answer receiver pings')
})

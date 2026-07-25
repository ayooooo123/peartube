import test from 'brittle'
import b4a from 'b4a'
import { execFileSync } from 'node:child_process'

import {
  FRAME_FLAG_OPTIONAL_TAG,
  MAX_PEER_FRAME_BYTES,
  decodePeerFrame,
  encodePeerFrame,
} from '../src/network/index.js'

test('peer frame codec enforces exact max size and rejects one-byte-over before allocation', (t) => {
  const payload = b4a.alloc(MAX_PEER_FRAME_BYTES - 128, 1)
  const frame = encodePeerFrame({ purpose: 'asset', type: 'offer', requestId: 1, payload })
  t.ok(frame.byteLength <= MAX_PEER_FRAME_BYTES)
  t.alike(decodePeerFrame(frame).payload, payload)

  t.exception(() => decodePeerFrame(b4a.alloc(MAX_PEER_FRAME_BYTES + 1)), /frame exceeds maximum size/)
  const declared = b4a.from(frame)
  declared.writeUInt32BE(MAX_PEER_FRAME_BYTES + 1, 0)
  t.exception(() => decodePeerFrame(declared), /declared frame length exceeds maximum size/)
})

test('peer frame codec rejects truncated headers, unknown major, and unsupported mandatory tags', (t) => {
  t.exception(() => decodePeerFrame(b4a.alloc(2)), /truncated frame/)
  const frame = encodePeerFrame({ purpose: 'bootstrap', type: 'hello', protocolMajor: 99, requestId: 1 })
  t.exception(() => decodePeerFrame(frame), /unsupported protocol major/)

  const mandatory = encodePeerFrame({ purpose: 'bootstrap', type: 'hello', requestId: 1, tags: [{ code: 5000, value: b4a.from('x') }] })
  t.exception(() => decodePeerFrame(mandatory), /unsupported mandatory tag/)
})

test('peer frame codec skips optional length-delimited minor extensions and preserves vectors', (t) => {
  const frame = encodePeerFrame({
    purpose: 'publisher',
    type: 'catalog-page',
    requestId: 7,
    payload: b4a.from('payload'),
    tags: [{ code: 5000 | FRAME_FLAG_OPTIONAL_TAG, value: b4a.from('future') }],
  })
  t.alike(b4a.toString(frame.subarray(0, 8), 'hex'), '0000002d01000201')
  const decoded = decodePeerFrame(frame)
  t.is(decoded.purpose, 'publisher')
  t.is(decoded.type, 'catalog-page')
  t.is(decoded.requestId, 7)
  t.alike(decoded.payload, b4a.from('payload'))
  t.alike(decoded.optionalTags[0].code, 5000)
})

test('archive challenge frame types decode in an isolated receiving process', (t) => {
  const frameUrl = new URL('../src/network/frame.js', import.meta.url).href
  for (const type of ['archive-challenge', 'archive-challenge-proof']) {
    const encoded = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import b4a from 'b4a'
      import { encodePeerFrame } from ${JSON.stringify(frameUrl)}
      process.stdout.write(b4a.toString(encodePeerFrame({
        purpose: 'archive-discovery',
        type: ${JSON.stringify(type)},
        requestId: 1,
        payload: b4a.from('payload'),
      }), 'hex'))
    `], { encoding: 'utf8' })
    const decodedType = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import b4a from 'b4a'
      import { decodePeerFrame, PEER_FRAME_TYPE_NAMES } from ${JSON.stringify(frameUrl)}
      process.stdout.write(decodePeerFrame(
        b4a.from(${JSON.stringify(encoded)}, 'hex'),
        { typeCodes: PEER_FRAME_TYPE_NAMES },
      ).type)
    `], { encoding: 'utf8' })
    t.is(decodedType, type)
  }
})

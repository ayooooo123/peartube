// The wire schema for PearTube's own Protomux protocols (search, cast, private guard): `npm run schema` writes
// spec/hyperschema/{schema.json,index.js}, which are committed. The Rust port generates its codecs from a copy of
// the same schema.json. Change it by appending only: a new struct, or a new field at the end of a struct (which
// raises the schema version). Never reorder, retype or remove a field: peers on the old version read the same bytes.
//   - Every field is required unless it is a nested struct that can be absent. An absent scalar travels as a fixed
//     stand-in ('' / 0 / -1 / -2, named beside its field) because Hyperschema writes an optional scalar by
//     truthiness, so 0, '' and false cannot be told from absent.
//   - A struct with a bool or an optional field has a flags word; `flagsPosition: 0` puts it first, where the Rust
//     port checks it before decoding. Only structs that are a whole message value may have one.
//   - A message value holds at most one array, as the struct's first field, and the op list (spec/protocols.js)
//     names its largest count. The array's count is then the first varint after the flags word, so both engines
//     check it before they decode: a decoder allocates from the count it reads.
import Hyperschema from 'hyperschema'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('./hyperschema', import.meta.url))
const schema = Hyperschema.from(dir)
const ns = schema.namespace('peartube')

const req = (name, type) => ({ name, type, required: true })
const list = (name, type) => ({ name, type, required: true, array: true })
const opt = (name, type) => ({ name, type })
const struct = (name, fields, more = {}) => ns.register({ name, fields, ...more })

// ---- envelope (src/control-channel.js) ----

// kind: 0 request, 1 response, 2 error, 3 event. op: index into the protocol's op list. id: pairs a response or an
// error with its request; 0 on an event. value: the op's struct, encoded.
struct('frame', [req('kind', 'uint'), req('op', 'uint'), req('id', 'uint'), req('value', 'buffer')], { compact: true })
struct('remote-error', [req('code', 'string'), req('message', 'string')])

// ---- peartube/search/v2 ----

struct('search-query', [req('q', 'string'), req('mid', 'string'), req('limit', 'uint')]) // mid: '' = none
struct('search-hit', [req('uri', 'string')])
struct('search-hits', [list('hits', '@peartube/search-hit')])

// ---- peartube-cast/v2 ----

struct('cast-pair', [req('code', 'string')])
struct('cast-paired', [req('deviceId', 'string'), req('name', 'string'), req('publicKey', 'fixed32'), req('token', 'string')])
struct('cast-subscribe', [req('token', 'string')])
struct('cast-entry', [req('key', 'string'), req('id', 'string'), req('title', 'string'), req('size', 'uint'), req('sha256', 'string')])
// An argument counts only for the action that takes it. volume: -1 = leave as it is. muted: -1 = leave as it is,
// 0 = off, 1 = on. stream: -1 = off.
struct('cast-command', [
  req('token', 'string'),
  req('action', 'string'),
  opt('entry', '@peartube/cast-entry'),
  req('magnetUrl', 'string'),
  req('startPositionMs', 'uint'),
  req('positionMs', 'uint'),
  req('deltaMs', 'int'),
  req('stream', 'int'),
  req('volume', 'float64'),
  req('muted', 'int')
], { flagsPosition: 0 })
struct('cast-track', [req('stream', 'int'), req('kind', 'string'), req('codec', 'string'), req('language', 'string'), req('title', 'string')]) // language, title: '' = none
// mode, error, videoDecoder: '' = none. durationMs: 0 = unknown. audio, subtitle: -1 = off, -2 = unknown.
// droppedFrames: -1 = not reported.
struct('cast-state', [
  list('tracks', '@peartube/cast-track'),
  req('status', 'string'),
  req('mode', 'string'),
  opt('entry', '@peartube/cast-entry'),
  req('positionMs', 'uint'),
  req('durationMs', 'uint'),
  req('playing', 'bool'),
  req('buffering', 'bool'),
  req('ended', 'bool'),
  req('p2pPeers', 'uint'),
  req('cachedBytes', 'uint'),
  req('seeding', 'bool'),
  req('volume', 'float64'),
  req('muted', 'bool'),
  req('audio', 'int'),
  req('subtitle', 'int'),
  req('error', 'string'),
  req('updatedAt', 'uint'),
  req('videoDecoder', 'string'),
  req('droppedFrames', 'int')
], { flagsPosition: 0 })

// ---- peartube/private-guard/v2 ----

struct('guard-hello', [req('role', 'string')]) // 'endpoint' | 'hop'
struct('guard-ack', [req('status', 'uint')]) // 0 = refused, 1 = done
struct('guard-register', [req('routeToken', 'fixed32'), req('ttlMs', 'uint')])
struct('guard-key', [req('key', 'fixed32')])
struct('guard-put-mutable', [req('publicKey', 'fixed32'), req('seq', 'uint'), req('signature', 'fixed64'), req('value', 'buffer')])
struct('guard-record', [req('seq', 'uint'), req('signature', 'fixed64'), req('value', 'buffer')])
struct('guard-get-result', [opt('record', '@peartube/guard-record')], { flagsPosition: 0 }) // no record = not found
struct('guard-rv-register', [req('topic', 'fixed32'), req('slotId', 'fixed16'), req('ttlMs', 'uint'), req('sealedCard', 'buffer')])
struct('guard-rv-slot', [req('topic', 'fixed32'), req('slotId', 'fixed16')])
struct('guard-cards', [list('cards', 'buffer')])
struct('guard-dial', [req('guardKey', 'fixed32'), req('routeToken', 'fixed32'), req('udxId', 'uint'), req('bucket', 'string')])
struct('guard-open', [req('routeToken', 'fixed32'), req('udxId', 'uint')])
struct('guard-ready', [req('status', 'uint'), req('udxId', 'uint')]) // 0 = failed, 1 = ready, 2 = not diverse (dial only)
struct('guard-circuit-dead', [req('udxId', 'uint')])

Hyperschema.toDisk(schema)

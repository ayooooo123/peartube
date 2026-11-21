// A typed request/reply channel between two peers: one Protomux channel on the connection the two nodes already
// share, beside Hypercore replication. Global search (src/search.js), cast control (src/cast-control.js) and the
// private guard (src/private-overlay.js) each run one, under their own protocol (spec/protocols.js).
// Every message is one frame `{ kind, op, id, value }` (spec/hyperschema `@peartube/frame`):
//   kind 0 request, 1 response, 2 error, 3 event; op indexes the protocol's op list; id pairs a response or an
//   error with its request (requests count up from 1, an event has 0); value is the op's struct, encoded.
// Either side may ask on the same channel, and the kind says which way a frame goes, so a request is never taken for
// the answer to one of this side's own. Nothing a peer sends closes the connection: a frame that does not decode is
// dropped, a request that does not decode or whose handler fails is answered with an error, and a channel that
// keeps sending junk is closed on its own.
import Protomux from 'protomux'
import c from 'compact-encoding'
import { getEncoding } from '../spec/hyperschema/index.js'
import { guardedFrame } from './guarded-frame.js'

export const MAX_FRAME = 64 * 1024
const REQUEST = 0
const RESPONSE = 1
const ERROR = 2
const EVENT = 3
const BAD_LIMIT = 8 // undecodable frames or values in BAD_WINDOW_MS that close the channel
const BAD_WINDOW_MS = 10_000
const MAX_ID = Number.MAX_SAFE_INTEGER
const MAX_MESSAGE = 256 // characters of an error message
const CODES = new Set(['UNKNOWN_OP', 'DECODE_ERROR', 'ENCODE_ERROR', 'HANDLER_ERROR'])

const FRAME = getEncoding('@peartube/frame')
const RECEIVED = guardedFrame(FRAME, MAX_FRAME)
const REMOTE_ERROR = getEncoding('@peartube/remote-error')

// A protocol's ops with their encodings, once per protocol. `maxItems` and `flags` describe the array of the value
// that holds one (a response or an event), see `countFits`.
const compiled = new WeakMap()
function compile (spec) {
  let ops = compiled.get(spec)
  if (!ops) {
    ops = spec.ops.map(op => ({
      name: op.name,
      maxItems: op.maxItems ?? null,
      flags: op.flags === true,
      ...(op.kind === 'event'
        ? { event: getEncoding(op.event) }
        : { request: getEncoding(op.request), response: getEncoding(op.response) })
    }))
    compiled.set(spec, ops)
  }
  return ops
}

// The count of a value's array, read before the generated decoder runs: it allocates for the declared count (up to
// 2^20) before it reads one item, so a few bytes could make it allocate megabytes. The array is the struct's first
// field, after its flags word if it has one. The same check runs on what this side encodes.
function countFits (op, buf) {
  if (op.maxItems === null) return true
  try {
    const state = { start: 0, end: buf.byteLength, buffer: buf }
    if (op.flags) c.uint.decode(state)
    return c.uint.decode(state) <= op.maxItems
  } catch {
    return false
  }
}

// An error a peer answered with, or one raised here for a call: `code` is the envelope's, `message` the handler's.
function callError (code, message) {
  return Object.assign(new Error(message), { code })
}

// Every number on the wire is finite: a value holding NaN or an infinity is neither sent nor taken.
function finite (value) {
  if (typeof value === 'number') return Number.isFinite(value)
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return true
  for (const v of Object.values(value)) if (!finite(v)) return false
  return true
}

function encode (encoding, value) {
  try { return finite(value) ? c.encode(encoding, value) : null } catch { return null }
}

function decode (encoding, buf) {
  const value = c.decode(encoding, buf)
  if (!finite(value)) throw new Error('a number that is not finite')
  return value
}

function cut (message) {
  return Array.from(String(message ?? '').toWellFormed()).slice(0, MAX_MESSAGE).join('')
}

// One half of the channel on `conn`, not yet opened; null when this connection already has one. `label` names the
// other side in errors ("Receiver connection closed"). `handlers` answers requests by op name, `events` takes events
// by op name; an op without one is not served here.
function createChannel (conn, { spec, label, handlers = {}, events = {}, onOpen = null, onClose = null }) {
  const mux = Protomux.from(conn)
  if (mux.opened({ protocol: spec.protocol })) return null
  const ops = compile(spec)
  const pending = new Map() // id -> { op, resolve, reject, timer }
  const bad = [] // times of undecodable frames and values
  let seq = 1

  const control = {
    conn,
    channel: null,
    get closed () { return control.channel.closed },
    // Calls `name` on the other side with `value`; resolves with its answer, or rejects with an error that carries
    // the envelope's `code`.
    call (name, value, timeoutMs = 10_000) {
      if (control.closed) return Promise.reject(new Error(`${label} connection closed`))
      const op = ops.findIndex(o => o.name === name && o.request)
      const buf = op === -1 ? null : encode(ops[op].request, value)
      if (!buf) return Promise.reject(callError('ENCODE_ERROR', `${label} ${name} could not be encoded`))
      if (seq > MAX_ID) return Promise.reject(callError('ENCODE_ERROR', `${label} channel ran out of request ids`))
      const id = seq++
      const frame = { kind: REQUEST, op, id, value: buf }
      if (!fits(frame)) return Promise.reject(callError('ENCODE_ERROR', `${label} ${name} is too large`))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Object.assign(new Error(`${label} ${name} timed out`), { code: 'ETIMEDOUT' }))
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, { op, resolve, reject, timer })
        message.send(frame)
      })
    },
    // Sends event `name`. Null when nothing was sent (a closed channel, no such event, or a value that cannot be
    // encoded, holds too many items or makes the frame too large); otherwise the stream's answer, false meaning
    // "wait for 'drain' before the next send".
    emit (name, value) {
      if (control.closed) return null
      const op = ops.findIndex(o => o.name === name && o.event)
      const buf = op === -1 ? null : encode(ops[op].event, value)
      const frame = { kind: EVENT, op, id: 0, value: buf }
      if (!buf || !countFits(ops[op], buf) || !fits(frame)) return null
      return message.send(frame)
    },
    close: () => control.channel.close()
  }

  control.channel = mux.createChannel({
    protocol: spec.protocol,
    id: null,
    onopen: () => onOpen?.(control),
    onclose () {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(`${label} connection closed`))
      }
      pending.clear()
      onClose?.(control)
    }
  })
  if (!control.channel) return null

  const message = control.channel.addMessage({
    encoding: RECEIVED,
    onmessage (frame) {
      if (!frame || frame.kind > EVENT) return junk()
      if (frame.kind === REQUEST) return request(frame)
      if (frame.kind === EVENT) return event(frame)
      answer(frame)
    }
  })

  // An undecodable frame or value. Eight in ten seconds close this channel; the connection stays.
  function junk () {
    const now = Date.now()
    while (bad.length && now - bad[0] > BAD_WINDOW_MS) bad.shift()
    bad.push(now)
    if (bad.length >= BAD_LIMIT) control.close()
  }

  function fits (frame) {
    const state = { start: 0, end: 0, buffer: null }
    FRAME.preencode(state, frame)
    return state.end <= MAX_FRAME
  }

  function fail (op, id, code, text = '') {
    message.send({ kind: ERROR, op, id, value: c.encode(REMOTE_ERROR, { code, message: cut(text) }) })
  }

  function request ({ op, id, value }) {
    if (id === 0) return junk()
    const entry = ops[op]
    const handler = entry?.request && handlers[entry.name]
    if (!handler) return fail(op, id, 'UNKNOWN_OP')
    let input
    try { input = decode(entry.request, value) } catch {
      fail(op, id, 'DECODE_ERROR') // answered before the count can close the channel
      return junk()
    }
    // Started here, in wire order: the handler runs up to its first await before the next frame is read, so an event
    // that follows a request never overtakes it. A throw and a rejection are both HANDLER_ERROR.
    let result
    try { result = handler(input, control) } catch (err) { result = Promise.reject(err) }
    Promise.resolve(result).then(
      result => {
        const out = encode(entry.response, result)
        const frame = { kind: RESPONSE, op, id, value: out }
        if (out && countFits(entry, out) && fits(frame)) message.send(frame)
        else fail(op, id, 'ENCODE_ERROR')
      },
      err => fail(op, id, 'HANDLER_ERROR', typeof err === 'string' ? err : err?.message)
    ).catch(() => {})
  }

  function answer ({ kind, op, id, value }) {
    const p = pending.get(id)
    if (!p || p.op !== op) return
    pending.delete(id)
    clearTimeout(p.timer)
    let decoded
    try {
      if (kind === RESPONSE && !countFits(ops[op], value)) throw new Error('too many items')
      decoded = decode(kind === RESPONSE ? ops[op].response : REMOTE_ERROR, value)
    } catch {
      junk()
      return p.reject(callError('DECODE_ERROR', `${label} sent an answer that does not decode`))
    }
    if (kind === RESPONSE) p.resolve(decoded)
    // A peer's error carries one of the envelope's codes; any other is its handler's, so it cannot pass for a local one.
    else p.reject(callError(CODES.has(decoded.code) ? decoded.code : 'HANDLER_ERROR', decoded.message || `${label} error`))
  }

  function event ({ op, id, value }) {
    const entry = ops[op]
    const handler = entry?.event && events[entry.name]
    if (id !== 0 || !handler) return
    let input
    try {
      if (!countFits(entry, value)) throw new Error('too many items')
      input = decode(entry.event, value)
    } catch {
      return junk()
    }
    // Run inline, in wire order; a promise it returns may reject without a listener anywhere else.
    try { Promise.resolve(handler(input, control)).catch(() => {}) } catch {}
  }

  return control
}

// The answering half: answers every peer that opens `spec.protocol` on `conn`. Returns a function that stops
// answering on this connection.
export function serveChannel (conn, { spec, label, handlers, events, onOpen = null, onClose = null }) {
  let mux
  try { mux = Protomux.from(conn) } catch { return () => {} }
  mux.pair({ protocol: spec.protocol }, () => {
    createChannel(conn, { spec, label, handlers, events, onOpen, onClose })?.channel.open()
  })
  return () => mux.unpair({ protocol: spec.protocol })
}

// The asking half: opens `spec.protocol` on `conn` and resolves once the other side answers it. A peer that does not
// serve the protocol (another version included) refuses the channel, which rejects with `refused`. With `handlers`,
// this side also answers the other side's requests on the same channel, so two peers that both serve can ask each
// other.
export function openChannel (conn, { spec, label, handlers, events, onClose = null, refused, duplicate, timedOut }, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let opened = false
    const refuse = message => {
      clearTimeout(timer)
      reject(new Error(message))
    }
    const control = createChannel(conn, {
      spec,
      label,
      handlers,
      events,
      onOpen () {
        opened = true
        clearTimeout(timer)
        resolve(control)
      },
      onClose () {
        if (opened) onClose?.(control)
        else refuse(refused)
      }
    })
    if (!control) return reject(new Error(duplicate))
    const timer = setTimeout(() => {
      refuse(timedOut) // before the close, whose hook would report a refusal
      control.close()
    }, timeoutMs)
    timer.unref?.()
    control.channel.open()
  })
}

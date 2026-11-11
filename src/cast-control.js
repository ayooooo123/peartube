// The control channel between a cast sender and a receiver (peartube-cast/v1): one Protomux channel on the peer
// connection the two nodes already share, beside Hypercore replication. A cast needs no connection, port or server
// of its own, and its messages travel under that connection's Noise encryption.
//   sender -> receiver   {id, type: 'pair' | 'subscribe' | 'cmd', ...}
//   receiver -> sender   {id, ok, result | error}, and {event: 'state', state} once subscribed
// Any peer that connects to a receiver can open this channel, so the receiver decides per request what it allows.
import Protomux from 'protomux'
import c from 'compact-encoding'

const PROTOCOL = 'peartube-cast/v1'
const MAX_FRAME = 64 * 1024

// One JSON object per message. Anything else a peer sends (too long, broken JSON, `null`, a number) decodes to null
// and is dropped: Protomux closes the whole connection on a decoder or handler that throws.
const frame = {
  preencode: c.json.preencode,
  encode: c.json.encode,
  decode (state) {
    if (state.end - state.start > MAX_FRAME) {
      state.start = state.end
      return null
    }
    try {
      const msg = c.json.decode(state)
      return msg !== null && typeof msg === 'object' && !Array.isArray(msg) ? msg : null
    } catch {
      state.start = state.end
      return null
    }
  }
}

// One half of the channel on `conn`, not yet opened; null when this connection already has one.
function createControl (conn, { onRequest = null, onEvent = null, onOpen = null, onClose = null }) {
  const mux = Protomux.from(conn)
  if (mux.opened({ protocol: PROTOCOL })) return null
  const pending = new Map()
  let seq = 1
  const control = {
    conn,
    channel: null,
    get closed () { return control.channel.closed },
    // Sends an event or a reply; false when the connection wants the sender to wait for 'drain'.
    push: msg => message.send(msg),
    call (type, payload = {}, timeoutMs = 10_000) {
      if (control.closed) return Promise.reject(new Error('Receiver connection closed'))
      const id = seq++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Object.assign(new Error(`Receiver ${type} timed out`), { code: 'ETIMEDOUT' }))
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        message.send({ id, type, ...payload })
      })
    },
    close: () => control.channel.close()
  }
  control.channel = mux.createChannel({
    protocol: PROTOCOL,
    id: null,
    onopen: () => onOpen?.(control),
    onclose () {
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('Receiver connection closed'))
      }
      pending.clear()
      onClose?.(control)
    }
  })
  if (!control.channel) return null
  const message = control.channel.addMessage({
    encoding: frame,
    onmessage (msg) {
      if (!msg) return
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error || 'Receiver error'))
      } else if (msg.event) {
        try { onEvent?.(msg) } catch {}
      } else if (onRequest && typeof msg.type === 'string') {
        Promise.resolve().then(() => onRequest(msg, control)).then(
          result => { message.send({ id: msg.id, ok: true, result }) },
          err => { message.send({ id: msg.id, ok: false, error: err.message }) }
        ).catch(() => {})
      }
    }
  })
  return control
}

// The receiver's half: answers every sender that opens the channel on `conn` with what `onRequest(msg, control)`
// returns, or with the error it throws. Returns a function that stops answering on this connection.
export function serveControl (conn, { onRequest, onOpen = null, onClose = null }) {
  let mux
  try { mux = Protomux.from(conn) } catch { return () => {} }
  mux.pair({ protocol: PROTOCOL }, () => {
    createControl(conn, { onRequest, onOpen, onClose })?.channel.open()
  })
  return () => mux.unpair({ protocol: PROTOCOL })
}

// The sender's half: opens the channel on its connection to a receiver and resolves once the receiver answers it.
// A peer that is not a receiver refuses the channel, which rejects.
export function openControl (conn, { onEvent = null, onClose = null } = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let opened = false
    const refuse = message => {
      clearTimeout(timer)
      reject(new Error(message))
    }
    const control = createControl(conn, {
      onEvent,
      onOpen () {
        opened = true
        clearTimeout(timer)
        resolve(control)
      },
      onClose () {
        if (opened) onClose?.(control)
        else refuse('This peer does not take casts')
      }
    })
    if (!control) return reject(new Error('A cast session is already open with this receiver'))
    const timer = setTimeout(() => {
      control.close()
      refuse('Timed out opening the cast channel')
    }, timeoutMs)
    timer.unref?.()
    control.channel.open()
  })
}

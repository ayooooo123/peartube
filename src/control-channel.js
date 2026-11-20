// A request/reply channel between two peers: one Protomux channel on the connection the two nodes already share,
// beside Hypercore replication. Cast control (src/cast-control.js) and global search (src/search.js) each run one,
// under their own protocol name.
//   asking side   -> answering side   {id, type, ...}
//   answering side -> asking side     {id, ok, result | error}, and {event, ...} pushed at any time
// Any peer on the connection can open the channel, so the answering side decides per request what it allows.
import Protomux from 'protomux'
import c from 'compact-encoding'

export const MAX_FRAME = 64 * 1024

// One JSON object per message. Anything else a peer sends (too long, broken JSON, `null`, a number) decodes to null
// and is dropped: Protomux closes the whole connection on a decoder or handler that throws.
function jsonFrame (maxFrame) {
  return {
    preencode: c.json.preencode,
    encode: c.json.encode,
    decode (state) {
      if (state.end - state.start > maxFrame) {
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
}

// One half of the channel on `conn`, not yet opened; null when this connection already has one. `label` names the
// other side in errors ("Receiver connection closed").
function createChannel (conn, { protocol, maxFrame = MAX_FRAME, label, onRequest = null, onEvent = null, onOpen = null, onClose = null }) {
  const mux = Protomux.from(conn)
  if (mux.opened({ protocol })) return null
  const pending = new Map()
  let seq = 1
  const control = {
    conn,
    channel: null,
    get closed () { return control.channel.closed },
    // Sends an event or a reply; false when the connection wants the sender to wait for 'drain'.
    push: msg => message.send(msg),
    call (type, payload = {}, timeoutMs = 10_000) {
      if (control.closed) return Promise.reject(new Error(`${label} connection closed`))
      const id = seq++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Object.assign(new Error(`${label} ${type} timed out`), { code: 'ETIMEDOUT' }))
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        message.send({ id, type, ...payload })
      })
    },
    close: () => control.channel.close()
  }
  control.channel = mux.createChannel({
    protocol,
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
    encoding: jsonFrame(maxFrame),
    onmessage (msg) {
      if (!msg) return
      if (onRequest && typeof msg.type === 'string') {
        Promise.resolve().then(() => onRequest(msg, control)).then(
          result => { message.send({ id: msg.id, ok: true, result }) },
          err => { message.send({ id: msg.id, ok: false, error: err.message }) }
        ).catch(() => {})
      } else if ('ok' in msg && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error || `${label} error`))
      } else if (msg.event) {
        try { onEvent?.(msg) } catch {}
      }
    }
  })
  return control
}

// The answering half: answers every peer that opens `protocol` on `conn` with what `onRequest(msg, control)` returns,
// or with the error it throws. Returns a function that stops answering on this connection.
export function serveChannel (conn, { protocol, maxFrame, label, onRequest, onOpen = null, onClose = null }) {
  let mux
  try { mux = Protomux.from(conn) } catch { return () => {} }
  mux.pair({ protocol }, () => {
    createChannel(conn, { protocol, maxFrame, label, onRequest, onOpen, onClose })?.channel.open()
  })
  return () => mux.unpair({ protocol })
}

// The asking half: opens `protocol` on `conn` and resolves once the other side answers it. A peer that does not serve
// the protocol refuses the channel, which rejects with `refused`. With `onRequest`, this side also answers the other
// side's requests on the same channel, so two peers that both serve can ask each other.
export function openChannel (conn, { protocol, maxFrame, label, onRequest = null, onEvent = null, onClose = null, refused, duplicate, timedOut }, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let opened = false
    const refuse = message => {
      clearTimeout(timer)
      reject(new Error(message))
    }
    const control = createChannel(conn, {
      protocol,
      maxFrame,
      label,
      onRequest,
      onEvent,
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
      control.close()
      refuse(timedOut)
    }, timeoutMs)
    timer.unref?.()
    control.channel.open()
  })
}

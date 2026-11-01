// Ephemeral Ed25519-signed Protomux live chat mesh (`peartube/chat/v1`): rides existing swarm/LAN/2-hop-private
// connections so 10,000 throbbing mouths never touch RocksDB or bloat QuickJS oplogs.
// ponytail: bounded 64x200 RAM ring; add streamer VOD chat sub-core only when replay archival is needed.
import Protomux from 'protomux'
import c from 'compact-encoding'
import hypercoreCrypto from 'hypercore-crypto'
import b4a from 'b4a'

const CHAT_PROTOCOL = 'peartube/chat/v1'
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const ROOM = /^[a-z0-9:._-]{1,128}$/i
const MAX_SEEN = 1024
const MAX_ROOMS = 64
const MAX_ROOM_MSGS = 200
const MAX_CLOCK_SKEW_MS = 5 * 60_000

function signPayload (m) {
  return b4a.from(`peartube/chat/v1\n${m.room}\n${m.id}\n${m.ts}\n${m.nick}\n${m.text}`)
}

export function verifyChatMessage (m) {
  if (!m || typeof m !== 'object') return null
  const room = String(m.room || '').trim().toLowerCase()
  const id = String(m.id || '').trim().toLowerCase()
  const author = String(m.author || '').trim().toLowerCase()
  const sig = String(m.sig || '').trim().toLowerCase()
  const nick = String(m.nick || '').trim().slice(0, 40).toWellFormed()
  const text = String(m.text || '').trim().slice(0, 500).toWellFormed()
  const ts = m.ts
  if (!ROOM.test(room) || !/^[0-9a-f]{16,64}$/.test(id) || !HEX64.test(author) || !HEX128.test(sig)) return null
  if (!text || !Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) return null
  const clean = { room, id, ts, author, nick: nick || author.slice(0, 8), text, sig }
  try {
    if (!hypercoreCrypto.verify(signPayload(clean), b4a.from(sig, 'hex'), b4a.from(author, 'hex'))) return null
  } catch { return null }
  return clean
}

export function createChat (node, { onMessage = null } = {}) {
  const defaultKeyPair = node.localChannel?.core?.keyPair?.secretKey
    ? node.localChannel.core.keyPair
    : hypercoreCrypto.keyPair()
  const seen = new Set()
  const rooms = new Map() // room -> Array<msg>
  const peers = new Map() // conn -> sendFn
  let closed = false

  function recordSeen (id) {
    if (seen.has(id)) return false
    if (seen.size >= MAX_SEEN) seen.delete(seen.keys().next().value)
    seen.add(id)
    return true
  }

  function storeMessage (msg) {
    let list = rooms.get(msg.room)
    if (!list) {
      if (rooms.size >= MAX_ROOMS) rooms.delete(rooms.keys().next().value)
      list = []
      rooms.set(msg.room, list)
    }
    list.push(msg)
    if (list.length > MAX_ROOM_MSGS) list.shift()
  }

  function accept (raw, fromConn = null) {
    if (closed) return null
    const msg = verifyChatMessage(raw)
    if (!msg || node.isMuted?.(msg.author) || !recordSeen(msg.id)) return null
    storeMessage(msg)
    const wire = JSON.stringify(msg)
    for (const [conn, send] of peers) {
      if (conn !== fromConn && !conn.destroyed) { try { send(wire) } catch {} }
    }
    onMessage?.(msg)
    return msg
  }

  function openChannel (conn, mux) {
    if (closed || conn.destroyed || mux.opened({ protocol: CHAT_PROTOCOL })) return
    let wireMsg = null
    const ch = mux.createChannel({
      protocol: CHAT_PROTOCOL,
      id: null,
      onopen () {
        peers.set(conn, text => wireMsg.send(text))
      },
      onclose () { peers.delete(conn) }
    })
    if (!ch) return
    wireMsg = ch.addMessage({
      encoding: c.string,
      onmessage (raw) {
        let parsed = null
        try { parsed = JSON.parse(raw) } catch { return }
        accept(parsed, conn)
      }
    })
    try { ch.open() } catch {}
  }

  function attach (conn) {
    if (closed || conn.destroyed) return
    let mux
    try { mux = Protomux.from(conn) } catch { return }
    // Every peer pairs on arrival so late-attaching mouths never bounce off an unpaired Protomux hole.
    mux.pair({ protocol: CHAT_PROTOCOL }, () => openChannel(conn, mux))
    openChannel(conn, mux)
  }

  const detach = node.onConnection(attach)
  for (const conn of node.peerConnections()) attach(conn)

  function post ({ room, text, nick = '', signed = null }) {
    if (signed) {
      const accepted = accept(signed, null)
      if (!accepted) throw new Error('Invalid or muted signed chat message')
      return accepted
    }
    const cleanRoom = String(room || '').trim().toLowerCase()
    const cleanText = String(text || '').trim().slice(0, 500).toWellFormed()
    if (!ROOM.test(cleanRoom) || !cleanText) throw new Error('Valid room and non-empty message required')
    const author = b4a.toString(defaultKeyPair.publicKey, 'hex')
    const draft = {
      room: cleanRoom,
      id: b4a.toString(hypercoreCrypto.randomBytes(16), 'hex'),
      ts: Date.now(),
      author,
      nick: String(nick || '').trim().slice(0, 40).toWellFormed() || author.slice(0, 8),
      text: cleanText
    }
    const sig = b4a.toString(hypercoreCrypto.sign(signPayload(draft), defaultKeyPair.secretKey), 'hex')
    const accepted = accept({ ...draft, sig }, null)
    if (!accepted) throw new Error('Message rejected')
    return accepted
  }

  function history (room, { since = 0, limit = 100 } = {}) {
    const cleanRoom = String(room || '').trim().toLowerCase()
    const list = rooms.get(cleanRoom) || []
    const filtered = list.filter(m => !node.isMuted?.(m.author) && (since <= 0 || m.ts > since))
    return filtered.slice(-Math.max(1, Math.min(MAX_ROOM_MSGS, Number(limit) || 100)))
  }

  function close () {
    closed = true
    detach?.()
    peers.clear()
  }

  return {
    publicKey: b4a.toString(defaultKeyPair.publicKey, 'hex'),
    post,
    history,
    peers: () => peers.size,
    close
  }
}

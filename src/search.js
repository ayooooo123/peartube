// Global search (peartube/search/v1): ask relays this node does not follow for media they hold, on the connections
// the swarm already makes (src/control-channel.js), and answer such asks when this node is a relay that opted in
// (the `globalSearch` setting). A hit is a watch link without `source=`, for a file the answering relay holds whole
// and has checked is media, so the searcher reads it from that relay on the same connection.
//   searcher -> relay   {id, type: 'search', q, mid, limit}
//   relay -> searcher   {id, ok: true, result: {hits: [{uri}]}} or {id, ok: false, error: 'busy'}
// Relays announce one topic; a searcher looks it up only while it searches, and closes what it dialed for search
// a minute after its last search.
import hypercoreCrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { openChannel, serveChannel } from './control-channel.js'
import { ID, describeEntry, formatWatchUri, parseUri } from './protocol.js'
import { diversityBucketForAddress } from './private-overlay.js'

const PROTOCOL = 'peartube/search/v1'
export const SEARCH_TOPIC = hypercoreCrypto.hash(b4a.from('peartube/search/v1/0'))
const MAX_HITS = 20
const MAX_URI = 2048
const MAX_QUERY = 120
const MAX_WORDS = 8
const ASK_CONNECTED = 16 // peers already connected that one search asks
const ASK_TOPIC = 4 // relays from the topic that one search asks
const PER_BUCKET = 2 // of those, at most this many from one /24 (IPv6 /48)
const COLLECT_MS = 1200 // a search returns what arrived by then; later answers come with the next call
const ASK_TIMEOUT_MS = 3000
const IDLE_MS = 60_000 // after the last search the lookup ends and search-only connections close
const KEEP_RUNS = 8
const FRESH_MS = 10_000 // the same search asked again after this asks every relay again, so newer files show up
const LIST_MS = 15_000 // a relay rebuilds its list of offered files at most this often
const SERVE_CHANNELS = 64
const WINDOW_MS = 10_000
const PER_CHANNEL = 4 // queries per window from one channel
const PER_NODE = 20 // queries per window for the whole node

const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.() })
const hexOf = conn => conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : ''

// A query as words: lower case, split at spaces and ASCII punctuation, at most 8 words of 2 or more characters. No
// RegExp is built from it. (No Unicode property escapes or Intl: the apps' worklet runs QuickJS.)
function words (q) {
  return String(q || '').slice(0, MAX_QUERY).toLowerCase().split(/[\s!-/:-@[-`{-~]+/).filter(w => w.length >= 2).slice(0, MAX_WORDS)
}
const validId = mid => typeof mid === 'string' && mid.length <= 80 && ID.test(mid.toLowerCase()) ? mid.toLowerCase() : null

// A hit as the watch entry it names, or null. Hits are a stranger's claims: only the shape is checked here, and
// Hypercore checks every byte the link later reads.
function checkHit (hit) {
  if (!hit || typeof hit.uri !== 'string' || hit.uri.length > MAX_URI) return null
  let parsed
  try { parsed = parseUri(hit.uri) } catch { return null }
  if (parsed.action !== 'watch') return null
  const { entry } = parsed
  if (!(entry.blob.byteLength > 0) || entry.blob.blockLength > 2 ** 20 || /^0+$/.test(entry.sha256)) return null
  return entry
}

export function createGlobalSearch ({ swarm, peerConnections, connListeners, isPrivate, isLan, isSourcePeer, publicEntries, onUpdate = null }) {
  let closed = false
  let serving = null // { isMedia } while this node answers
  let session = null // the searcher's client lookup on the topic
  let announce = null // the relay's server announce on the topic
  let idleTimer = null
  let current = null // the newest search, asked of connections that open while it lasts
  const runs = new Map() // query key -> run, newest last
  const controls = new Map() // conn -> Promise<control>
  const topicConns = new Map() // conn -> peerInfo, for connections the search lookup dialed
  const served = new Map() // control -> { at: [] }, oldest first
  const unpairs = new Map() // conn -> stop answering
  const nodeHits = []

  // ---- answering (relay) ----

  let list = null
  let listAt = 0
  function offered () {
    if (!list || Date.now() - listAt > LIST_MS) {
      listAt = Date.now()
      list = publicEntries().then(entries => entries
        .filter(e => serving?.isMedia(`${e.blobs}:${e.blob.blockOffset}`))
        .map(e => ({ entry: e, text: `${e.title} ${e.id}`.toLowerCase() })))
      list.catch(() => { list = null })
    }
    return list
  }

  function overLimit (stamps, max, now) {
    while (stamps.length && now - stamps[0] > WINDOW_MS) stamps.shift()
    if (stamps.length >= max) return true
    stamps.push(now)
    return false
  }

  async function answer (msg, control) {
    if (!serving || closed || isPrivate()) throw new Error('off')
    if (msg.type !== 'search') throw new Error('unknown request')
    const rec = served.get(control) || { at: [] }
    served.delete(control)
    served.set(control, rec)
    const now = Date.now()
    if (overLimit(rec.at, PER_CHANNEL, now) || overLimit(nodeHits, PER_NODE, now)) throw new Error('busy')
    const ws = words(msg.q)
    const mid = validId(msg.mid)
    if (!ws.length && !mid) throw new Error('bad query')
    const limit = Math.min(MAX_HITS, Math.max(1, Number(msg.limit) || MAX_HITS))
    const hits = []
    for (const { entry, text } of await offered()) {
      if (mid && entry.id !== mid && !entry.id.startsWith(mid + ':')) continue
      if (!ws.every(w => text.includes(w))) continue
      const uri = formatWatchUri(entry)
      if (uri.length <= MAX_URI) hits.push({ uri })
      if (hits.length >= limit) break
    }
    return { hits }
  }

  function track (control) {
    served.set(control, { at: [] })
    // The least recently used channel goes, never the connection under it.
    for (const old of served.keys()) {
      if (served.size <= SERVE_CHANNELS) break
      if (old !== control) { served.delete(old); old.close() }
    }
  }

  function pair (conn) {
    if (!serving || closed || unpairs.has(conn) || conn.destroyed) return
    unpairs.set(conn, serveChannel(conn, {
      protocol: PROTOCOL,
      label: 'Searcher',
      onRequest: answer,
      onOpen: control => {
        track(control)
        controls.set(conn, Promise.resolve(control))
      },
      onClose: control => {
        served.delete(control)
        controls.delete(conn)
      }
    }))
    conn.once('close', () => unpairs.delete(conn))
  }

  // Answering on or off. `opts.isMedia(key)` says whether the file at `<blobs>:<blockOffset>` is media.
  function serve (opts) {
    if (closed) return
    if (opts && !isPrivate()) {
      serving = { isMedia: opts.isMedia }
      list = null
      for (const conn of peerConnections()) pair(conn)
      if (!announce) announce = swarm.join(SEARCH_TOPIC, { server: true, client: false })
      return
    }
    serving = null
    list = null
    for (const stop of unpairs.values()) stop()
    unpairs.clear()
    for (const control of served.keys()) control.close()
    served.clear()
    announce?.destroy().catch(() => {})
    announce = null
  }

  // ---- asking (any node) ----

  function rows (run, limit) {
    const out = [...run.rows.values()].sort((a, b) =>
      (b.exact - a.exact) || (b.relays.size - a.relays.size) || (a.entry.title < b.entry.title ? -1 : a.entry.title > b.entry.title ? 1 : 0))
    return out.slice(0, limit).map(({ key, entry, relays }) => ({
      key,
      id: entry.id,
      title: entry.title,
      size: entry.size,
      sha256: entry.sha256,
      relays: relays.size,
      ...describeEntry(entry.id, entry.title),
      magnetUrl: formatWatchUri(entry)
    }))
  }

  function control (conn) {
    let p = controls.get(conn)
    if (!p) {
      p = openChannel(conn, {
        protocol: PROTOCOL,
        label: 'Relay',
        onRequest: answer,
        onClose: () => controls.delete(conn),
        refused: 'This peer does not answer searches',
        duplicate: 'A search channel is already open with this peer',
        timedOut: 'Timed out opening the search channel'
      }, ASK_TIMEOUT_MS)
      controls.set(conn, p)
      p.catch(() => { if (controls.get(conn) === p) controls.delete(conn) })
    }
    return p
  }

  async function ask (run, conn, fromTopic) {
    const hex = hexOf(conn)
    if (!hex || conn.destroyed || run.asked.has(hex)) return
    if (fromTopic) {
      if (run.topicAsked >= ASK_TOPIC) return
      const raw = conn.rawStream
      const bucket = diversityBucketForAddress(raw?.remoteHost, raw?.remotePort, true) || hex
      if ((run.buckets.get(bucket) || 0) >= PER_BUCKET) return
      run.buckets.set(bucket, (run.buckets.get(bucket) || 0) + 1)
      run.topicAsked++
    } else if (run.asked.size - run.topicAsked >= ASK_CONNECTED) return
    run.asked.add(hex)
    try {
      const c = await control(conn)
      const res = await c.call('search', { q: run.q, mid: run.mid, limit: MAX_HITS }, ASK_TIMEOUT_MS)
      const hits = Array.isArray(res?.hits) ? res.hits.slice(0, MAX_HITS) : []
      let added = false
      for (const hit of hits) {
        const entry = checkHit(hit)
        if (!entry) continue
        const b = entry.blob
        const key = `search/${entry.blobs}:${b.blockOffset}:${b.blockLength}:${b.byteOffset}:${b.byteLength}`
        let row = run.rows.get(key)
        if (!row) {
          row = { key, entry, relays: new Set(), exact: run.mid && entry.id === run.mid ? 1 : 0 }
          run.rows.set(key, row)
        }
        if (!row.relays.has(hex)) { row.relays.add(hex); added = true }
      }
      if (added && run.returned) onUpdate?.()
    } catch {}
  }

  function onSwarmConnection (conn, peerInfo) {
    if (!session || !peerInfo?.topics?.some(t => b4a.equals(t, SEARCH_TOPIC))) return
    topicConns.set(conn, peerInfo)
    conn.once('close', () => topicConns.delete(conn))
    if (current) ask(current, conn, true)
  }
  swarm.on('connection', onSwarmConnection)
  connListeners.add(pair)

  // Ends the lookup and closes the connections only it made: not LAN links, not peers in a shared topic, and not a
  // peer that has served this node a block (a hit being played).
  function endSearch () {
    clearTimeout(idleTimer)
    idleTimer = null
    current = null
    session?.destroy().catch(() => {})
    session = null
    for (const [conn, peerInfo] of topicConns) {
      const onlySearch = peerInfo.topics.every(t => b4a.equals(t, SEARCH_TOPIC))
      if (!onlySearch || isLan(conn) || isSourcePeer(hexOf(conn))) continue
      conn.destroy()
    }
    topicConns.clear()
  }

  // Rows for `query` (words in any order) and/or `id`, after COLLECT_MS. Asked again within FRESH_MS it returns the
  // answers that arrived since; after that it is a new search, so a file published or removed since is seen.
  async function searchGlobal ({ query = '', id = null, limit = MAX_HITS } = {}) {
    if (closed) throw new Error('Node is closing')
    if (isPrivate()) throw new Error('Global search is off while traffic is routed privately')
    const ws = words(query)
    const mid = validId(id)
    if (!ws.length && !mid) throw new Error('Type at least 2 letters')
    const q = ws.join(' ')
    const runKey = `${q}\n${mid || ''}`
    let run = runs.get(runKey)
    runs.delete(runKey)
    if (!run || Date.now() - run.at > FRESH_MS) {
      run = { q, mid, at: Date.now(), rows: new Map(), asked: new Set(), buckets: new Map(), topicAsked: 0, returned: false }
    }
    runs.set(runKey, run)
    for (const k of runs.keys()) { if (runs.size <= KEEP_RUNS) break; runs.delete(k) }
    current = run
    if (!session) session = swarm.join(SEARCH_TOPIC, { server: false, client: true, limit: ASK_TOPIC })
    clearTimeout(idleTimer)
    idleTimer = setTimeout(endSearch, IDLE_MS)
    idleTimer.unref?.()
    for (const conn of topicConns.keys()) ask(run, conn, true)
    for (const conn of peerConnections()) if (!topicConns.has(conn)) ask(run, conn, false)
    if (!run.returned) await sleep(COLLECT_MS)
    run.returned = true
    return rows(run, Math.min(MAX_HITS * ASK_TOPIC, Math.max(1, Number(limit) || MAX_HITS)))
  }

  return {
    searchGlobal,
    serve,
    suspend: endSearch,
    close () {
      closed = true
      endSearch()
      serve(null)
      swarm.off('connection', onSwarmConnection)
      connListeners.delete(pair)
    }
  }
}

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'

// How a relay shares its upload between people watching and bulk copying: it detects its own viewers, tells
// connected PearTube relays over `peartube/bulk-busy` (their backfill waits while any peer is busy), and paces the
// bulk connections it is told about (HiveRelays) under one budget.
const BUSY_PROTOCOL_NAME = 'peartube/bulk-busy'

export function createTrafficGate ({ node, uploadMbps = 0 }) {
  let closed = false
  // Bulk peers (HiveRelays and replica relays: they open `hiverelay-seed` but never request) are kept off viewers'
  // upload. PearTube relays answer `peartube/bulk-busy` and pace themselves: their backfill stops while any connected
  // relay reports viewing. Peers that don't (HiveRelays) share one upload budget instead; over it their connections
  // are paused so their requests wait. Never pause a relay that speaks bulk-busy: a connection paused for a few
  // seconds loses its Hypercore peers and the backfill on it stalls for good. Viewer apps open neither channel.
  const bulkBytesPerTick = uploadMbps > 0 ? uploadMbps * 125_000 / 4 : 0
  const bulkConns = new Map() // conn -> raw bytes written at the last tick
  let bulkTokens = bulkBytesPerTick
  let bulkPaused = false
  // While viewers stream, paused HiveRelays get turns. A paused connection still has a window of
  // requests queued, so resuming all of them in the same tick served every backlog at once: 8 MB/s bursts of
  // random reads that stalled the viewer on spinning disks. Each connection still gets a turn within TURN_MS,
  // inside Protomux's 10 s timeout: the due ones are spread over the ticks that fit in TURN_MS.
  const TICK_MS = 250
  const TURN_MS = 6000
  const lastTurn = new WeakMap() // bulk conn -> time it was last resumed
  let turnConns = []
  const rawWritten = conn => conn.rawBytesWritten || conn.rawStream?.bytesTransmitted || 0
  // Viewing: more than 1 Mbps going to non-bulk peers, held 3 s. Each relay tells its peers over `peartube/bulk-busy`;
  // p2p-replicate stops its backfill while any connected peer is busy (peersBusy()).
  const VIEWER_BYTES_PER_TICK = 1 * 125_000 / 4
  const VIEWER_HOLD_MS = 3000
  const viewerSent = new WeakMap() // non-bulk conn -> raw bytes written at the last tick
  const busyChannels = new Map() // conn -> { msg, remote }
  let viewersUntil = 0
  let viewing = false
  let tickTimer = null
  function tick () {
    let viewerBytes = 0
    for (const conn of node.peerConnections()) {
      if (conn.destroyed || bulkConns.has(conn)) continue
      const now = rawWritten(conn)
      const prev = viewerSent.get(conn)
      viewerSent.set(conn, now)
      if (prev !== undefined) viewerBytes += Math.max(0, now - prev)
    }
    if (viewerBytes >= VIEWER_BYTES_PER_TICK || node.httpViewing?.()) viewersUntil = Date.now() + VIEWER_HOLD_MS
    const nowViewing = Date.now() < viewersUntil
    if (nowViewing !== viewing) {
      viewing = nowViewing
      for (const rec of busyChannels.values()) { try { rec.msg.send(viewing ? 1 : 0) } catch {} }
    }
    if (!bulkBytesPerTick) return
    let sent = 0
    for (const [conn, prev] of bulkConns) {
      if (conn.destroyed) {
        // Same rule as an unmark: the peer stays bulk while another of its connections still is (a LAN dial replacing a DHT one).
        unmarkBulk(conn)
        continue
      }
      const now = rawWritten(conn)
      if (!busyChannels.has(conn)) sent += Math.max(0, now - prev)
      bulkConns.set(conn, now)
    }
    // While human viewers stream (P2P or /v1/blob), pulse non-bulk-busy HiveRelays at <= 0.5 Mbps (<= 6 s pause, under Protomux's 10 s timeout).
    const tickBudget = viewing ? Math.min(bulkBytesPerTick, 15_625) : bulkBytesPerTick
    const nextTokens = Math.min(tickBudget * 2, bulkTokens + tickBudget - sent)
    bulkTokens = viewing ? Math.max(-tickBudget * 24, nextTokens) : nextTokens
    const pause = bulkTokens < 0
    if (turnConns.length > 0) {
      // a turn lasts one tick: the backlog it released is already being served. A connection that became a
      // bulk-busy peer during its turn is never resumed again by this gate, so pausing it would strand its backfill.
      for (const conn of turnConns) {
        if (!conn.destroyed && bulkConns.has(conn) && bulkPaused && !busyChannels.has(conn)) conn.pause()
      }
      turnConns = []
    }
    if (viewing && pause) {
      const held = [...bulkConns.keys()].filter(conn => !busyChannels.has(conn))
      const now = Date.now()
      if (!bulkPaused) {
        bulkPaused = true
        // spread the first turns over TURN_MS instead of all coming due together
        held.forEach((conn, i) => { conn.pause(); lastTurn.set(conn, now - Math.floor(i * TURN_MS / held.length)) })
      }
      // Every held connection must get a turn within TURN_MS, or it trips Protomux's 10 s timeout: resume
      // ceil(held * TICK_MS / TURN_MS) due connections per tick, oldest turn first, and the whole set cycles
      // within TURN_MS.
      let due = Math.ceil(held.length * TICK_MS / TURN_MS)
      for (const conn of [...held].sort((a, b) => (lastTurn.get(a) || 0) - (lastTurn.get(b) || 0))) {
        if (due <= 0) break
        if (now - (lastTurn.get(conn) || 0) < TURN_MS) continue
        conn.resume()
        lastTurn.set(conn, now)
        turnConns.push(conn)
        due--
      }
      return
    }
    if (pause === bulkPaused) return
    bulkPaused = pause
    for (const conn of bulkConns.keys()) {
      if (busyChannels.has(conn)) continue
      pause ? conn.pause() : conn.resume()
    }
  }
  function markBulk (conn) {
    if (closed || conn.destroyed || bulkConns.has(conn)) return
    bulkConns.set(conn, rawWritten(conn))
    if (conn.remotePublicKey) node.markBulkPeer?.(b4a.toString(conn.remotePublicKey, 'hex'), true)
    if (bulkPaused && !busyChannels.has(conn)) conn.pause()
  }
  // A publisher (another PearTube relay) opens the same channel but sends seed requests; HiveRelays never do.
  function unmarkBulk (conn) {
    if (!bulkConns.delete(conn)) return
    if (conn.remotePublicKey && ![...bulkConns.keys()].some(c => c.remotePublicKey && b4a.equals(c.remotePublicKey, conn.remotePublicKey))) {
      node.markBulkPeer?.(b4a.toString(conn.remotePublicKey, 'hex'), false)
    }
    if (bulkPaused) conn.resume()
  }
  function attachBusy (conn, mux) {
    if (closed || conn.destroyed || mux.opened({ protocol: BUSY_PROTOCOL_NAME })) return
    const rec = { msg: null, remote: false }
    const channel = mux.createChannel({
      protocol: BUSY_PROTOCOL_NAME,
      id: null,
      onopen () {
        busyChannels.set(conn, rec)
        // It paces itself from here on; release it if the cap had paused it.
        if (bulkPaused && bulkConns.has(conn)) conn.resume()
        try { rec.msg.send(viewing ? 1 : 0) } catch {}
      },
      onclose () { busyChannels.delete(conn) }
    })
    if (!channel) return
    rec.msg = channel.addMessage({ encoding: c.uint, onmessage (v) { rec.remote = v === 1 } })
    try { channel.open() } catch {}
  }
  // A busy claim counts only from a peer that has sent this node verified blocks: any stranger can open the channel,
  // and a peer that serves this node nothing has no viewers its backfill could disturb.
  // shortcut: a peer that does serve blocks can still hold backfill with a false claim; sign the claim with a relay identity if that is abused.
  function peersBusy () {
    for (const [conn, rec] of busyChannels) {
      if (rec.remote && conn.remotePublicKey && node.isSourcePeer(b4a.toString(conn.remotePublicKey, 'hex'))) return true
    }
    return false
  }

  function attachConnection (conn) {
    if (closed || node.privateRouting || conn.destroyed) return
    let mux
    try { mux = Protomux.from(conn) } catch { return }
    // Protomux rejects an open for a protocol nobody paired: pair it, so a peer whose side attaches later still gets it.
    mux.pair({ protocol: BUSY_PROTOCOL_NAME }, () => attachBusy(conn, mux))
    attachBusy(conn, mux)
  }
  let detachConnections = null
  if (!node.privateRouting) {
    detachConnections = node.onConnection(attachConnection)
    for (const conn of node.peerConnections()) attachConnection(conn)
    tickTimer = setInterval(tick, TICK_MS)
    tickTimer.unref?.()
  }

  return {
    markBulk,
    unmarkBulk,
    peersBusy,
    info: () => ({ bulkUploadMbps: uploadMbps, bulkPeers: bulkConns.size, bulkPaused, servingViewers: viewing, peersBusy: peersBusy() }),
    stop () {
      closed = true
      clearInterval(tickTimer)
      tickTimer = null
      detachConnections?.()
      for (const conn of bulkConns.keys()) conn.resume()
      bulkConns.clear()
      bulkPaused = false
      turnConns = []
      busyChannels.clear()
      viewing = false
    }
  }
}

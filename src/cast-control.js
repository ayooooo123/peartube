// The control channel between a cast sender and a receiver (peartube-cast/v2, spec/protocols.js), on the shared
// request/reply channel (src/control-channel.js): one Protomux channel on the peer connection the two nodes already
// share, beside Hypercore replication. A cast needs no connection, port or server of its own, and its messages travel
// under that connection's Noise encryption.
//   sender -> receiver   pair `cast-pair` -> `cast-paired`; subscribe `cast-subscribe` -> `cast-state`;
//                        command `cast-command` -> `cast-state`
//   receiver -> sender   event `state` (`cast-state`) once subscribed
// Any peer that connects to a receiver can open this channel, so the receiver decides per request what it allows.
// The wire carries every field of a struct; a value that is not set travels as a stand-in outside its domain (named in
// spec/build.mjs). The pairs of functions below are the only place that maps between the two.
import b4a from 'b4a'
import { CAST } from '../spec/protocols.js'
import { openChannel, serveChannel } from './control-channel.js'

const MAX_TRACKS = 128
const MAX_ERROR = 256
const MAX_INT = 2 ** 52 - 1

// The receiver's half: answers every sender that opens the channel on `conn` with `handlers` (`pair`, `subscribe`,
// `command`). Returns a function that stops answering on this connection.
export function serveControl (conn, { handlers, onOpen = null, onClose = null }) {
  return serveChannel(conn, { spec: CAST, label: 'Receiver', handlers, onOpen, onClose })
}

// The sender's half: opens the channel on its connection to a receiver and resolves once the receiver answers it.
// A peer that is not a receiver, or one on another PearTube version, refuses the channel, which rejects.
export function openControl (conn, { onState = null, onClose = null } = {}, timeoutMs = 10_000) {
  return openChannel(conn, {
    spec: CAST,
    label: 'Receiver',
    events: onState ? { state: wire => onState(stateFromWire(wire)) } : {},
    onClose,
    refused: 'This device runs a different PearTube version, or takes no casts: update PearTube on both devices',
    duplicate: 'A cast session is already open with this receiver',
    timedOut: 'Timed out opening the cast channel'
  }, timeoutMs)
}

// Whole milliseconds, 0 or more (positions, durations, sizes, counts, clocks).
function uint (n) {
  const v = Math.round(Number(n))
  return Number.isFinite(v) && v > 0 ? Math.min(v, Number.MAX_SAFE_INTEGER) : 0
}

// A signed whole number in the wire's `int` range, or `none` when there is no number (null and undefined included:
// Number(null) would be 0).
function int (n, none) {
  if (n == null) return none
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.max(-MAX_INT - 1, Math.min(MAX_INT, v)) : none
}

// A string cut to `max` UTF-16 code units, well formed (a pair cut in half becomes U+FFFD). The bounds below make the
// largest state fit one 64 KiB frame (test/cast-wire.test.js measures it).
const text = (s, max) => s == null ? '' : String(s).slice(0, max).toWellFormed()
const orNull = s => s === '' ? null : s

// A cast entry as it is kept and sent: the receiver bounds the one it loads with the same rule, since it goes into
// every later state.
export function boundedEntry (entry) {
  return { key: text(entry.key, 256), id: text(entry.id, 128), title: text(entry.title, 80), size: uint(entry.size), sha256: text(entry.sha256, 64) }
}

function entryToWire (entry) {
  return entry ? boundedEntry(entry) : null
}

function trackToWire (t) {
  return {
    stream: int(t?.stream, -1),
    kind: text(t?.kind, 16),
    codec: text(t?.codec, 32),
    language: text(t?.language, 32),
    title: text(t?.title, 64)
  }
}

// The receiver's state as it travels. Stand-ins: '' for no mode, error or decoder; 0 for an unknown duration; -2 for
// an unknown audio or subtitle stream (-1 is "off"); -1 for dropped frames not reported.
export function stateToWire (state) {
  return {
    tracks: (Array.isArray(state.tracks) ? state.tracks.slice(0, MAX_TRACKS) : []).map(trackToWire),
    status: text(state.status, 32),
    mode: text(state.mode, 32),
    entry: entryToWire(state.entry),
    positionMs: uint(state.positionMs),
    durationMs: uint(state.durationMs),
    playing: Boolean(state.playing),
    buffering: Boolean(state.buffering),
    ended: Boolean(state.ended),
    p2pPeers: uint(state.p2pPeers),
    cachedBytes: uint(state.cachedBytes),
    seeding: Boolean(state.seeding),
    volume: Number.isFinite(state.volume) ? state.volume : 1,
    muted: Boolean(state.muted),
    audio: state.audio == null ? -2 : int(state.audio, -2),
    subtitle: state.subtitle == null ? -2 : int(state.subtitle, -2),
    error: text(state.error, MAX_ERROR),
    updatedAt: uint(state.updatedAt),
    videoDecoder: text(state.videoDecoder, 64),
    droppedFrames: state.droppedFrames == null ? -1 : Math.max(0, int(state.droppedFrames, 0))
  }
}

// The state a sender shows: every key of the struct, `null` where the wire had a stand-in.
export function stateFromWire (w) {
  return {
    status: w.status,
    mode: orNull(w.mode),
    entry: w.entry ? { ...w.entry } : null,
    positionMs: w.positionMs,
    durationMs: w.durationMs || null,
    playing: w.playing,
    buffering: w.buffering,
    ended: w.ended,
    p2pPeers: w.p2pPeers,
    cachedBytes: w.cachedBytes,
    seeding: w.seeding,
    volume: w.volume,
    muted: w.muted,
    tracks: w.tracks.map(t => ({ stream: t.stream, kind: t.kind, codec: t.codec, language: orNull(t.language), title: orNull(t.title) })),
    audio: w.audio === -2 ? null : w.audio,
    subtitle: w.subtitle === -2 ? null : w.subtitle,
    error: orNull(w.error),
    updatedAt: w.updatedAt,
    videoDecoder: orNull(w.videoDecoder),
    droppedFrames: w.droppedFrames === -1 ? null : w.droppedFrames
  }
}

// A sender's command (`{ action, ...arguments }`, as the apps and the web UI send it) as it travels. Only the
// arguments of its action are sent; the rest are stand-ins the receiver ignores. volume and muted: -1 = leave as it
// is; muted 0 off, 1 on. stream: -1 = off. deltaMs keeps its sign.
export function commandToWire (cmd, token) {
  const action = text(cmd?.action, 32)
  const load = action === 'load'
  const volume = action === 'volume'
  return {
    token: text(token, 256),
    action,
    entry: load ? entryToWire(cmd.entry) : null,
    magnetUrl: load ? text(cmd.magnetUrl, 2048) : '',
    startPositionMs: load ? uint(cmd.startPositionMs) : 0,
    positionMs: action === 'seek' ? uint(cmd.positionMs) : 0,
    deltaMs: action === 'skip' ? int(cmd.deltaMs, 0) : 0,
    stream: action === 'selectAudio' || action === 'selectSubtitle' ? int(cmd.stream, -1) : -1,
    volume: volume && typeof cmd.volume === 'number' && Number.isFinite(cmd.volume) ? Math.max(0, Math.min(1, cmd.volume)) : -1,
    muted: volume && typeof cmd.muted === 'boolean' ? Number(cmd.muted) : -1
  }
}

// The command a receiver applies: the action and only its own arguments, as the sender's app gave them.
export function commandFromWire (w) {
  const { action } = w
  if (action === 'load') return { action, ...(w.entry ? { entry: { ...w.entry } } : {}), magnetUrl: orNull(w.magnetUrl), startPositionMs: w.startPositionMs }
  if (action === 'seek') return { action, positionMs: w.positionMs }
  if (action === 'skip') return { action, deltaMs: w.deltaMs }
  if (action === 'selectAudio' || action === 'selectSubtitle') return { action, stream: w.stream }
  if (action === 'volume') {
    return {
      action,
      ...(w.volume >= 0 ? { volume: w.volume } : {}),
      ...(w.muted === 0 || w.muted === 1 ? { muted: w.muted === 1 } : {})
    }
  }
  return { action }
}

// A pairing request, a subscription, and the receiver's answer to a pairing: its public key travels as 32 bytes, and
// is hex on both sides of the wire.
export const pairToWire = code => ({ code: text(code, 16) })
export const subscribeToWire = token => ({ token: text(token, 256) })

export function pairedToWire ({ deviceId, name, publicKey, token }) {
  return { deviceId: text(deviceId, 128), name: text(name, 80), publicKey: b4a.from(publicKey, 'hex'), token: text(token, 256) }
}

export function pairedFromWire (w) {
  return { deviceId: w.deviceId, name: w.name, publicKey: b4a.toString(w.publicKey, 'hex'), token: w.token }
}

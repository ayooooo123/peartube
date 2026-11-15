// The control channel between a cast sender and a receiver (peartube-cast/v1), on the shared request/reply channel
// (src/control-channel.js): one Protomux channel on the peer connection the two nodes already share, beside Hypercore
// replication. A cast needs no connection, port or server of its own, and its messages travel under that
// connection's Noise encryption.
//   sender -> receiver   {id, type: 'pair' | 'subscribe' | 'cmd', ...}
//   receiver -> sender   {id, ok, result | error}, and {event: 'state', state} once subscribed
// Any peer that connects to a receiver can open this channel, so the receiver decides per request what it allows.
import { openChannel, serveChannel } from './control-channel.js'

const CAST = { protocol: 'peartube-cast/v1', label: 'Receiver' }

// The receiver's half: answers every sender that opens the channel on `conn` with what `onRequest(msg, control)`
// returns, or with the error it throws. Returns a function that stops answering on this connection.
export function serveControl (conn, { onRequest, onOpen = null, onClose = null }) {
  return serveChannel(conn, { ...CAST, onRequest, onOpen, onClose })
}

// The sender's half: opens the channel on its connection to a receiver and resolves once the receiver answers it.
// A peer that is not a receiver refuses the channel, which rejects.
export function openControl (conn, { onEvent = null, onClose = null } = {}, timeoutMs = 10_000) {
  return openChannel(conn, {
    ...CAST,
    onEvent,
    onClose,
    refused: 'This peer does not take casts',
    duplicate: 'A cast session is already open with this receiver',
    timedOut: 'Timed out opening the cast channel'
  }, timeoutMs)
}

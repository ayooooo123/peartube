import test from 'brittle'
import {
  peerHasFullRange,
  collectFullCopyPeers,
} from '../src/upload-offload.js'

// A peer that holds every block strictly below `have` (a contiguous prefix),
// mirroring hypercore's RemoteBitfield.firstUnset semantics.
function peerWithPrefix(have, keyHex = null) {
  return {
    remotePublicKey: keyHex ? Buffer.from(keyHex, 'hex') : null,
    remoteBitfield: {
      firstUnset(start) {
        return start < have ? have : start
      },
    },
  }
}

// A peer that exposes only a contiguous length (no bitfield), to exercise the
// fallback path.
function peerWithContiguous(length, keyHex = null) {
  return {
    remotePublicKey: keyHex ? Buffer.from(keyHex, 'hex') : null,
    remoteContiguousLength: length,
  }
}

const RELAY = 'aa'.repeat(32)
const PEER1 = 'cc'.repeat(32)
const PEER2 = 'dd'.repeat(32)

test('peerHasFullRange requires every block of the range', (t) => {
  // Blob occupies blocks [10, 14).
  t.ok(peerHasFullRange(peerWithPrefix(14), 10, 14), 'covers exactly the range')
  t.ok(peerHasFullRange(peerWithPrefix(100), 10, 14), 'covers more than the range')
  t.absent(peerHasFullRange(peerWithPrefix(13), 10, 14), 'missing the last block')
  t.absent(peerHasFullRange(peerWithPrefix(10), 10, 14), 'has nothing in the range')
  t.absent(peerHasFullRange(null, 10, 14), 'no peer')
})

test('peerHasFullRange falls back to remoteContiguousLength when no bitfield', (t) => {
  t.ok(peerHasFullRange(peerWithContiguous(14), 10, 14), 'contiguous covers range end')
  t.absent(peerHasFullRange(peerWithContiguous(13), 10, 14), 'contiguous short of range end')
})

test('collectFullCopyPeers tags identified holders and counts anonymous ones', (t) => {
  const range = { blockOffset: 10, blockLength: 4 } // [10, 14)
  const peers = [
    peerWithPrefix(14, RELAY),      // full copy, identified
    peerWithPrefix(14),             // full copy, anonymous (no key)
    peerWithPrefix(12, PEER1),      // partial — excluded
    peerWithContiguous(20, PEER2),  // full copy via contiguous length
  ]
  const { fullCopyKeys, fullCopyAnonymous } = collectFullCopyPeers(peers, range)
  t.alike(fullCopyKeys.sort(), [RELAY, PEER2].sort())
  t.is(fullCopyAnonymous, 1)
})

test('collectFullCopyPeers rejects malformed ranges', (t) => {
  const peers = [peerWithPrefix(100, RELAY)]
  t.is(collectFullCopyPeers(peers, { blockOffset: -1, blockLength: 4 }).fullCopyKeys.length, 0)
  t.is(collectFullCopyPeers(peers, { blockOffset: 0, blockLength: 0 }).fullCopyKeys.length, 0)
  t.is(collectFullCopyPeers(peers, {}).fullCopyKeys.length, 0)
})

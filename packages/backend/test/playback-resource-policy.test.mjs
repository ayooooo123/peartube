import test from 'brittle'

import { createPlaybackResourcePolicy } from '../src/playback/resource-policy.js'

test('playback resource policy keeps local playback while throttling network features', (t) => {
  const policy = createPlaybackResourcePolicy()
  t.alike(policy.evaluate({ foreground: true, metered: false, charging: true, thermalState: 'nominal', userAllowsP2P: true }), {
    localPlayback: true,
    peerDiscovery: true,
    upload: true,
    cacheFill: true,
    // An archive pledge is never implied by healthy resources.
    archiving: false,
  })
  t.alike(policy.evaluate({ foreground: false, metered: true, charging: false, thermalState: 'serious', userAllowsP2P: false }), {
    localPlayback: true,
    peerDiscovery: false,
    upload: false,
    cacheFill: false,
    archiving: false,
  })
})

test('playback resource policy bounds requests, peers, in-flight bytes, disk, and deadlines', (t) => {
  const policy = createPlaybackResourcePolicy({ maxPeers: 4, maxRequests: 8, maxInFlightBytes: 1024, maxDiskBytes: 2048, deadlineMs: 5000 })
  t.alike(policy.limits(), { maxPeers: 4, maxRequests: 8, maxInFlightBytes: 1024, maxDiskBytes: 2048, deadlineMs: 5000 })
  t.exception(() => createPlaybackResourcePolicy({ maxPeers: -1 }), /maxPeers/)
})

test('playback resource policy keeps legacy defaults while deriving from the participation decision', (t) => {
  const policy = createPlaybackResourcePolicy()
  // Legacy state carries no participation fields: the omitted signals keep
  // their historical reading rather than suspending contribution outright, and
  // the pledge it never mentions stays unmade.
  t.alike(policy.evaluate({}), {
    localPlayback: true,
    peerDiscovery: true,
    upload: true,
    cacheFill: true,
    archiving: false,
  })
  // Unpowered legacy state loses contribution but keeps its own playback.
  t.alike(policy.evaluate({ charging: false }), {
    localPlayback: true,
    peerDiscovery: true,
    upload: false,
    cacheFill: true,
    archiving: false,
  })
  // OS background permission is never assumed, so backgrounded legacy state
  // suspends instead of pretending to seed.
  t.alike(policy.evaluate({ foreground: false }), {
    localPlayback: true,
    peerDiscovery: false,
    upload: false,
    cacheFill: false,
    archiving: false,
  })
  // An explicit archive opt-out is honoured even in the legacy shape.
  t.is(policy.evaluate({ archiveOptIn: false }).archiving, false)
  // An explicit pledge is the only thing that turns archiving on.
  t.is(policy.evaluate({ archiveOptIn: true }).archiving, true)
  // A truthy-but-not-true pledge is not a pledge.
  t.is(policy.evaluate({ archiveOptIn: 'yes' }).archiving, false)
  // Participation fields, when supplied, drive the same decision.
  t.is(policy.evaluate({ mode: 'data-saver', playbackActive: false, msSincePlaybackEnded: 0 }).upload, false)
  t.is(policy.evaluate({ uploadedBytesLast24h: 2 * 1024 * 1024 * 1024 }).upload, false)
})
